# Changelog

## 0.2.0 (2026-09-05)

- 分流模式 allowlist：状态文件与设置新增 `mode`（`all`/`allowlist`）与 `allowProxy`；
  决策收敛到 `shouldProxy` 纯函数，`noProxy` 优先级最高（命中即直连）。
  旧状态文件无新字段时等同 `all` 模式，向后兼容
- `POST /vpn/test` 连通性测试：先 TCP 探测代理端口（`proxy-unreachable`），
  再经真实 dispatcher 路径探测出口 IP（ipify → ifconfig.me 回退），
  返回 `{ok, exitIp, latencyMs, via: proxy|direct, proxy, mode}`
- 开启预检：开启（路由/热键）前探测代理端口，不通不阻断，响应带 `warning`、
  系统通知注明「代理端口无响应」
- 设置卡片运行态回显：折叠态标题行动态显示 当前直连/经代理（手动/自动探测）与模式，
  数据来自 `GET /vpn`（≥5 秒节流）
- 设置卡片与独立开关页新增「测试连通性」按钮及结果行
- 安全：POST 路由 CSRF fence（跨源 Origin / `Sec-Fetch-Site: cross-site` 拒绝）；
  所有响应移除 CORS 头（全同源设计）
- 传输：统一裸 `ProxyAgent`（http(s):// 与 socks5:// 代理实测全通过，SSE 兼容；
  弃用 socks5 会 ECONNRESET 的 `EnvHttpProxyAgent` 路径）
- 系统代理自动探测：Windows 注册表 `ProxyEnable`/`ProxyServer`，30 秒缓存，
  归一化 `host:port` / `http=x;https=y` / `socks=y` 为完整 URL
- 回退端点重写：异步 EADDRINUSE 重试链（43199..43206）+ 常驻 error 监听，
  修复端口被占时无监听 error 事件导致主进程崩溃的隐患
- `noProxy` 匹配加固：精确 / 前导点后缀 / `*` / IPv6 括号 / 单端口剥离，含单测
- 单测固化：`lib/pure.js` 纯函数层 + `tests/unit.mjs`（26 用例），
  不再依赖从源码文本抓函数体的临时手段
- 一键回归：`node verify.mjs [origin]`（覆盖 7 项，退出码即结果）
- 全局热键默认关闭（留空 = 不启用）

## 0.1.0 (2026-09-04)

- 首个可用版本：按请求即时切换「直连 / 本地 VPN 代理」，无需重启
- 四个开关面：GUI 右下角悬浮按钮、全局热键、浏览器独立页 `<GUI>/vpn/ui`、
  同源控制端点（`GET /vpn`、`POST /vpn/on|off|toggle`、`POST /vpn/proxy`）+ agent 对话
- 状态持久化 `~/.dsh/vpn-proxy.json`（1.2 秒 TTL 热读取）
- 设置卡片（`settings.plugin.item` slot，namespace `vpn-toggle`）与 agent 使用指引
- webServer 路由不可用时回退独立回环端点（`~/.dsh/vpn-proxy.port`）
