/**
 * dsh-mobile-access — 宿主侧。
 *
 * 只做四件事：
 *   1. 在 127.0.0.1:<port> 起一个反向代理，把手机请求转发给 DSH 本机 Web；
 *   2. 设备级认证：一次性短码 → 每设备独立 token → 长期 cookie（400 天滑动续期）；
 *   3. 移动页 boot manifest 裁剪（按模块 id 排除，减首屏体积）；
 *   4. 设置页管理接口（开关 / 端口 / 设备 / 模块），只对回环开放。
 *
 * 隧道（cloudflared / cpolar）不归本插件管：外部进程把公网域名指向 127.0.0.1:<port> 即可。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const name = 'mobile-access'
export const inject = ['webServer']

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STORAGE = path.join(DSH_HOME, 'storages', 'mobile-access.json')
const DEVICE_COOKIE = 'dsh_ma_device'
const ADMIN_PREFIX = '/mobile-access/api'
const PUBLIC_PREFIX = '/mobile-access/pair'
/** 浏览器对 Max-Age 的实际上限是 400 天；每次请求滑动续期，等价于永久。 */
const COOKIE_MAX_AGE = 34560000
const PAIR_CODE_TTL_MS = 5 * 60 * 1000
const PAIR_MAX_ATTEMPTS = 5
const PAIR_LOCK_MS = 10 * 60 * 1000
const UPSTREAM_COOKIE_MARGIN_MS = 60 * 1000

// ── 持久化 ────────────────────────────────────────────────────────────────

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORAGE, 'utf8'))
    return {
      enabled: parsed.enabled !== false,
      port: Number.isSafeInteger(parsed.port) ? parsed.port : 3444,
      publicUrl: typeof parsed.publicUrl === 'string' ? parsed.publicUrl : '',
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      excludedClientModules: Array.isArray(parsed.excludedClientModules) ? parsed.excludedClientModules : [],
    }
  } catch {
    return { enabled: true, port: 3444, publicUrl: '', devices: [], excludedClientModules: [] }
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STORAGE), { recursive: true })
  const tmp = `${STORAGE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, STORAGE)
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function parseCookies(header) {
  const out = Object.create(null)
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

function isLoopback(address) {
  if (typeof address !== 'string') return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  return value === '::1' || value.startsWith('127.')
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function deviceCookie(token, req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted === true
  const parts = [
    `${DEVICE_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * 从 index HTML 解析 boot manifest，返回可裁剪性信息。
 * bootstrap 批次的模块是启动必需项，界面里置灰不可选。
 */
function parseBootEntries(html) {
  const marker = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*/u.exec(html)
  if (marker === null || marker.index === undefined) return []
  const valueStart = marker.index + marker[0].length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) return []
  try {
    const parsed = JSON.parse(html.slice(valueStart, scriptEnd).trim().replace(/;$/u, ''))
    const batches = Array.isArray(parsed.batches) ? parsed.batches : []
    const bootstrap = new Set()
    for (const batch of batches) {
      if (batch?.phase === 'bootstrap' && Array.isArray(batch.entries)) for (const id of batch.entries) bootstrap.add(id)
    }
    return (Array.isArray(parsed.entries) ? parsed.entries : []).map((entry) => ({
      id: entry.id,
      bootstrap: bootstrap.has(entry.id),
      dependencies: Array.isArray(entry.inject) ? entry.inject : [],
    }))
  } catch {
    return []
  }
}

/** 移动端 UA 判定：只在手机上改写 boot manifest，桌面不受影响。 */
function isMobileUa(ua) {
  return typeof ua === 'string' && /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua)
}

// ── 移动页 boot manifest 裁剪 ─────────────────────────────────────────────

/**
 * 过滤 `window.__DSH_BOOT__` 里的 application 条目。
 * 规则：
 *   - bootstrap 批次的条目一律不动（启动必需）；
 *   - 被排除的模块若仍被保留模块依赖，拒绝裁剪并返回原因；
 *   - 同时过滤 entries 与 batches[].entries。
 */
