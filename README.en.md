# dsh-proxy-toggle

A DeepSeek Harness (DSH) profile-bundle plugin that switches the DSH main process between direct routing and a local HTTP/SOCKS5 proxy on each request.

The switch applies to requests using the process-wide Undici dispatcher, including model and Files API traffic. It does not intercept requests that provide their own explicit Undici dispatcher; `dsh-web-fetch-http` fixed-dispatcher requests are outside this switch.

## Install

With the DSH CLI:

```sh
dsh plugin --profile <profile> add github:APPLe-DF/dsh-proxy-toggle
# or a release tarball
dsh plugin --profile <profile> add ./dsh-proxy-toggle-0.1.2.tgz
```

You can also install the published package from npm:

```sh
npm install dsh-proxy-toggle
```

By default, the plugin uses only DSH's own browser session. After signing in to DSH, the settings card, floating pill, and `<GUI-origin>/vpn/ui` work without a second plugin token; no `vpn-proxy.token`, fallback browser session, or extra local port is created.

Enable the advanced fallback explicitly in the profile's `cordis.patch.yml` only when you need a standalone page, CLI control, or a backup control surface for WebServer failures:

```yaml
- id: proxy-toggle
  config:
    enableFallback: true
```

Only then will the plugin listen on one of `127.0.0.1:43199..43206` when WebServer routes are unavailable, and create protected token/session files. If using that standalone fallback endpoint, or if the browser has no DSH session, run this in a local terminal:

```sh
dsh-proxy-toggle-auth
# if the binary is not on PATH:
npx --package dsh-proxy-toggle dsh-proxy-toggle-auth
```

Paste the token into the standalone fallback endpoint at `<GUI-origin>/vpn/ui`. The standalone browser session expires after 7 days idle and at 30 days absolute. While it is still valid, the settings card or standalone page offers a `Renew for 7 days` button that rotates the cookie. Once expired, pairing with the token is required again. The cookie uses `HttpOnly` and `SameSite=Strict`; the token is never placed in the page, URL, or settings. The normal DSH GUI does not require this step.

A local CLI status read is available only with explicit fallback enabled:

```sh
curl -H "Authorization: Bearer $(dsh-proxy-toggle-auth)" http://127.0.0.1:PORT/vpn
```

The package still needs to be mounted according to the profile's plugin configuration. For a manual DSH Desktop mount, link the package into the profile's `node_modules` and add it to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: proxy-toggle
      name: dsh-proxy-toggle
