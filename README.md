# dsh-mobile-access · 移动访问

给 DSH 一个轻量的手机入口：本机反向代理 + 设备级配对 + 移动页模块裁剪。隧道（cloudflared / cpolar / frp）不由本插件管理，外部进程把公网域名指到 `127.0.0.1:<端口>` 即可。

## 能力

| 能力 | 说明 |
|---|---|
| 反向代理 | HTTP + WebSocket 全站转发到 DSH 本机 Web，改写 Host/Origin 通过 DSH 的信任栅栏 |
| 设备配对 | 一次性 6 位码（5 分钟有效，错 5 次锁 10 分钟）→ 每设备独立 token → 长期 cookie（400 天滑动续期） |
| 多设备 | 设备列表可单独撤销，撤销即失效；丢一台不影响其他 |
| 模块裁剪 | 只对手机 UA 改写 boot manifest，可按模块 id 排除，减首屏体积；电脑端不受影响 |
| 管理 | 设置页「移动访问」：开关、端口、公网地址、配对、设备、模块 |

## 配置

```yaml
- id: mobile-access
  name: '@local/dsh-mobile-access'
  config:
    port: 3444      # 监听端口，默认 3444
```

状态文件：`~/.dsh/storages/mobile-access.json`（设备 token 只存这里，接口不回传）。

## 用法

1. 设置 → 移动访问 → 打开开关，确认监听端口。
2. 填公网地址（例如你的 cloudflared 命名隧道域名）。
3. 点「生成配对码」，手机打开 `https://<域名>/mobile-access/pair?code=<配对码>`。
4. 配对成功后手机长期有效；需要时在设备列表撤销。

## 与 dsh-mobile 的关系

本插件是它的精简替代：保留代理、配对、模块裁剪，去掉隧道管理、自建 CA、移动端 UI 重构、扩展系统。两者不要同时启用（都占端口、都改写上游认证）。

## 测试

```powershell
npm test        # 宿主侧 10 项断言
```
