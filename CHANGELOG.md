# Changelog

## 0.1.0 (2026-09-05)

首个公开发布版本。DSH 主进程所有走全局 `fetch` 的流量（模型 API / Files API /
web 抓取）在「直连」与「本地 VPN 代理」之间**按请求即时切换**，无需重启。

- 四个开关面：GUI 右下角悬浮按钮、全局热键（Electron accelerator，留空 = 不启用）、
  浏览器独立页 `<GUI>/vpn/ui`、同源控制端点 + agent 对话（systemPrompt 指引）
- 控制端点：`GET /vpn`（状态）、`POST /vpn/on|off|toggle`、`POST /vpn/proxy`
  （改 proxy / noProxy / mode / allowProxy）、`POST /vpn/test`（连通性测试）
- 分流模式 allowlist：状态字段 `mode`（`all` / `allowlist`）与 `allowProxy`，
  决策收敛到 `shouldProxy` 纯函数；`noProxy` 优先级最高（命中即直连）；
  旧状态文件无新字段时等同 `all` 模式
- `POST /vpn/test` 连通性测试：先 TCP 探测代理端口（`proxy-unreachable`），
  再经真实 dispatcher 路径探测出口 IP（ipify → ifconfig.me 回退），
  返回 `{ok, exitIp, latencyMs, via: proxy|direct, proxy, mode}`
- 开启预检：开启（路由/热键）前探测代理端口，不通不阻断，响应带 `warning`、
  系统通知注明「代理端口无响应」
- 设置卡片（`settings.plugin.item` slot，namespace `vpn-toggle`）：全部配置字段 +
  分流模式下拉框 + 测试连通性按钮 + 折叠态运行态回显（直连/经代理、手动/自动探测）
- 设置卡片顶部运行态开关：读 `GET /vpn` 实时状态，点击即 `POST /vpn/on|off` 立即生效
  （非设置草稿，配置与运行态分离）
- 全局热键录制：卡片「录制组合键」按键自动识别 Electron accelerator（物理键码映射，
  中文输入法激活时同样可用；Esc 取消），防呆校验要求至少含 Control/Alt/Super；
  `/vpn` 状态新增 `hotkeyRegistered`，卡片回显注册成功/被占用
- 悬浮按钮跟随 `showPill` 实时消失/重现：`/vpn` 状态携带 `pill` 字段，
  已打开的页面 ≤5 秒内自动移除/挂回按钮，无需刷新页面
- 修复设置卡片未展开时宽度与相邻插件卡片不一致（卡片根元素补 `width:100%` +
  `border-box`）
- 安全：POST 路由 CSRF fence（跨源 Origin / `Sec-Fetch-Site: cross-site` 拒绝）；
  所有响应移除 CORS 头（全同源设计）
- 传输：裸 `ProxyAgent` 统一（http(s):// 与 socks5:// 代理实测全通过，SSE 兼容；
  弃用 socks5 会 ECONNRESET 的 `EnvHttpProxyAgent` 路径）
- 系统代理自动探测：Windows 注册表 `ProxyEnable`/`ProxyServer`，30 秒缓存，
  归一化 `host:port` / `http=x;https=y` / `socks=y` 为完整 URL
- 回退端点：webServer 不可用时落独立回环端口（43199..43206），
  异步 EADDRINUSE 重试链 + 常驻 error 监听（不崩主进程）
- `noProxy` 匹配加固：精确 / 前导点后缀 / `*` / IPv6 括号 / 单端口剥离
- 质量基线：`lib/pure.js` 纯函数层 + `tests/unit.mjs` 26 用例；
  `verify.mjs` 一键回归（退出码即结果）
- 状态持久化 `~/.dsh/vpn-proxy.json`，按请求热读取（1.2 秒 TTL 缓存）
