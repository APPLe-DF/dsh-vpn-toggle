# dsh-vpn-toggle

A DeepSeek Harness (DSH) profile-bundle plugin: switch all global `fetch`
traffic of the DSH main process (model API / Files API / web scraping)
between **direct connection** and a **local VPN proxy** — per request,
effective instantly, no restart.

中文说明：[README.md](README.md)

## Why

Node's built-in `fetch` ignores both the OS proxy settings and
`HTTP(S)_PROXY` environment variables (verified empirically). So while your
Clash/v2rayN-style client is running in plain proxy mode, DSH traffic stays
direct — TUN mode or asar patching are the only workarounds, and both are
heavy or lost on upgrade. This plugin hooks the per-request global
dispatcher instead: DSH-only, instant, upgrade-safe.

## Install

### Option 1: `dsh plugin add` (when you have the `dsh` CLI, recommended)

```sh
dsh plugin --profile <your-profile> add github:APPLe-DF/dsh-vpn-toggle
# or a tarball (GitHub Release asset):
dsh plugin --profile <your-profile> add ./dsh-vpn-toggle-0.1.0.tgz
```

### Option 2: manual mount (DSH Desktop users, no CLI needed)

1. Clone or download this repo to any directory (`<plugin-dir>` below);
2. Link it into the profile's `node_modules`:
   - Windows (admin CMD): `mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-vpn-toggle" <plugin-dir>`
   - macOS / Linux: `ln -s <plugin-dir> ~/.dsh/profiles/desktop/node_modules/dsh-vpn-toggle`
3. Append to `~/.dsh/profiles/desktop/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: vpn-toggle
         name: dsh-vpn-toggle
   ```

4. Restart DSH once (the toggle itself takes effect instantly afterwards).

## Four ways to toggle

| Surface | How |
| --- | --- |
| Floating pill | Bottom-right of the DSH window, `VPN ○/●` (click to toggle, 5s auto refresh) |
| Global hotkey | Off by default; record a combo in the settings card (Esc cancels) or type an accelerator like `Control+Alt+V` |
| Standalone page | `<GUI URL>/vpn/ui` (same origin as the GUI) |
| Endpoints / chat | `GET <GUI>/vpn` for status; `POST /vpn/on\|off\|toggle`; `POST /vpn/test` for connectivity; or just tell your agent "turn VPN on" |

State file: `~/.dsh/vpn-proxy.json` (`enabled` / `mode` / `proxy` / `noProxy` /
`allowProxy` / `note` - the last enable's auto-switch record), hot-read by the
next request within 1.2s.

UI language follows the environment automatically: settings card and pill use
the renderer language, the standalone page uses `Accept-Language`, host
notifications and agent guidance use the OS locale (Chinese / English).

## Routing modes

- `all` (default): everything goes through the VPN.
- `allowlist` (whitelist): only hosts matching `allowProxy` go through the
  VPN - fits "model API direct + web scraping via VPN" (measured locally:
  `api.deepseek.com` works direct, `api.ipify.org` gets RST without a VPN).
  An empty list = nothing proxied.
- **`noProxy` always wins**: a bypass hit stays direct even when it also
  matches the allowlist (loopback sanity).
- Switch mode/list in the settings card or via `POST /vpn/proxy` (body takes
  `mode` / `allowProxy`).

## Settings (Settings → Plugin config → VPN Toggle)

| Key | Default | Meaning |
| --- | --- | --- |
| `proxy` | (empty = auto) | http(s)://, socks5:// or bare host:port (http:// assumed); when empty, the system proxy is detected (Windows registry / macOS `scutil --proxy` / Linux gsettings, falling back to `HTTPS_PROXY` etc.) |
| `noProxy` | `localhost,127.0.0.1,::1` | Bypass list; highest priority, a hit stays direct |
| `mode` | `all` | `all` traffic / `allowlist` whitelist-only |
| `allowProxy` | (empty) | Whitelist hosts tunneled in allowlist mode (comma separated, `.example.com` suffixes work) |
| `hotkey` | (off) | Global toggle hotkey (Electron accelerator): record a combo or type it; empty = disabled |
| `showPill` | `true` | Floating pill in the GUI corner |
| `announceToAgent` | `true` | Inject usage guidance into agent sessions |

## How it works

The built-in `fetch` reads the global dispatcher symbol per request (Node 24 /
Electron 43: only `undici.globalDispatcher.1`, lazily initialized on first
use). The plugin installs a permanent wrapper on that symbol: per request it
runs the noProxy match (loopback always direct), then delegates to an on-demand
raw `ProxyAgent` (http(s):// and socks5:// proxies both verified, SSE
streaming compatible) or to the original direct dispatcher - so switching is
instant and nothing ever sets the symbol to `undefined`.

## Self-healing

- On enable with an unresponsive port (auto mode only - i.e. the proxy address
  is left empty in the card): re-detect the system proxy bypassing the cache,
  then scan common local ports (7897/7890/10809/10808/2080/1080/8118) and
  switch automatically; the notification, the `note` response field and the
  card record what happened. A manually typed address is never overridden.
- Startup self-check + a 30s liveness watchdog notify on lost/regained
  connectivity while enabled (no silent fallback to direct, ever).
- Test with the switch off = candidate-proxy preview: the exit is probed
  through a one-off ProxyAgent tunnel without touching global routing.

## Troubleshooting

- Model requests fail after enabling → turn it off first (pill / hotkey /
  `POST /vpn/off`), then `POST /vpn/test`: `proxy-unreachable` = the VPN
  client is not running; `exit-probe-failed` = the proxy is alive but its exit
  is unreachable.
- Pill shows `VPN ×` → the plugin is not loaded (check the main-process log
  for the `[vpn-toggle]` prefix).
- Hotkey not working → probably taken by another app, pick another combo; or
  clear it.
- webServer registration failed → the plugin falls back to a private loopback
  port (43199+, written to `~/.dsh/vpn-proxy.port`).

## Development

```sh
node --check lib/index.js   # syntax (all lib files)
node tests/unit.mjs         # pure-function unit tests, exit code = verdict
node verify.mjs             # one-shot regression against a running DSH
```

`lib/pure.js` holds the dependency-free pure functions (host matching, proxy
normalization, routing decision, key mapping); everything else is host wiring
(`lib/index.js`) and the settings-card client half (`lib/client.js`).

## License

[MIT](LICENSE)
