# dsh-proxy-toggle

让 DeepSeek Harness（DSH）里的网络请求，可以在“直接连接”和“通过本机代理连接”之间快速切换。

这个插件只影响 DSH 主进程中使用公共网络连接的请求，例如模型 API、Files API 等。它不会改变电脑上其他软件的网络设置，也不会影响那些主动指定了其他网络出口的请求，例如 `dsh-web-fetch-http` 的固定出口请求。

## 安装

### 使用 DSH CLI

```sh
dsh plugin --profile <profile> add github:APPLe-DF/dsh-proxy-toggle
```

也可以安装指定版本的发布包：

```sh
dsh plugin --profile <profile> add ./dsh-proxy-toggle-0.1.2.tgz
```

### 使用 npm

```sh
npm install dsh-proxy-toggle
```

npm 安装后仍需要按照 DSH profile 的插件配置挂载该包。

### 授权方式

默认情况下，插件只使用 DSH 自身的浏览器会话：登录 DSH 后，设置卡片、悬浮按钮和 `<GUI地址>/vpn/ui` 都可以直接使用，不会创建 `vpn-proxy.token`、浏览器 fallback session，也不会监听额外的本机端口。

只有在确实需要独立页面、CLI，或需要为 WebServer 不可用准备备用控制面时，才在 profile 的 `cordis.patch.yml` 中显式开启高级 fallback：

```yaml
- id: proxy-toggle
  config:
    enableFallback: true
```

启用后，插件才会在 WebServer 路由不可用时监听 `127.0.0.1:43199..43206` 中的一个端口，并创建受保护的 token/session 文件。若使用独立 fallback 端点，或当前浏览器没有 DSH 会话，请在本机终端运行：

```sh
dsh-proxy-toggle-auth
# 如果命令未在 PATH 中：
npx --package dsh-proxy-toggle dsh-proxy-toggle-auth
```

复制命令输出的 token，打开独立 fallback 端点的 `<GUI地址>/vpn/ui` 完成配对。独立浏览器会话空闲 7 天后过期，最长有效 30 天；会话仍有效时，可以在设置卡片或独立页面点击“延长授权 7 天”手动轮换 cookie。会话过期后仍需重新粘贴 token 配对。cookie 使用 `HttpOnly` 和 `SameSite=Strict`；token 不会写入页面、URL 或设置。DSH GUI 的正常宿主认证不需要这一步。

命令行调用仅适用于已显式启用 fallback 的配置，可以使用 Bearer token，例如：

```sh
curl -H "Authorization: Bearer $(dsh-proxy-toggle-auth)" http://127.0.0.1:PORT/vpn
```

如果使用了插件配置中的 `dshHome`，运行辅助命令时应通过相同的 `$DSH_HOME` 指向该目录。

### DSH 宿主会话到期

DSH 宿主浏览器会话默认有效 30 天，期限由 DSH 的 `cookieMaxAgeDays` 管理，插件不会修改它。到期后按以下步骤恢复正常 GUI 授权：

1. 如果 DSH 仍在运行，重新打开 DSH 启动时输出的认证 URL；如果进程已经退出，先重新启动 DSH，再使用它输出的新 URL。
2. 使用与原来相同的 GUI 地址和主机名（例如一直使用 `127.0.0.1`，不要中途改成 `localhost`），让 DSH 完成一次宿主浏览器认证。
3. DSH 会把认证 URL 清理为普通 GUI 地址并写入新的宿主 cookie。
4. 刷新 DSH GUI。插件会自动重新复用宿主会话，不需要再次粘贴 `vpn-proxy.token`。

这是 DSH 自己的认证流程；不要把 DSH 认证 URL 或插件 token 发到聊天、日志、页面或 URL 参数中。

如果是手动挂载到 DSH Desktop，请将包放入 profile 的 `node_modules`，并在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: proxy-toggle
      name: dsh-proxy-toggle