function rewriteBootManifest(html, excludedIds) {
  if (!Array.isArray(excludedIds) || excludedIds.length === 0) return { html, removed: 0 }
  const marker = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*/u.exec(html)
  if (marker === null || marker.index === undefined) return { html, removed: 0, error: 'no_boot_manifest' }
  const valueStart = marker.index + marker[0].length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) return { html, removed: 0, error: 'boot_incomplete' }
  const source = html.slice(valueStart, scriptEnd).trim().replace(/;$/u, '')
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    return { html, removed: 0, error: 'boot_unparsable' }
  }
  if (!Array.isArray(parsed.entries)) return { html, removed: 0, error: 'boot_malformed' }
  const batches = Array.isArray(parsed.batches) ? parsed.batches : []
  const bootstrapIds = new Set()
  for (const batch of batches) {
    if (batch?.phase === 'bootstrap' && Array.isArray(batch.entries)) for (const id of batch.entries) bootstrapIds.add(id)
  }
  const excluded = new Set(excludedIds.filter((id) => typeof id === 'string' && !bootstrapIds.has(id)))
  if (excluded.size === 0) return { html, removed: 0 }
  const byId = new Map(parsed.entries.map((entry) => [entry.id, entry]))
  // 依赖闭包检查：保留的模块不能依赖被排除的模块。
  for (const entry of parsed.entries) {
    if (excluded.has(entry.id)) continue
    const deps = Array.isArray(entry.inject) ? entry.inject : []
    for (const dep of deps) {
      if (excluded.has(dep)) {
        return { html, removed: 0, error: `dependent:${entry.id}->${dep}` }
      }
    }
  }
  let removed = 0
  parsed.entries = parsed.entries.filter((entry) => {
    if (excluded.has(entry.id)) {
      removed += 1
      return false
    }
    return true
  })
  for (const batch of batches) {
    if (!Array.isArray(batch.entries)) continue
    batch.entries = batch.entries.filter((id) => !excluded.has(id))
  }
  parsed.batches = batches.filter((batch) => Array.isArray(batch.entries) ? batch.entries.length > 0 : true)
  const rebuilt = `${html.slice(0, marker.index)}${marker[0]}${JSON.stringify(parsed)}${html.slice(scriptEnd)}`
  return { html: rebuilt, removed }
}

