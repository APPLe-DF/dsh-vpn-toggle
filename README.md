# dsh-vpn-toggle

DSH VPN 快捷开关（DeepSeek Harness profile bundle 插件）。

DSH 主进程的所有全局 `fetch` 流量（模型 API / Files API / web 抓取）可在
「直连」与「本地 VPN 代理」之间**按请求即时切换**，无需重启。

## 安装（本机已装）

- 插件源码：`LOCAL_INSTALL_DIR\`
- 通过目录联接挂进 profile：`~/.dsh/profiles/desktop/node_modules/dsh-vpn-toggle`
- 组合行：`~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `vpn-toggle` insert 行
- 生效需要重启 DSH 一次（之后开关即时生效）

## 快捷开关（四选一）

| 方式 | 操作 |
| --- | --- |
| DSH 界面悬浮按钮 | 窗口**右下角** `VPN ○/●`（点击切换，5 秒自动刷新） |
| 全局热键 | 默认关闭；在设置卡片填 accelerator（如 `Control+Alt+V`）即启用，系统通知反馈 |
| 浏览器独立页 | `<GUI 地址>/vpn/ui`（GUI 同源） |
| 端点 / 对话 | `GET <GUI>/vpn` 看状态；`POST /vpn/on|off|toggle`；直接对 agent 说「开VPN」 |

状态文件：`~/.dsh/vpn-proxy.json`（`enabled` / `proxy` / `noProxy`，1.2 秒内被下一个请求热读取）。

## 设置（设置 → 插件配置 → VPN 开关）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `proxy` | （留空 = 自动探测） | http(s):// 或 socks5://；留空时读 Windows 系统代理（注册表 ProxyEnable/ProxyServer） |
| `noProxy` | `localhost,127.0.0.1,::1` | 绕过代理的地址 |
| `hotkey` | （默认关闭） | 全局切换热键（Electron accelerator），留空不启用 |
| `showPill` | `true` | GUI 右下角悬浮开关 |
| `announceToAgent` | `true` | 向 agent 注入使用指引 |

## 原理

内置 `fetch` 按请求读取全局 dispatcher 符号（Node 24 / Electron 43 实证只读
`undici.globalDispatcher.1`，且默认 dispatcher 首次请求时才懒初始化）。插件在
主进程安装一个包装器：逐请求先做 noProxy 匹配（回环地址永远直连），再委托给
按需重建的裸 `ProxyAgent`（http(s):// 与 socks5:// 代理实测全通过，SSE 流式
兼容）或原始直连 dispatcher——因此切换即时生效。

## 排错

- 开启后模型请求报错 → 先关（按钮/热键/`POST /vpn/off`），检查 VPN 客户端与端口；
  换端口：`POST /vpn/proxy`（body `{"proxy":"http://127.0.0.1:端口"}`）或设置卡片。
- 按钮显示 `VPN ×` → 插件未加载（查看主进程日志里 `[vpn-toggle]` 前缀）。
- 热键无效 → 多半被其他软件占用，换一个 accelerator；不需要热键就把它清空。
- webServer 路由注册失败 → 自动回退独立回环端口（43199+，写入 `~/.dsh/vpn-proxy.port`）。