```

## 最简单的用法

安装插件后，可以在以下位置控制代理：

- **设置 -> 插件配置 -> 代理开关**：填写代理地址、选择工作模式；只有启用 fallback 且会话仍有效时才会显示“延长授权 7 天”。
- **DSH 窗口右下角的悬浮按钮**：快速开启或关闭。
- **全局快捷键**：可以在设置中自行启用。
- **独立控制页**：打开 `<GUI地址>/vpn/ui`。

代理地址填写代理软件在本机提供的端口，例如：

```text
http://127.0.0.1:7897
socks5://127.0.0.1:1080
```

也可以只填写 `127.0.0.1:7897`，插件会按 HTTP 代理处理。代理地址留空时，插件会尝试自动寻找系统代理和常见的本地代理端口。

## 哪些请求走代理

这里的“路由”不是电脑全局路由，而是**决定 DSH 的某个网络请求是否经过代理**。可以把它理解为三条规则，优先级从高到低如下：

1. **绕过列表 `noProxy`**：列出的地址永远直连。
2. **白名单模式 `allowlist`**：只有白名单里的地址走代理，其他地址直连。
3. **全部模式 `all`**：除绕过列表外，其他 DSH 请求都走代理。

| 模式 | 效果 | 适合场景 |
| --- | --- | --- |
| `all`（默认） | DSH 的请求基本都经过代理，`noProxy` 中的地址除外 | 希望 DSH 网络请求统一走代理 |
| `allowlist` | 只有 `allowProxy` 中的地址经过代理，其他请求直连 | 只让特定网站走代理，例如只代理某些网站 |

例如，想让所有请求走代理，但本机服务和本地地址保持直连：

```text
模式：all
绕过列表：localhost,127.0.0.1,::1
```

例如，想让模型接口直连，只让指定网站走代理：

```text
模式：allowlist
代理白名单：example.com,.github.com
绕过列表：localhost,127.0.0.1,::1
```

其中：

- `example.com` 会匹配这个域名及其子域名。
- `.github.com` 也会匹配 `api.github.com` 等子域名。
- 多个地址用英文逗号分隔。
- 可以写 IDN 域名，也可以写 `example.com:8443` 这种带端口的地址；带端口时只匹配相同端口。
- `*` 表示匹配所有地址，但 `noProxy` 仍然优先。
- `allowlist` 模式下如果代理白名单为空，表示所有请求都直连。
- 回环地址（如 `localhost`、`127.0.0.1`、`::1`）始终不会经过代理。

## 自动寻找代理

代理地址留空时，插件会按以下方式寻找可用代理：

1. 读取 Windows、macOS 或 Linux 的系统代理设置。
2. 检查代理环境变量。
3. 检查几个常见的本地代理端口。
4. 通过实际的 HTTP/SOCKS5 出口探测确认代理可用。

在 `all` 模式下，如果没有找到可用代理，插件会拒绝开启代理，避免请求意外变成直连。手动填写的代理如果暂时失效，插件只会提示代理不可用，不会擅自替换你填写的地址。

## 常见问题

### 开启后请求仍然失败

先关闭 代理 开关，再确认 代理 软件正在运行，并检查设置中的代理地址和端口。`proxy-unreachable` 表示代理端口没有响应；`exit-probe-failed` 表示代理端口能连接，但出口探测没有得到有效 IP。

### 为什么有些请求不受影响

插件只接管 DSH 使用公共 Undici dispatcher 的请求。显式指定其他 dispatcher 的请求不会经过这个开关，固定出口的 `dsh-web-fetch-http` 就属于这种情况。

### 配置保存在哪里

状态文件位于 `$DSH_HOME/vpn-proxy.json`；如果 DSH 没有设置 `$DSH_HOME`，默认位置是 `~/.dsh/vpn-proxy.json`。代理、绕过列表、模式和白名单由认证控制接口写入该文件；热键、悬浮按钮和 agent 指引属于普通 settings 偏好。插件也支持 `dshHome` 配置，但应与 profile 使用的 DSH 数据目录保持一致。

代理凭据、URL 路径、query string 和 fragment 会被拒绝，不会保存。只有配置 `enableFallback: true` 时，控制 token 才位于同一 DSH 数据目录的 `vpn-proxy.token`，独立浏览器会话才会使用 `vpn-proxy.sessions.json` 保存不可逆的会话哈希、签发时间、最后续期时间、Host:port 和到期时间；会话空闲 7 天过期，绝对期限为 30 天。POSIX 系统使用目录 `0700`、凭据文件 `0600`，Windows 使用仅当前账户可读写的 ACL。状态写入使用锁和原子更新，避免多个操作同时修改文件。

### 控制接口安全吗

控制接口只接受本机回环连接。默认情况下，DSH Web GUI 只使用 DSH 宿主的浏览器会话；只有显式配置 `enableFallback: true` 后，独立 fallback 端点和 CLI 才使用插件 token 或插件浏览器会话。首次使用独立端点时运行 `dsh-proxy-toggle-auth`，再在 fallback 的 `/vpn/ui` 配对。插件会话空闲 7 天后过期，最长 30 天；有效期内可在设置卡片或独立页面点击一次“延长授权 7 天”，续期会轮换 cookie，不会因后台状态轮询自动延长。DSH 宿主会话的期限仍由 DSH 管理，插件不会伪造或延长它。浏览器 cookie 使用 `HttpOnly` 和 `SameSite=Strict`，token 不会出现在页面或 URL 中。同一台电脑上能够读取 token 文件的进程仍可获得 opt-in fallback 的控制权限；不要通过反向代理把接口暴露到局域网或公网。插件还会拒绝常见反向代理转发头和公网 Host，这属于部署防护，不是操作系统级进程隔离。主要接口如下：

```text
POST /vpn/pair
POST /vpn/renew        # 仅续期当前有效的插件浏览器会话（fallback）
POST /vpn/logout
GET  /vpn              # 默认需要 DSH 宿主会话；fallback 需显式启用
POST /vpn/on           # 默认需要 DSH 宿主会话；fallback 需显式启用
POST /vpn/off          # 默认需要 DSH 宿主会话；fallback 需显式启用
POST /vpn/toggle       # 默认需要 DSH 宿主会话；fallback 需显式启用
POST /vpn/test         # 默认需要 DSH 宿主会话；fallback 需显式启用
POST /vpn/proxy        # 默认需要 DSH 宿主会话；fallback 需显式启用
```

只有配置 `enableFallback: true` 且 WebServer 路由注册失败时，插件才会使用 `43199..43206` 范围内的本机端口，并把端口信息写入 `$DSH_HOME/vpn-proxy.port`。

## 开发

`lib/pure.js` 不依赖 DSH，包含地址匹配、代理地址处理和热键辅助函数。`lib/index.js` 负责 DSH 主进程集成，`lib/client.js` 负责设置卡片界面。

仓库 CI 会安装依赖、检查打包文件、导入主进程入口、解析但不执行浏览器入口，并在 Linux、macOS 和 Windows 的 Node 22.19/24 环境中运行纯函数测试。DSH/Electron 运行时集成需要单独安装宿主环境。

## 许可证

[MIT](LICENSE)