// ── 插件主体 ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  try {
    fs.mkdirSync(path.join(DSH_HOME, 'storages'), { recursive: true })
    fs.writeFileSync(path.join(DSH_HOME, 'storages', 'mobile-access.boot.log'), `${new Date().toISOString()} apply\n`)
  } catch {}
  const config = ctx.config ?? {}
  let state = readState()
  if (typeof config.port === 'number' && Number.isSafeInteger(config.port) && config.port > 1024) state.port = config.port

  let server = null
  let listeningPort = null
  let startError = null
  let upstreamCookie = null
  let upstreamCookieAt = 0
  let upstreamUrl = null
  const pairCodes = new Map()
  const pairFailures = new Map()

  // connection 服务是可选的：缺它时管理接口照常工作，仅代理会返回 upstream_unavailable。
  const connection = () => {
    try {
      return ctx.get?.('connection') ?? ctx.connection ?? null
    } catch {
      return null
    }
  }

  const upstreamOrigin = () => {
    try {
      const url = new URL(upstreamUrl ?? connection()?.authenticatedUrl?.('http://127.0.0.1') ?? '')
      return `${url.protocol}//${url.host}`
    } catch {
      return null
    }
  }

  /** 用 DSH 进程的 launch token 换一份长期 cookie，代理时带上。 */
  async function upstreamCookieHeader() {
    if (upstreamCookie !== null && Date.now() - upstreamCookieAt < COOKIE_MAX_AGE - UPSTREAM_COOKIE_MARGIN_MS) return upstreamCookie
    let authenticated
    try {
      authenticated = connection()?.authenticatedUrl?.(upstreamOrigin() ?? 'http://127.0.0.1')
    } catch {
      return null
    }
    if (typeof authenticated !== 'string') return null
    upstreamUrl = authenticated
    const target = new URL(authenticated)
    const cookie = await new Promise((resolve) => {
      const request = http.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { host: target.host, accept: 'text/html', 'accept-encoding': 'identity' },
        agent: false,
      }, (response) => {
        const setCookie = response.headers['set-cookie']?.[0]
        response.resume()
        response.on('end', () => resolve(typeof setCookie === 'string' ? setCookie.split(';', 1)[0] : null))
      })
      request.on('error', () => resolve(null))
      request.setTimeout(15000, () => {
        request.destroy()
        resolve(null)
      })
      request.end()
    })
    if (cookie === null) return null
    upstreamCookie = cookie
    upstreamCookieAt = Date.now()
    return cookie
  }

  function findDevice(token) {
    if (typeof token !== 'string' || token.length < 32) return null
    return state.devices.find((device) => device.token === token) ?? null
  }

  // ── 代理 ────────────────────────────────────────────────────────────────

  async function authorizedDevice(req) {
    const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
    const device = findDevice(token)
    if (device === null) return null
    device.lastSeenAt = Date.now()
    return device
  }

  function proxyRequest(req, res, device) {
    return upstreamCookieHeader().then((cookie) => {
      const target = new URL(upstreamOrigin())
      const headers = { ...req.headers }
      headers.host = target.host
      headers.origin = target.origin
      if (typeof headers.referer === 'string') headers.referer = `${target.origin}/`
      if (cookie !== null) headers.cookie = cookie
      else delete headers.cookie
      delete headers['x-forwarded-for']
      const upstream = http.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port),
        path: req.url,
        method: req.method,
        headers,
        agent: false,
      }, (response) => {
        const outHeaders = { ...response.headers }
        delete outHeaders['set-cookie']
        res.writeHead(response.statusCode ?? 502, outHeaders)
        response.pipe(res)
      })
      upstream.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unavailable' })
        else res.destroy()
      })
      upstream.setTimeout(120000, () => upstream.destroy())
      req.pipe(upstream)
      res.on('close', () => upstream.destroy())
      // 滑动续期
      if (device !== null) res.setHeader('set-cookie', deviceCookie(device.token, req))
    })
  }

  /** 改写 index：只对移动 UA 生效。 */
  function proxyIndex(req, res, device) {
    return upstreamCookieHeader().then((cookie) => {
      const target = new URL(upstreamOrigin())
      const headers = { ...req.headers, host: target.host, origin: target.origin }
      if (cookie !== null) headers.cookie = cookie
      delete headers['accept-encoding']
      const upstream = http.request({
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port),
        path: req.url,
        method: 'GET',
        headers,
        agent: false,
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8')
          const contentType = String(response.headers['content-type'] ?? '')
          if (contentType.includes('text/html') && isMobileUa(req.headers['user-agent'])) {
            const result = rewriteBootManifest(body, state.excludedClientModules)
            if (result.html !== body) {
              body = result.html
              res.setHeader('x-mobile-access-removed', String(result.removed))
            }
          }
          const outHeaders = { ...response.headers }
          delete outHeaders['content-length']
          delete outHeaders['set-cookie']
          res.writeHead(response.statusCode ?? 200, outHeaders)
          res.end(body)
        })
      })
      upstream.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'upstream_unavailable' })
      })
      upstream.end()
      if (device !== null) res.setHeader('set-cookie', deviceCookie(device.token, req))
    })
  }

  function handleProxy(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return proxyIndex(req, res, res.__mobileDevice ?? null)
    }
    return proxyRequest(req, res, res.__mobileDevice ?? null)
  }

  function handleSocketUpgrade(req, socket, head) {
    const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
    const device = findDevice(token)
    if (device === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    device.lastSeenAt = Date.now()
    const target = new URL(upstreamOrigin())
    const upstream = net.connect(Number(target.port), target.hostname.replace(/^\[|\]$/g, ''), () => {
      const headers = { ...req.headers }
      headers.host = target.host
      headers.origin = target.origin
      headers.cookie = upstreamCookie ?? ''
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else if (value !== undefined) lines.push(`${key}: ${value}`)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  }

  // ── 公网入口：配对页 ─────────────────────────────────────────────────────

  function prunePairState() {
    const now = Date.now()
    for (const [code, record] of pairCodes) if (record.expiresAt <= now) pairCodes.delete(code)
    for (const [key, record] of pairFailures) if (record.resetAt <= now) pairFailures.delete(key)
  }

  function pairFailureKey(req) {
    const forwarded = req.headers['x-forwarded-for']
    return typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : String(req.socket.remoteAddress ?? 'unknown')
  }

  function pairingLocked(req) {
    const record = pairFailures.get(pairFailureKey(req))
    return record !== undefined && record.count >= PAIR_MAX_ATTEMPTS && record.resetAt > Date.now()
  }

  function notePairFailure(req) {
    const key = pairFailureKey(req)
    const record = pairFailures.get(key)
    if (record === undefined || record.resetAt <= Date.now()) pairFailures.set(key, { count: 1, resetAt: Date.now() + PAIR_LOCK_MS })
    else record.count += 1
  }

  function tryPair(req, res, code, deviceName) {
    if (pairingLocked(req)) {
      sendJson(res, 429, { error: 'too_many_attempts' })
      return
    }
    prunePairState()
    const record = pairCodes.get(code)
    if (record === undefined || record.expiresAt <= Date.now() || record.used) {
      notePairFailure(req)
      sendJson(res, 401, { error: 'invalid_or_expired_code' })
      return
    }
    record.used = true
    pairCodes.delete(code)
    const device = {
      id: crypto.randomBytes(8).toString('hex'),
      name: typeof deviceName === 'string' && deviceName.trim() !== '' ? deviceName.trim().slice(0, 40) : '手机',
      token: crypto.randomBytes(32).toString('hex'),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    }
    state.devices.push(device)
    writeState(state)
    res.statusCode = 302
    res.setHeader('set-cookie', deviceCookie(device.token, req))
    res.setHeader('location', '/')
    res.end()
  }

  function pairPage(req, res, code) {
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>移动访问 · 配对</title>
<style>body{font:15px/1.6 system-ui;margin:0;padding:32px 20px;background:#0f1115;color:#e8ebf0}main{max-width:420px;margin:0 auto}
input,button{width:100%;box-sizing:border-box;font:inherit;padding:12px;border-radius:10px;border:1px solid #2a2f3a;background:#171b23;color:inherit}
button{margin-top:12px;background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600}p.hint{color:#8b93a1;font-size:13px}</style>
<main><h2>移动访问配对</h2><p class="hint">输入电脑端显示的 6 位配对码。配对成功后这台设备会长期有效。</p>
<input id="code" inputmode="numeric" maxlength="6" placeholder="6 位配对码" value="${code ?? ''}">
<input id="name" maxlength="40" placeholder="设备名称（可留空）">
<button id="go">配对</button><p class="hint" id="out"></p></main>
<script>document.getElementById('go').onclick=async()=>{const out=document.getElementById('out');
out.textContent='配对中…';const r=await fetch('/mobile-access/pair',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({code:document.getElementById('code').value.trim(),name:document.getElementById('name').value.trim()})});
if(!r.ok){const j=await r.json().catch(()=>({error:'failed'}));out.textContent=j.error==='invalid_or_expired_code'?'配对码无效或已过期':('失败：'+j.error);return}
location.href='/'}</script>`
    res.statusCode = 200
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(html)
  }

  // ── 管理接口（只对回环开放） ────────────────────────────────────────────

  function adminAllowed(req) {
    if (!isLoopback(req.socket.remoteAddress)) return false
    const origin = req.headers.origin
    if (typeof origin !== 'string') return true
    try {
      const url = new URL(origin)
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
    } catch {
      return false
    }
  }

  async function adminHandler(req, res) {
    if (!adminAllowed(req)) return sendJson(res, 403, { error: 'forbidden' })
    const url = new URL(req.url, 'http://localhost')
    const method = (req.method || 'GET').toUpperCase()
    const route = url.pathname.slice(ADMIN_PREFIX.length)
    try {
      if (route === '/state' && method === 'GET') {
        return sendJson(res, 200, {
          enabled: state.enabled,
          port: state.port,
          publicUrl: state.publicUrl,
          listening: listeningPort,
          error: startError,
          origin: upstreamOrigin(),
          devices: state.devices.map(({ token, ...rest }) => rest),
          excludedClientModules: state.excludedClientModules,
        })
      }
      if (route === '/enable' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        state.enabled = body.enabled === true
        writeState(state)
        await restart()
        return sendJson(res, 200, { enabled: state.enabled, listening: listeningPort, error: startError })
      }
      if (route === '/port' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const port = Number(body.port)
        if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) return sendJson(res, 400, { error: 'invalid_port' })
        state.port = port
        writeState(state)
        await restart()
        return sendJson(res, 200, { port: state.port, listening: listeningPort, error: startError })
      }
      if (route === '/pair/start' && method === 'POST') {
        if (!state.enabled || listeningPort === null) return sendJson(res, 409, { error: 'not_running' })
        prunePairState()
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
        const record = { code, expiresAt: Date.now() + PAIR_CODE_TTL_MS, used: false }
        pairCodes.set(code, record)
        return sendJson(res, 200, { code, expiresAt: record.expiresAt, path: PUBLIC_PREFIX })
      }
      if (route === '/devices/revoke' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const before = state.devices.length
        state.devices = state.devices.filter((device) => device.id !== body.id)
        writeState(state)
        return sendJson(res, 200, { removed: before - state.devices.length })
      }
      if (route === '/public-url' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const value = typeof body.publicUrl === 'string' ? body.publicUrl.trim().replace(/\/+$/u, '') : ''
        if (value !== '' && !/^https?:\/\/[^\s]+$/u.test(value)) return sendJson(res, 400, { error: 'invalid_url' })
        state.publicUrl = value
        writeState(state)
        return sendJson(res, 200, { publicUrl: state.publicUrl })
      }
      if (route === '/modules/list' && method === 'GET') {
        const cookie = await upstreamCookieHeader()
        const target = new URL(upstreamOrigin())
        const html = await new Promise((resolve) => {
          const request = http.request({
            hostname: target.hostname.replace(/^\[|\]$/g, ''),
            port: Number(target.port),
            path: '/',
            method: 'GET',
            headers: {
              host: target.host,
              accept: 'text/html',
              'accept-encoding': 'identity',
              ...(cookie === null ? {} : { cookie }),
            },
            agent: false,
          }, (response) => {
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          })
          request.on('error', () => resolve(''))
          request.setTimeout(20000, () => {
            request.destroy()
            resolve('')
          })
          request.end()
        })
        const parsed = parseBootEntries(html)
        return sendJson(res, 200, { excluded: state.excludedClientModules, entries: parsed })
      }
      if (route === '/modules' && method === 'GET') {
        return sendJson(res, 200, { excluded: state.excludedClientModules })
      }
      if (route === '/modules' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        const excluded = Array.isArray(body.excluded) ? body.excluded.filter((id) => typeof id === 'string') : []
        state.excludedClientModules = [...new Set(excluded)]
        writeState(state)
        return sendJson(res, 200, { excluded: state.excludedClientModules })
      }
      return sendJson(res, 404, { error: 'not_found' })
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message || error) })
    }
  }

  // ── 代理服务生命周期 ────────────────────────────────────────────────────

  async function restart() {
    if (server !== null) {
      await new Promise((resolve) => server.close(() => resolve()))
      server = null
    }
    listeningPort = null
    startError = null
    if (!state.enabled) return
    await new Promise((resolve) => {
      const next = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname === '/mobile-access/pair' && req.method === 'GET') return pairPage(req, res, url.searchParams.get('code'))
        if (url.pathname === '/mobile-access/pair' && req.method === 'POST') {
          return readBody(req).then((text) => {
            let body = {}
            try {
              body = JSON.parse(text || '{}')
            } catch {}
            tryPair(req, res, String(body.code ?? ''), body.name)
          })
        }
        authorizedDevice(req).then((device) => {
          if (device === null) {
            res.statusCode = 401
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.end('<meta charset="utf-8"><p>未配对。<a href="/mobile-access/pair">点此配对</a></p>')
            return
          }
          res.__mobileDevice = device
          handleProxy(req, res).catch(() => {
            if (!res.headersSent) sendJson(res, 502, { error: 'proxy_failed' })
          })
        }).catch(() => sendJson(res, 500, { error: 'auth_failed' }))
      })
      next.on('upgrade', handleSocketUpgrade)
      next.once('error', (error) => {
        startError = error.code === 'EADDRINUSE' ? 'port_in_use' : String(error.code ?? error.message)
        resolve()
      })
      next.listen(state.port, '127.0.0.1', () => {
        listeningPort = next.address().port
        resolve()
      })
      server = next
    })
  }

  // 管理接口挂在 DSH 自己的 WebServer 上，设置页直接调，复用 DSH 的认证与回环限制。
  const unregister = ctx.webServer.register({ kind: 'prefix', path: ADMIN_PREFIX, handler: adminHandler })

  restart().catch((error) => {
    startError = String(error?.message ?? error)
  })

  ctx.effect(() => () => {
    unregister?.()
    if (server !== null) server.close()
    server = null
  })
}
