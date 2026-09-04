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
| 全局热键 | 默认关闭；在设置卡片「录制组合键」直接按键识别（Esc 取消），或手动填 accelerator（如 `Control+Alt+V`），保存即启用；卡片回显注册结果（被占用会提示） |
| 浏览器独立页 | `<GUI 地址>/vpn/ui`（GUI 同源） |
| 端点 / 对话 | `GET <GUI>/vpn` 看状态；`POST /vpn/on|off|toggle`；`POST /vpn/test` 测连通性；直接对 agent 说「开VPN」 |

状态文件：`~/.dsh/vpn-proxy.json`（`enabled` / `mode` / `proxy` / `noProxy` / `allowProxy`，1.2 秒内被下一个请求热读取）。

## 分流模式

- `all`（默认）：全部流量走 VPN。
- `allowlist`：只有命中 `allowProxy` 列表的主机走 VPN——适合「模型 API 直连 + web 抓取走 VPN」同时成立的场景（本机实测 `api.deepseek.com` 直连可用、`api.ipify.org` 直连被 RST）。列表留空 = 全部直连。
- **`noProxy` 优先级最高**：命中绕过列表的目标即使命中 `allowProxy` 也直连（回环防呆）。
- 模式与列表可在设置卡片改，或 `POST /vpn/proxy`（body 带 `mode` / `allowProxy`）。

## 设置（设置 → 插件配置 → VPN 开关）

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `proxy` | （留空 = 自动探测） | http(s):// 或 socks5://；留空时读 Windows 系统代理（注册表 ProxyEnable/ProxyServer） |
| `noProxy` | `localhost,127.0.0.1,::1` | 绕过代理的地址；优先级最高，命中即直连 |
| `mode` | `all` | 分流模式：`all` 全部流量 / `allowlist` 仅列表流量 |
| `allowProxy` | （空） | allowlist 模式下走 VPN 的主机（逗号分隔，支持 `.example.com`）；仅 allowlist 模式生效 |
| `hotkey` | （默认关闭） | 全局切换热键（Electron accelerator）：支持「录制组合键」自动识别或手动填写，留空不启用 |
| `showPill` | `true` | GUI 右下角悬浮开关 |
| `announceToAgent` | `true` | 向 agent 注入使用指引 |

## 原理

内置 `fetch` 按请求读取全局 dispatcher 符号（Node 24 / Electron 43 实证只读
`undici.globalDispatcher.1`，且默认 dispatcher 首次请求时才懒初始化）。插件在
主进程安装一个包装器：逐请求先做 noProxy 匹配（回环地址永远直连），再委托给
按需重建的裸 `ProxyAgent`（http(s):// 与 socks5:// 代理实测全通过，SSE 流式
兼容）或原始直连 dispatcher——因此切换即时生效。

## 排错

- 开启后模型请求报错 → 先关（按钮/热键/`POST /vpn/off`），再 `POST /vpn/test` 定位：`proxy-unreachable` = VPN 客户端没在运行（检查端口），`exit-probe-failed` = 代理通但出口端点不可达；
- **开启时端口无响应会自动自救（仅自动模式，即卡片代理地址留空）**：先重探系统代理（绕过缓存），不行再扫常见本地端口（7897/7890/10809/10808/2080/1080/8118），命中即自动切换，通知、响应 `note` 字段与卡片会注明；全都不通才带警告开启；
- **手动模式（卡片代理地址填了值）**：端口死了只警告、永不覆盖你填的地址，是否改由你决定；
- 换端口：`POST /vpn/proxy`（body `{"proxy":"http://127.0.0.1:端口"}`）或设置卡片。
- 按钮显示 `VPN ×` → 插件未加载（查看主进程日志里 `[vpn-toggle]` 前缀）。
- 热键无效 → 多半被其他软件占用，换一个 accelerator；不需要热键就把它清空。
- webServer 路由注册失败 → 自动回退独立回环端口（43199+，写入 `~/.dsh/vpn-proxy.port`）。
