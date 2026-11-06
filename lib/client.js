window.__ModuleLoader__.load({
  id: '@local/dsh-mobile-access',
  factory: (require) => {
    const react = require('react')
    const createPortal = require('react-dom').createPortal
/**
 * DSH 客户端 UI kit v3（2026-11-05，控件字号 14px）—— 整段粘进 `lib/client.js` 的 factory 里（`const react = require('react')` 之后）。
 *
 * 为什么是"粘贴"而不是 import：插件的浏览器 bundle 由宿主按单文件 `/plugins/<id>/client.js`
 * 提供，没有打包器，`import './ui.js'` 在浏览器里跑不起来。所以公用组件以「可粘贴的片段」分发。
 *
 *   const ui = createUi(react, require('react-dom').createPortal)
 *   const { h, Card, StatusDot, Switch, TextField, Button, Section, SettingsCard, SettingRow,
 *           createStore, useStore, usePoll, placeNear, HoverCard, T, TYPE } = ui
 *
 * 约定：所有颜色/圆角走 DSH token；所有字号走 TYPE 里的档位（小字行高固定 13px，
 * 否则 baseline 行盒会被撑高，同排卡片高度就会差 3px）。
 */
function createUi(react, createPortal) {
  const h = react.createElement
  const { useState, useEffect, useCallback, useRef } = react

  /* ---------- token 与字号 ---------- */
  const T = {
    text1: 'var(--dsw-alias-label-primary)',
    text2: 'var(--dsw-alias-label-secondary)',
    text3: 'var(--dsw-alias-label-tertiary, #8b929c)',
    line: 'var(--dsw-alias-border-l3)',
    cardFill: 'var(--dsw-alias-settings-card-fill, #2c2c2e)',
    cardStroke: 'var(--dsw-alias-settings-card-stroke, #ffffff26)',
    inputFill: 'var(--dsw-alias-bg-layer-1, #1b1b1c)',
    accent: 'var(--dsw-alias-button-primary-fill, #f9fafb)',
    accentText: 'var(--dsw-alias-label-primary-foreground, #0f1115)',
    radiusMd: 'var(--dsw-radius-md, 12px)',
    radiusXl: 'var(--dsw-radius-xl, 20px)',
  }
  const CARD_BG = 'color-mix(in srgb, currentColor 6%, transparent)'
  const TYPE = {
    h1: { fontSize: 18, fontWeight: 600, lineHeight: '26px', color: T.text1 },
    h2: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1 },
    body: { fontSize: 14, lineHeight: '22px', color: T.text1 },
    secondary: { fontSize: 14, lineHeight: '22px', color: T.text2 },
    small: { fontSize: 12, lineHeight: '18px', color: T.text2 },
    micro: { fontSize: 11, lineHeight: '14px', color: T.text2 },
    num: { fontSize: 15, fontWeight: 600, lineHeight: '20px', color: T.text1, fontVariantNumeric: 'tabular-nums' },
    ellipsis: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }

  /* ---------- 纯函数 ---------- */
  const clamp = (value, min, max) => Math.max(min, Math.min(value, max))

  /** 浮层定位：优先右侧，放不下翻左；上下夹在视口内。pure，便于脱离 DOM 测试。 */
  function placeNear(rect, options = {}) {
    const width = options.width ?? 248
    const height = options.height ?? 120
    const gap = options.gap ?? 8
    const vw = options.viewport?.width ?? (typeof window === 'undefined' ? 1280 : window.innerWidth)
    const vh = options.viewport?.height ?? (typeof window === 'undefined' ? 800 : window.innerHeight)
    let side = 'right'
    let left = rect.right + gap
    if (left + width > vw - gap) {
      side = 'left'
      left = rect.left - gap - width
    }
    return {
      side,
      left: clamp(left, gap, Math.max(gap, vw - width - gap)),
      top: clamp(rect.top, gap, Math.max(gap, vh - height - gap)),
    }
  }

  const formatBytes = (bytes) => {
    const n = Number(bytes) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  /* ---------- 本地状态：模块级 store + hook ---------- */
  /** 按设备持久化；只存差异值也安全（读取时与默认值合并）。 */
  function createStore(key, defaults = {}) {
    const read = () => {
      try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(key) || '{}') }
      } catch {
        return { ...defaults }
      }
    }
    const store = {
      key,
      value: read(),
      listeners: new Set(),
      set(next) {
        store.value = typeof next === 'function' ? next(store.value) : next
        try { localStorage.setItem(key, JSON.stringify(store.value)) } catch {}
        for (const listener of store.listeners) listener(store.value)
      },
      patch(part) { store.set({ ...store.value, ...part }) },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => { store.listeners.delete(listener) }
      },
    }
    return store
  }

  function useStore(store) {
    const [value, setValue] = useState(store.value)
    useEffect(() => store.subscribe(setValue), [store])
    return value
  }

  /** 轮询 + 失败保留上一帧（不要闪成空）。返回 [data, error, refresh]。 */
  function usePoll(task, intervalMs, deps = []) {
    const [state, setState] = useState({ data: null, error: false })
    const run = useCallback(async () => {
      try {
        const data = await task()
        setState({ data, error: false })
      } catch {
        setState((prev) => ({ data: prev.data, error: true }))
      }
    }, deps)
    useEffect(() => {
      run()
      const timer = setInterval(run, intervalMs)
      return () => clearInterval(timer)
    }, [run, intervalMs])
    return [state.data, state.error, run]
  }

  /* ---------- 侧栏卡片 ---------- */
  const StatusDot = ({ color, size = 6, offset = 1.5 }) => h('span', {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: color || T.text3,
      flex: '0 0 auto',
      alignSelf: 'center',
      transform: `translateY(${offset}px)`,
    },
  })

  /** 侧栏卡片：一行，圆点 + 名称 + 右侧数字。左右两组用同一 baseline。 */
  const Card = ({ children, style, ...rest }) => h('div', {
    ...rest,
    style: {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
      padding: '2px 12px 5px',
      borderRadius: T.radiusMd,
      background: CARD_BG,
      minWidth: 0,
      overflow: 'hidden',
      ...style,
    },
  }, children)

  /** 侧栏卡片容器：竖排 + 3px 间距 + 左右 2px 内缩（与 newSession 对齐）。 */
  const CardStack = ({ children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 3, padding: '0 2px 2px', minWidth: 0 },
  }, children)

  const CardName = ({ children }) => h('span', { style: { ...TYPE.h2, fontSize: 12, flex: '1 1 auto', ...TYPE.ellipsis } }, children)
  const CardValue = ({ children }) => h('span', {
    style: { display: 'flex', alignItems: 'baseline', gap: 4, flex: '0 0 auto', ...TYPE.num },
  }, children)

  /* ---------- 设置页 ---------- */
  const Section = ({ title, description, children }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640, minWidth: 0 },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
    h('span', { style: TYPE.h1 }, title),
    description ? h('span', { style: TYPE.secondary }, description) : null),
  children)

  /** 设置卡片：官方那种 20px 圆角、深色填充、细描边。 */
  const SettingsCard = ({ children, style }) => h('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
      padding: '14px 16px',
      borderRadius: T.radiusXl,
      border: `.5px solid ${T.cardStroke}`,
      background: T.cardFill,
      minWidth: 0,
      ...style,
    },
  }, children)

  /** 左标签 + 右控件的一行。 */
  const SettingRow = ({ label, hint, children }) => h('div', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
    h('span', { style: { fontSize: 14, lineHeight: '20px', color: T.text1 } }, label),
    hint ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: T.text2 } }, hint) : null),
  children)

  /** 药丸开关：36×20，白色底 + 深色旋钮，与官方设置页一致。 */
  const Switch = ({ checked, onChange, title, disabled = false }) => h('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    disabled,
    onClick: onChange,
    title,
    style: {
      boxSizing: 'border-box',
      position: 'relative',
      flex: '0 0 auto',
      width: 36,
      height: 20,
      padding: 2,
      border: 0,
      borderRadius: 999,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: checked ? 'flex-end' : 'flex-start',
      transition: 'background-color .12s ease',
      backgroundColor: checked ? T.accent : 'var(--dsw-alias-border-l3, #4a4a4d)',
    },
  }, h('span', {
    style: {
      display: 'block',
      width: 16,
      height: 16,
      borderRadius: '50%',
      backgroundColor: checked ? T.accentText : 'var(--dsw-alias-label-primary, #f9fafb)',
      transition: 'background-color .12s ease',
    },
  }))

  const Button = ({ children, onClick, variant = 'primary', disabled = false, type = 'button' }) => h('button', {
    type,
    onClick,
    disabled,
    style: {
      boxSizing: 'border-box',
      height: 36,
      padding: '0 16px',
      borderRadius: T.radiusMd,
      whiteSpace: 'nowrap',
      flex: 'none',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      fontSize: 14,
      lineHeight: '22px',
      fontWeight: 500,
      ...(variant === 'primary'
        ? { border: 'none', background: T.accent, color: T.accentText }
        : { border: `.5px solid ${T.cardStroke}`, background: 'transparent', color: T.text1 }),
    },
  }, children)

  /** 文本输入：44px 高、12px 圆角，与官方设置字段一致。 */
  /** 输入框：与 Select / Button 同高（36px），支持单位后缀、禁用、错误态、回车提交。 */
  const Input = ({
    value,
    onChange,
    placeholder = '',
    type = 'text',
    width = 220,
    unit,
    disabled = false,
    invalid = false,
    min,
    max,
    step,
    autoFocus = false,
    onEnter,
  }) => {
    const [focused, setFocused] = useState(false)
    const border = invalid ? '#ff6262' : focused ? T.text3 : T.cardStroke
    return h('div', {
      style: {
        width,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 36,
        boxSizing: 'border-box',
        padding: '0 10px',
        borderRadius: T.radiusMd,
        border: `.5px solid ${border}`,
        background: T.inputFill,
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s ease',
      },
    },
      h('input', {
        type,
        value: value ?? '',
        placeholder,
        disabled,
        min,
        max,
        step,
        autoFocus,
        onChange: (event) => onChange?.(event.target.value),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onKeyDown: (event) => { if (event.key === 'Enter') onEnter?.(event.target.value) },
        style: {
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 'none',
          background: 'transparent',
          color: T.text1,
          fontSize: 14,
          lineHeight: '20px',
          padding: 0,
        },
      }),
      unit ? h('span', { style: { ...TYPE.micro, flex: 'none' } }, unit) : null,
    )
  }

  /** 带标签/说明的输入框（Input 的组合封装，保留旧 API）。 */
  const TextField = ({ label, hint, width = '100%', ...props }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  },
  label ? h('span', { style: { fontSize: 12, lineHeight: '16px', color: T.text2 } }, label) : null,
  h(Input, { width, ...props }),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

  /* ---------- 浮层 ---------- */
  /** 悬停详情卡：portal 到 body，先按估算高度定位，挂载后按实测高度夹取。 */
  function HoverCard({ rect, width = 248, estimated = 120, children }) {
    const ref = useRef(null)
    const [placement, setPlacement] = useState(() => placeNear(rect, { width, height: estimated }))
    useEffect(() => {
      const node = ref.current
      if (!node) return
      const measured = node.getBoundingClientRect().height || estimated
      setPlacement(placeNear(rect, { width, height: measured }))
    }, [rect, width, estimated])
    const node = h('div', {
      ref,
      style: {
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        width,
        zIndex: 2147400000,
        background: T.cardFill,
        border: `.5px solid ${T.cardStroke}`,
        borderRadius: T.radiusXl,
        padding: '12px 14px',
        boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        color: T.text1,
      },
    }, children)
    return createPortal && typeof document !== 'undefined' ? createPortal(node, document.body) : node
  }

  /** 详情卡里的一行：左标题、右值。 */
  const InfoRow = ({ label, value }) => h('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, minWidth: 0 },
  },
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text2 } }, label),
  h('span', { style: { fontSize: 12, lineHeight: '18px', color: T.text1, fontVariantNumeric: 'tabular-nums' } }, value))

  /* ---------- 通用控件 ---------- */

  /** 下拉：触发器与设置输入框同高；浮层在触发器内绝对定位（不 portal），宽度与触发器一致。 */
  function Select({ value, options = [], onChange, width = 220, placeholder = '', disabled = false }) {
    const [open, setOpen] = useState(false)
    const [hover, setHover] = useState(-1)
    const ref = useRef(null)
    const current = options.find((option) => option.value === value)

    useEffect(() => {
      if (!open) return undefined
      const onDown = (event) => { if (ref.current && ref.current.contains(event.target)) return; setOpen(false) }
      const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    const trigger = {
      boxSizing: 'border-box',
      width: '100%',
      height: 36,
      padding: '0 8px 0 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      borderRadius: T.radiusMd,
      border: `.5px solid ${T.cardStroke}`,
      background: T.inputFill,
      color: T.text1,
      fontSize: 14,
      lineHeight: '20px',
      cursor: disabled ? 'default' : 'pointer',
      textAlign: 'left',
      opacity: disabled ? 0.55 : 1,
    }

    return h('div', { ref, style: { position: 'relative', width, minWidth: 0 } },
      h('button', {
        type: 'button',
        disabled,
        onClick: () => { if (disabled) return; setHover(-1); setOpen((previous) => !previous) },
        style: trigger,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
      },
        h('span', { style: { ...TYPE.ellipsis, flex: 1, textAlign: 'left', color: current ? T.text1 : T.text2 } }, current ? current.label : placeholder),
        h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text2,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          style: { flex: 'none', transition: 'transform .12s ease', transform: open ? 'rotate(180deg)' : 'none' },
        }, h('path', { d: 'M6 9l6 6 6-6' })),
      ),
      open && !disabled ? h('div', {
        role: 'listbox',
        style: {
          boxSizing: 'border-box',
          position: 'absolute',
          left: 0,
          top: 'calc(100% + 6px)',
          width,
          maxHeight: 320,
          overflowY: 'auto',
          padding: 4,
          zIndex: 40,
          background: T.cardFill,
          border: `.5px solid ${T.cardStroke}`,
          borderRadius: T.radiusMd,
          boxShadow: '0 12px 32px rgba(0, 0, 0, .45)',
        },
      }, options.map((option, index) => h('div', {
        key: option.value,
        role: 'option',
        'aria-selected': option.value === value,
        onMouseEnter: () => setHover(index),
        onMouseLeave: () => setHover(-1),
        onClick: () => { onChange?.(option.value); setOpen(false) },
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          height: 32,
          padding: '0 10px',
          borderRadius: 8,
          fontSize: 14,
          lineHeight: '20px',
          color: T.text1,
          cursor: 'pointer',
          background: hover === index
            ? 'color-mix(in srgb, currentColor 8%, transparent)'
            : option.value === value ? 'color-mix(in srgb, currentColor 4%, transparent)' : 'transparent',
        },
      },
        h('span', { style: { ...TYPE.ellipsis } }, option.label),
        option.value === value ? h('svg', {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: T.text1,
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, h('path', { d: 'M5 13l4 4L19 7' })) : null,
      ))) : null,
    )
  }

  /** 分段切换（2~4 项）：选中项白底黑字，未选中透明，整组与输入框同高。 */
  function Segmented({ value, options = [], onChange }) {
    return h('div', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        height: 36,
        padding: 2,
        boxSizing: 'border-box',
        borderRadius: T.radiusMd,
        border: `.5px solid ${T.cardStroke}`,
        background: T.inputFill,
      },
    }, options.map((option) => {
      const active = option.value === value
      return h('button', {
        key: option.value,
        type: 'button',
        onClick: () => onChange?.(option.value),
        style: {
          height: 30,
          padding: '0 12px',
          border: 'none',
          borderRadius: 9,
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: '20px',
          background: active ? T.accent : 'transparent',
          color: active ? T.accentText : T.text2,
          transition: 'background-color .12s ease, color .12s ease',
        },
      }, option.label)
    }))
  }

  /** 图标按钮：28×28，hover 有底色；用于行内删除、刷新等。 */
  const IconButton = ({ label, onClick, disabled = false, children }) => h('button', {
    type: 'button',
    title: label,
    'aria-label': label,
    onClick,
    disabled,
    style: {
      width: 28,
      height: 28,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: 0,
      borderRadius: 8,
      background: 'transparent',
      color: disabled ? T.text3 : T.text2,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    },
  }, children)

  /** 指标块：上标签、下数值，用于面板顶部摘要。 */
  const StatTile = ({ label, value, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 },
  },
  h('span', { style: TYPE.micro }, label),
  h('span', { style: { ...TYPE.num, fontSize: 17, lineHeight: '22px' } }, value),
  hint ? h('span', { style: TYPE.micro }, hint) : null)

  /** 空态：居中提示，不占空容器。 */
  const EmptyState = ({ title, hint }) => h('div', {
    style: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '24px 12px', textAlign: 'center' },
  },
  h('span', { style: TYPE.body }, title),
  hint ? h('span', { style: TYPE.small }, hint) : null)

  return {
    h, T, TYPE, CARD_BG,
    clamp, placeNear, formatBytes,
    createStore, useStore, usePoll,
    Card, CardStack, CardName, CardValue, StatusDot,
    Section, SettingsCard, SettingRow, Switch, Button, Input, TextField,
    Select, Segmented, IconButton, StatTile, EmptyState,
    HoverCard, InfoRow,
  }
}

    const ui = createUi(react, createPortal)
    const { h, Section, SettingsCard, SettingRow, Switch, Button, TextField, T, TYPE } = ui
    const { useState, useEffect, useCallback } = react
    /* ── 移动访问 ────────────────────────────────────────────────────────── */

    const API = '/mobile-access/api'

    async function call(path, init) {
      const response = await fetch(`${API}${path}`, {
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    function fmtTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function Settings() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [port, setPort] = useState('')
      const [publicUrl, setPublicUrl] = useState('')
      const [pair, setPair] = useState(null)
      const [modules, setModules] = useState(null)
      const [excluded, setExcluded] = useState([])
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const next = await call('/state')
          setState(next)
          setPort(String(next.port))
          setPublicUrl(next.publicUrl || '')
          setExcluded(next.excludedClientModules || [])
          setError('')
        } catch (err) {
          setError(String(err.message || err))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const run = async (task) => {
        setBusy(true)
        try {
          await task()
          setError('')
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      const toggle = (enabled) => run(async () => {
        await call('/enable', { method: 'POST', body: JSON.stringify({ enabled }) })
        await load()
      })

      const savePort = () => run(async () => {
        await call('/port', { method: 'POST', body: JSON.stringify({ port: Number(port) }) })
        await load()
      })

      const savePublicUrl = () => run(async () => {
        await call('/public-url', { method: 'POST', body: JSON.stringify({ publicUrl }) })
        await load()
      })

      const startPair = () => run(async () => {
        const result = await call('/pair/start', { method: 'POST', body: '{}' })
        setPair({ ...result, url: `${state?.publicUrl || ''}${result.path}?code=${result.code}` })
      })

      const revoke = (id) => run(async () => {
        await call('/devices/revoke', { method: 'POST', body: JSON.stringify({ id }) })
        await load()
      })

      const loadModules = () => run(async () => {
        const result = await call('/modules/list')
        setModules(result.entries || [])
        setExcluded(result.excluded || [])
      })

      const saveModules = () => run(async () => {
        await call('/modules', { method: 'POST', body: JSON.stringify({ excluded }) })
        await load()
      })

      const leanPreset = () => {
        if (!modules) return
        const drop = modules
          .filter((entry) => !entry.bootstrap && /sidebar|settings|preview|browser|terminal|open-in-app|file-actions|context-menu|shortcuts/i.test(entry.id))
          .map((entry) => entry.id)
        setExcluded([...new Set([...excluded, ...drop])])
      }

      if (state === null) {
        return h(Section, { title: '移动访问', description: error || '加载中…' })
      }

      const running = state.listening !== null

      return h(Section, {
        title: '移动访问',
        description: running
          ? `运行中 · 127.0.0.1:${state.listening} · 公网隧道指向这个端口`
          : (state.error ? `未运行 · ${state.error}` : '未运行'),
      },
        h(SettingsCard, null,
          h(SettingRow, { label: '启用', hint: '关闭后手机立即无法访问，设备记录保留' },
            h(Switch, { checked: state.enabled, onChange: toggle, disabled: busy })),

          h(SettingRow, { label: '监听端口', hint: 'cloudflared / cpolar 的公网入口指向它' },
            h(TextField, {
              value: port,
              width: 120,
              inputMode: 'numeric',
              onChange: (event) => setPort(event.target.value),
            }),
            h(Button, { onClick: savePort, disabled: busy, variant: 'secondary' }, '保存')),

          h(SettingRow, { label: '公网地址', hint: '用于拼配对链接，例如你的 cloudflared 域名' },
            h(TextField, {
              value: publicUrl,
              width: 280,
              placeholder: 'https://',
              onChange: (event) => setPublicUrl(event.target.value),
            }),
            h(Button, { onClick: savePublicUrl, disabled: busy, variant: 'secondary' }, '保存'))
        ),

        h(SettingsCard, null,
          h(SettingRow, {
            label: '添加设备',
            hint: pair ? '把配对码输入手机，或在手机上打开配对链接' : '一次性配对码，5 分钟内有效，错 5 次锁 10 分钟',
          },
            h(Button, { onClick: startPair, disabled: busy || !running }, pair ? '重新生成' : '生成配对码')),

          pair !== null && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0 12px' } },
            h('div', { style: { ...TYPE.h1, letterSpacing: 8 } }, pair.code),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('code', { style: { ...TYPE.small, ...TYPE.ellipsis, flex: 1 } }, pair.url || pair.path),
              h(Button, {
                variant: 'secondary',
                onClick: () => navigator.clipboard?.writeText(pair.url || `${location.origin}${pair.path}?code=${pair.code}`),
              }, '复制链接')))
        ),

        h(SettingsCard, null,
          h(SettingRow, { label: `已配对设备（${state.devices.length}）`, hint: '撤销后该设备立即失效，不影响其他设备' }),
          state.devices.length === 0
            ? h('div', { style: { ...TYPE.small, padding: '4px 0 12px' } }, '还没有设备，先生成配对码。')
            : state.devices.map((device) => h('div', {
              key: device.id,
              style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid ' + T.line },
            },
              h('span', { style: { ...TYPE.body, flex: 1, minWidth: 0 } }, device.name),
              h('span', { style: { ...TYPE.small, flex: 'none' } }, `最后在线 ${fmtTime(device.lastSeenAt)}`),
              h(Button, { variant: 'secondary', onClick: () => revoke(device.id), disabled: busy }, '撤销')))
        ),

        h(SettingsCard, null,
          h(SettingRow, {
            label: '移动页模块',
            hint: modules ? `已勾掉 ${excluded.length} 个；只影响手机页面，电脑端不变` : '加载后可按模块裁剪，减少手机首屏体积',
          },
            h(Button, { onClick: loadModules, disabled: busy, variant: 'secondary' }, modules ? '刷新' : '加载列表'),
            modules && h(Button, { onClick: leanPreset, disabled: busy, variant: 'secondary' }, '精简模式'),
            modules && h(Button, { onClick: saveModules, disabled: busy }, '保存')),

          modules && h('div', { style: { maxHeight: 260, overflowY: 'auto', padding: '4px 0 12px' } },
            modules.filter((entry) => !entry.bootstrap).map((entry) => h('label', {
              key: entry.id,
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' },
            },
              h('input', {
                type: 'checkbox',
                checked: excluded.includes(entry.id),
                onChange: (event) => setExcluded(event.target.checked ? [...excluded, entry.id] : excluded.filter((id) => id !== entry.id)),
              }),
              h('span', { style: { ...TYPE.small, ...TYPE.ellipsis } }, entry.id))))
        ),

        error !== '' && h('div', { style: { ...TYPE.small, color: 'var(--dsw-alias-state-error-primary)' } }, error)
      )
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ id: 'mobile-access', name: 'settings.section', order: 200, label: () => '移动访问' }, Settings))
    }

    return { inject, apply }
  },
})