```

The profile data root is `$DSH_HOME` when configured by DSH, otherwise `~/.dsh`. The plugin also accepts an explicit `dshHome` plugin configuration value; it should point at the same root used by the profile.

### When The DSH Host Session Expires

The DSH host browser session defaults to 30 days and is controlled by DSH's `cookieMaxAgeDays`; the plugin does not change it. After it expires:

1. If DSH is still running, reopen the authentication URL printed when DSH started. If the process has exited, restart DSH and use the new URL it prints.
2. Use the same GUI origin and hostname as before, such as `127.0.0.1` consistently rather than switching to `localhost`.
3. DSH will clean the authentication URL back to the ordinary GUI URL and write a new signed host cookie.
4. Refresh the DSH GUI. The plugin will reuse the host session again without asking for `vpn-proxy.token`.

This is DSH's own authentication flow. Do not send the DSH authentication URL or the plugin token in chat, logs, page content, or URL parameters.

## Control Surfaces

- Settings -> Plugin config -> Proxy Toggle
- The floating pill in the DSH GUI
- Optional Electron global hotkey
- `GET /vpn` (the authenticated DSH host session by default; plugin token or browser session only with explicit fallback enabled)
- `GET /vpn/ui` (anonymous page shell; pairing controls appear only when fallback is enabled)
- `POST /vpn/pair`, `POST /vpn/renew`, `POST /vpn/logout` (`/vpn/renew` only rotates a still-valid plugin browser session)
- `POST /vpn/on`, `POST /vpn/off`, `POST /vpn/toggle`, `POST /vpn/test`, and `POST /vpn/proxy` (DSH host session by default; plugin credentials only with explicit fallback enabled)
- The standalone page at `<GUI-origin>/vpn/ui`

The control surface accepts loopback connections only. The DSH Web GUI uses DSH's authenticated browser session by default; the optional fallback port and CLI use the plugin token or plugin browser session only after `enableFallback=true` is configured. A plugin browser session expires after 7 days idle and at 30 days absolute. While it is valid, the settings card or standalone page can renew it explicitly; renewal rotates the cookie and is not triggered by background status polling. The DSH host-session lifetime remains DSH-owned, and the plugin neither forges nor extends it. Other processes that can read the local token file can still control an opt-in fallback, so never expose the port through a reverse proxy to a LAN or public network. Common reverse-proxy forwarding headers and public Host values are rejected as an additional deployment fence, not as OS-level process isolation.

## State And Sources

The state file is `$DSH_HOME/vpn-proxy.json` (`~/.dsh/vpn-proxy.json` by default). It contains `enabled`, `mode`, `proxy`, `proxySource`, `noProxy`, `allowProxy`, `note`, and `revision`.

`proxySource` is `auto`, `manual`, or `api`:

- A proxy from the trusted initial plugin configuration is `manual`.
- Authenticated `/vpn/proxy` writes are authoritative in the locked state file and are marked `api`.
- The DSH settings namespace stores only the hotkey, pill visibility, and agent-guidance preference; it cannot write routing fields.

The control token is stored as `$DSH_HOME/vpn-proxy.token` (or `~/.dsh/vpn-proxy.token`) only when `enableFallback=true` is configured, and is protected with `0700`/`0600` permissions on POSIX systems and a current-account-only ACL on Windows. Only then do standalone browser sessions store irreversible hashes, issued/renewed timestamps, absolute expiry, and their bound Host:port in `$DSH_HOME/vpn-proxy.sessions.json`. If `dshHome` is configured explicitly, run the helper with the same `$DSH_HOME` value.

Use the settings card or `/vpn/proxy` for normal changes. Proxy credentials, paths, query strings, and fragments are rejected; they are not stored in ordinary state. State writes are serialized and use an atomic file update plus a lock. A stale `.lock` file is not blindly deleted, so a persistent lock failure must be investigated from the main-process log.

## Routing

- `all` (default): every non-`noProxy` target uses the configured proxy.
- `allowlist`: only hosts in `allowProxy` use the proxy; an empty `allowProxy` intentionally means direct-only routing.
- `noProxy` always wins.
- Entries support exact hosts, `.example.com` suffixes, `*`, IDN names, and `host:port`. A port-qualified entry matches only that origin port.
- Loopback targets bypass the proxy.

An empty proxy enables automatic detection: Windows Registry, macOS `scutil --proxy`, Linux GNOME `gsettings`, then proxy environment variables. Detection is asynchronous, cached briefly, and common local ports are validated with HTTP and SOCKS5 exit probes. In `all` mode, enabling is refused when no usable proxy is found, preventing an accidental direct fallback. A manually selected dead proxy is warned about and never replaced automatically.

## Troubleshooting

`proxy-unreachable` means the selected proxy port did not respond. `exit-probe-failed` means the exit endpoints could not produce a valid IP. Turn the proxy off first when model requests fail, then inspect the client and proxy port. The test route uses bounded response bodies and request cancellation; with the switch off and a proxy configured it performs a one-off candidate preview without changing global routing.

If WebServer route registration fails, the plugin binds a private loopback port in `43199..43206` and writes its discovery file to `$DSH_HOME/vpn-proxy.port` (default `~/.dsh/vpn-proxy.port`).

## Development

`lib/pure.js` is dependency-free and contains routing, host matching, proxy normalization, and hotkey helpers. `lib/index.js` contains DSH host wiring and `lib/client.js` contains the settings-card client.

Repository CI installs package dependencies, checks the packed tarball, imports the host entry, resolves the browser entry without executing it, and runs pure-function tests across Linux, macOS, and Windows Node 22.19/24 jobs. Runtime DSH/Electron integration still requires a separately installed host.

## License

[MIT](LICENSE)
