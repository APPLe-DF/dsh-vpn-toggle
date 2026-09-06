# Changelog

## 0.1.3

- Fixed the browser client dependency declaration so the Proxy Toggle card mounts after the DSH settings and plugin-settings services are available.

## 0.1.2

- Renamed the published package, plugin identity, and GitHub repository to `dsh-proxy-toggle`.
- Default control uses the authenticated DSH host session without creating plugin token/session files or binding a fallback port.
- Added the explicit `enableFallback` advanced configuration for standalone loopback, CLI Bearer, token pairing, and browser-session renewal; WebServer registration failures now fail closed when it is disabled.
- Updated the settings card, standalone page, agent guidance, read-only verifier, and documentation for host-session reauthentication versus fallback-session renewal.

## 0.1.1

Security and reliability remediation release.

- Fail closed when proxy is enabled with an empty, invalid, or unsupported proxy; `all` mode no longer falls back to direct when auto-detection fails.
- Added strict proxy normalization and validation. Credentials, path data, query strings, and fragments are rejected and redacted from state summaries and legacy notes.
- Added `proxySource` provenance (`auto`, `manual`, `api`) and a monotonic state revision used to reject stale automatic recovery results.
- Serialized state updates with `@deepseek-ai/dsh-atomic-write`, an atomic file update, and a lock; writes now complete before notifications and route responses.
- Added configured `dshHome` support through `@deepseek-ai/dsh-home-paths`; fallback port files are created under the same DSH home.
- Reworked dispatcher installation and teardown to preserve host-owned Undici dispatchers, restore symbols by identity, reuse ProxyAgents, and close plugin-owned pools on state changes.
- Added dispatcher readiness checks, startup pause/restore guards, request disconnect cancellation, bounded exit-probe response bodies, and IP-result validation.
- System proxy detection now uses asynchronous child processes with a shared in-flight request and a bounded deadline.
- Common-port recovery validates both HTTP and SOCKS5 candidates through exit probes instead of trusting a TCP listener or a 2xx response alone.
- Made the settings card read back each saved value before clearing staged drafts; unavailable settings scopes are read-only, and card buttons are explicit non-submit buttons.
- Restricted control routes to loopback and added a persistent 256-bit local token, POSIX/Windows permission hardening, Bearer authentication, DSH `ctx.connection` host-session reuse on WebServer routes, persistent 7-day-idle HttpOnly browser pairing sessions on fallback routes, explicit renewal with cookie rotation and a 30-day absolute lifetime, Host:port binding, logout, and pairing rate limits. The standalone page remains an unauthenticated shell but exposes no status until paired or served inside an authenticated DSH GUI.
- Routing fields (`proxy`, `noProxy`, `mode`, `allowProxy`) are now authoritative in the locked state file; the settings namespace only writes UI preferences, and trusted initial plugin configuration is migrated once.
- Updated pure-function contracts for port-qualified noProxy entries and IDN host matching.
- CI/release package smoke now imports only the host entry and resolves the browser entry without executing it; `verify.mjs` is read-only and sends no state-changing requests.
- Fixed default-disabled startup dispatcher installation, React Hook ordering across settings-scope states, host-only allowlist matching with explicit origin ports, and standard no-trailing-slash SOCKS5 URLs. The package minimum Node.js version is now 22.19.0.

## 0.1.0

Initial public release of the DSH proxy toggle plugin.

- Per-request switching for global-fetch traffic through a local HTTP(S) or SOCKS5 proxy.
- Settings card, floating pill, optional global hotkey, standalone loopback page, control routes, notifications, allowlist mode, noProxy, and startup/watchdog recovery.
