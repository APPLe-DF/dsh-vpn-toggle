window.__ModuleLoader__.load({
	id: "dsh-proxy-toggle",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { createElement, useState, useCallback, useRef } = react;
		//#region store
		/** Minimal useSyncExternalStore-compatible snapshot store. */
		function createSnapshotStore(initial) {
			let current = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => current,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(next) {
					if (next === current) return;
					current = next;
					for (const listener of listeners) listener();
				}
			};
		}
		//#endregion
		//#region controller
		const NS = "proxy-toggle";
		// Card language: follow the renderer locale (navigator.language). In the
		// Electron window this mirrors the app/system language; in an external
		// browser it follows that browser. Falls back to English.
		const LANG_ZH = (navigator.language || "en").toLowerCase().indexOf("zh") === 0;
		const T = LANG_ZH ? {
			title: "代理开关",
			proxyLabel: "代理地址",
			proxyHint: "你的代理软件在本机开出的入口。填 http(s)://… 或 socks5://…，也可以只填 127.0.0.1:7897（自动按 http 处理）；留空 = 自动模式：自动探测系统代理，端口没响应时还会自动换一个",
			proxyPlaceholder: "留空自动探测，如 http://127.0.0.1:7897 或 127.0.0.1:7897",
			invalidProxy: "代理地址必须是 http(s)://、socks5:// 或 host:port 形式",
			noProxyLabel: "绕过列表",
			noProxyHint: "永远不走代理、直接连接的地址（逗号分隔）。支持 .example.com 后缀与 * 通配；优先级最高，和白名单同时命中时以这里为准",
			modeLabel: "分流模式",
			modeHint: "全部流量 = 使用全局 dispatcher 的 DSH 请求都走代理；仅白名单流量 = 只有白名单里的网站走代理，其余直连——显式指定 dispatcher 的请求不受此开关影响",
			modeAll: "全部流量",
			modeAllowlist: "仅白名单流量",
			allowProxyLabel: "代理白名单",
			allowProxyHint: "只让这些网站走代理，其余照旧直连（逗号分隔，支持 .example.com 后缀）。仅在「仅白名单流量」模式下生效；留空 = 全部直连",
			allowProxyPlaceholder: "api.ipify.org,.github.com",
			hotkeyLabel: "全局热键",
			hotkeyHint: "在任何界面按下这个组合键即可一键开关代理。点「录制组合键」直接按键识别（Esc 取消），或手动填写（如 Control+Alt+V）；留空 = 不启用",
			hotkeyPlaceholder: "留空则不启用，如 Control+Alt+V",
			record: "录制组合键", recording: "录制中…", recordingPrompt: "按下组合键…（Esc 取消）", clearBtn: "清除",
			needModifier: "至少需要 Control / Alt / Super 之一——纯字母或 Shift+键做全局热键会占掉整个系统的这个键",
			unsupportedKey: "这个键不能用作热键，换一个组合",
			pillLabel: "悬浮按钮", pillHint: "在 DSH 窗口右下角显示一个代理小圆钮，点击即可开关；关闭后 5 秒内自动消失",
			guidanceLabel: "agent 指引", guidanceHint: "让 AI 助手知道怎么帮你开关代理（对它说「开代理」即可）",
			save: "保存", saving: "保存中…", testConn: "测试连通性", testing: "测试中…", discard: "撤销",
			saveFailed: "保存失败：", dirty: "● 有未保存的修改，记得保存", saved: "已保存",
			dirtySwitchHint: " · 上方有未保存的修改，开关按已保存配置执行",
			switching: "切换中…", onBtn: "已开启 · 点击关闭", offBtn: "已关闭 · 点击开启",
			readingRuntime: "读取运行状态中…", walking: "DSH 正在走代理：",
			unset: "(未设置)", directNow: "当前：直连", now: "当前：", via: "经 ",
			manual: "（手动设置）", autoDetected: "（自动探测）",
			modeShortAll: "全部流量", modeShortList: "仅白名单", modeTag: " · 模式：",
			switchFailed: "切换失败：",
			testExit: (ip, ms, via) => `出口 ${ip} · ${ms}ms · ${via}`,
			testNotOk: "测试未通过：", testErr: "测试失败：", unknownReason: "未知原因",
			viaProxy: "经代理", viaDirect: "直连",
			pendingSuffix: "（代理路由未开启，仅预检代理）", proxyAlive: "代理端口存活",
			hotkeyOk: (k) => `热键 ${k} 已注册生效。`,
			hotkeyBad: (k) => `热键 ${k} 注册失败（可能被其他程序占用），换一个组合或清除后保存。`,
			hotkeyReading: "热键注册状态读取中…",
			footer: "运行状态见右下角悬浮按钮；开关即时生效，修改代理地址后同样即时被下一个请求读取。",
			settingsUnavailable: "设置服务暂不可用",
			settingsLoading: "正在读取设置…",
			authTitle: "控制授权",
			authHint: "通常直接使用已登录的 DSH GUI；只有 profile 显式配置 enableFallback=true 后，独立 fallback 页面才需要在本机终端运行 dsh-proxy-toggle-auth（或 npx --package dsh-proxy-toggle dsh-proxy-toggle-auth）并粘贴 token。fallback 会话空闲 7 天后过期，最长 30 天；已授权时可点击“延长授权 7 天”。token 不会保存到设置中。",
			authPlaceholder: "粘贴本机授权 token",
			authorize: "授权",
			authorizing: "授权中…",
			renew: "延长授权 7 天",
			renewing: "续期中…",
			authorized: "已授权",
			authorizationRequired: "请先授权控制接口；也可以打开 /vpn/ui 完成授权",
			hostAuthorizationRequired: "DSH 宿主会话已过期，请重新打开 DSH 启动时输出的认证 URL，然后刷新页面",
			fallbackEnabled: "高级 fallback：已启用（独立端口、CLI 和 token 配对可用）",
			fallbackDisabled: "高级 fallback：未启用；如需独立端口或 CLI，请在 profile 配置 enableFallback=true 后重启 DSH",
			logout: "退出授权",
			expand: "展开", collapse: "收起"
		} : {
			title: "Proxy Toggle",
			proxyLabel: "Proxy address",
			proxyHint: "The local entry point of your proxy app. Accepts http(s)://, socks5://, or plain 127.0.0.1:7897 (http:// assumed). Leave empty for auto mode: the plugin detects the system proxy and switches ports automatically when one dies",
			proxyPlaceholder: "Leave empty to auto-detect, e.g. http://127.0.0.1:7897 or 127.0.0.1:7897",
			invalidProxy: "The proxy address must be http(s)://, socks5:// or host:port form",
			noProxyLabel: "Bypass list",
			noProxyHint: "Addresses that never go through the proxy and always connect directly (comma separated). .example.com suffixes and * wildcards work; highest priority - wins over the whitelist",
			modeLabel: "Routing mode",
			modeHint: "All traffic = DSH requests using the global dispatcher go through the proxy; Allowlist only = only whitelisted sites use it, everything else stays direct - requests with an explicit dispatcher are outside this switch",
			modeAll: "All traffic",
			modeAllowlist: "Allowlist only",
			allowProxyLabel: "Proxy allowlist",
			allowProxyHint: "Only these sites go through the proxy, everything else stays direct (comma separated, .example.com suffixes work). Only effective in Allowlist-only mode; empty = nothing proxied",
			allowProxyPlaceholder: "api.ipify.org,.github.com",
			hotkeyLabel: "Global hotkey",
			hotkeyHint: "Press this combo anywhere to toggle the proxy. Click Record combo to capture it by pressing (Esc cancels), or type it (e.g. Control+Alt+V); empty = disabled",
			hotkeyPlaceholder: "Empty = disabled, e.g. Control+Alt+V",
			record: "Record combo", recording: "Recording…", recordingPrompt: "Press the key combo… (Esc to cancel)", clearBtn: "Clear",
			needModifier: "Needs at least one of Control / Alt / Super - a bare letter or Shift+key as a GLOBAL hotkey would swallow that key system-wide",
			unsupportedKey: "That key cannot be used as a hotkey, try another combo",
			pillLabel: "Floating pill", pillHint: "Show a small proxy button in the bottom-right corner of DSH; click it to toggle. It disappears within 5s when turned off",
			guidanceLabel: "Agent guidance", guidanceHint: "Teach the AI assistant how to toggle the proxy for you (just say: turn the proxy on)",
			save: "Save", saving: "Saving…", testConn: "Test connectivity", testing: "Testing…", discard: "Discard",
			saveFailed: "Save failed: ", dirty: "● Unsaved changes - remember to save", saved: "Saved",
			dirtySwitchHint: " · Unsaved changes above - the switch applies the SAVED config",
			switching: "Switching…", onBtn: "ON · click to turn off", offBtn: "OFF · click to turn on",
			readingRuntime: "Reading runtime state…", walking: "DSH is using the proxy: ",
			unset: "(not set)", directNow: "Now: direct", now: "Now: ", via: "via ",
			manual: " (manual)", autoDetected: " (auto-detected)",
			modeShortAll: "All traffic", modeShortList: "Allowlist", modeTag: " · mode: ",
			switchFailed: "Switch failed: ",
			testExit: (ip, ms, via) => `Exit ${ip} · ${ms}ms · ${via}`,
			testNotOk: "Test did not pass: ", testErr: "Test error: ", unknownReason: "unknown reason",
			viaProxy: "via proxy", viaDirect: "direct",
			pendingSuffix: " (proxy routing off - candidate proxy preview)", proxyAlive: "Proxy port alive",
			hotkeyOk: (k) => `Hotkey ${k} is registered and active.`,
			hotkeyBad: (k) => `Hotkey ${k} registration FAILED (probably taken by another app) - pick another combo or clear and save.`,
			hotkeyReading: "Reading hotkey registration state…",
			footer: "Runtime also shows in the bottom-right pill; the switch takes effect immediately, and a changed proxy address is picked up by the next request.",
			settingsUnavailable: "Settings service unavailable",
			settingsLoading: "Loading settings…",
			authTitle: "Control authorization",
			authHint: "An authenticated DSH GUI normally works directly. Only after `enableFallback=true` is explicitly configured in the profile does a standalone fallback page need dsh-proxy-toggle-auth (or npx --package dsh-proxy-toggle dsh-proxy-toggle-auth) in a local terminal to pair this browser. The fallback session expires after 7 days idle and at 30 days absolute; while authorized, use Renew for 7 days. The token is never saved in settings.",
			authPlaceholder: "Paste the local authorization token",
			authorize: "Authorize",
			authorizing: "Authorizing…",
			renew: "Renew for 7 days",
			renewing: "Renewing…",
			authorized: "Authorized",
			authorizationRequired: "Authorize the control endpoint first; you can also open /vpn/ui to pair this browser",
			hostAuthorizationRequired: "The DSH host session expired; reopen the DSH authentication URL printed at startup, then refresh this page",
			fallbackEnabled: "Advanced fallback: enabled (standalone port, CLI, and token pairing are available)",
			fallbackDisabled: "Advanced fallback: disabled; to use a standalone port or CLI, set enableFallback=true in the profile and restart DSH",
			logout: "Log out",
			expand: "Expand", collapse: "Collapse"
		};
		const FIELDS = [
			{ key: "proxy", kind: "text", label: T.proxyLabel, hint: T.proxyHint, placeholder: T.proxyPlaceholder },
			{ key: "noProxy", kind: "text", label: T.noProxyLabel, hint: T.noProxyHint, placeholder: "localhost,127.0.0.1,::1" },
			{ key: "mode", kind: "select", label: T.modeLabel, hint: T.modeHint, options: [["all", T.modeAll], ["allowlist", T.modeAllowlist]] },
			{ key: "allowProxy", kind: "text", label: T.allowProxyLabel, hint: T.allowProxyHint, placeholder: T.allowProxyPlaceholder },
			{ key: "hotkey", kind: "hotkey", label: T.hotkeyLabel, hint: T.hotkeyHint, placeholder: T.hotkeyPlaceholder },
			{ key: "showPill", kind: "bool", label: T.pillLabel, hint: T.pillHint },
			{ key: "announceToAgent", kind: "bool", label: T.guidanceLabel, hint: T.guidanceHint }
		];
		const SENSITIVE_FIELDS = new Set(["proxy", "noProxy", "mode", "allowProxy"]);
		/**
		 * Bridges the bound `proxy-toggle` settings scope onto the card: staged
		 * drafts in memory, per-field writes on save, read-back from the Host.
		 */
		var ProxyCardController = class {
			scope;
			store;
			saving = false;
			failedReason;
			testing = false;
			testResult = "";
			toggling = false;
			switchMsg = "";
			fieldNotice = "";
			authBusy = false;
			authMessage = "";
			authRequired = false;
			fallbackEnabled = false;
			runtime;
			runtimeAt = 0;
			runtimeTimer;
			runtimeRequest = 0;
			runtimeAbort;
			testAbort;
			switchAbort;
			actionGeneration = 0;
			disposed = false;
			staged = new Map();
			disposeScope;
			constructor(scope) {
				this.scope = scope;
				this.store = createSnapshotStore(this.projection());
				try {
					this.disposeScope = scope.subscribe(() => {
						if (this.disposed) return;
						this.refreshRuntime();
						this.store.set(this.projection());
					});
				} catch {}
				this.refreshRuntime();
				// Keep the runtime mirror live: toggles from the pill / hotkey /
				// another page must reach the card within one interval, or the
				// card would show a snapshot from page-load time forever.
				this.runtimeTimer = setInterval(() => {
					if (!this.disposed) this.refreshRuntime();
				}, 5000);
			}
			/** Runtime mirror of GET /vpn (throttled to at least 5s unless forced). */
			async refreshRuntime(force) {
				if (this.disposed || (this.authRequired && force !== true)) return;
				const now = Date.now();
				if (!force && now - this.runtimeAt < 5000) return;
				this.runtimeAt = now;
				const generation = ++this.runtimeRequest;
				if (this.runtimeAbort) this.runtimeAbort.abort();
				const controller = new AbortController();
				this.runtimeAbort = controller;
				const timeout = setTimeout(() => controller.abort(), 2500);
				try {
					const response = await fetch("/vpn", { credentials: "same-origin", signal: controller.signal });
					if (response.status === 401) {
						const detail = await response.json().catch(() => null);
						if (this.disposed || generation !== this.runtimeRequest) return;
						this.fallbackEnabled = detail?.fallbackEnabled === true;
						this.runtime = undefined;
						this.authRequired = true;
						this.authMessage = this.fallbackEnabled ? T.authorizationRequired : T.hostAuthorizationRequired;
						this.store.set(this.projection());
						return;
					}
					if (!response.ok) throw new Error("HTTP " + response.status);
					const next = await response.json();
					if (this.disposed || generation !== this.runtimeRequest) return;
					this.fallbackEnabled = next.fallbackEnabled === true;
					this.runtime = next;
					this.authRequired = false;
					this.authMessage = T.authorized;
				} catch {
					if (this.disposed || generation !== this.runtimeRequest) return;
					this.runtime = undefined;
				} finally {
					clearTimeout(timeout);
					if (this.runtimeAbort === controller) this.runtimeAbort = undefined;
				}
				if (!this.disposed && generation === this.runtimeRequest) this.store.set(this.projection());
			}
			dispose() {
				this.disposed = true;
				this.actionGeneration += 1;
				this.runtimeRequest += 1;
				if (this.runtimeAbort) this.runtimeAbort.abort();
				if (this.testAbort) this.testAbort.abort();
				if (this.switchAbort) this.switchAbort.abort();
				try {
					if (this.disposeScope) this.disposeScope();
				} catch {}
				try {
					if (this.runtimeTimer) clearInterval(this.runtimeTimer);
				} catch {}
			}
			snapshot() {
				try {
					return this.scope.getSnapshot();
				} catch {
					return { status: "unavailable" };
				}
			}
			valueForField(key) {
				if (SENSITIVE_FIELDS.has(key)) {
					if (!this.runtime || !Object.prototype.hasOwnProperty.call(this.runtime, key)) return undefined;
					return this.runtime[key];
				}
				return this.snapshot().value?.[key];
			}
			draftValue(key) {
				if (this.staged.has(key)) return this.staged.get(key);
				const value = this.valueForField(key);
				return typeof value === "boolean" ? !!value : value == null ? "" : String(value);
			}
			projection() {
				const snapshot = this.snapshot();
				const values = {};
				const drafts = {};
				for (const field of FIELDS) {
					const value = this.valueForField(field.key);
					values[field.key] = typeof value === "boolean" ? !!value : value == null ? "" : String(value);
					drafts[field.key] = this.draftValue(field.key);
				}
				let dirty = false;
				for (const field of FIELDS) if (drafts[field.key] !== values[field.key]) dirty = true;
				return {
					status: snapshot.status,
					available: snapshot.status === "ready",
					writable: snapshot.status === "ready" && snapshot.writable === true,
					values,
					drafts,
					dirty,
					saving: this.saving,
					failedReason: this.failedReason,
					testing: this.testing,
					testResult: this.testResult,
					toggling: this.toggling,
					switchMsg: this.switchMsg,
					fieldNotice: this.fieldNotice,
					authBusy: this.authBusy,
					authMessage: this.authMessage,
					fallbackEnabled: this.fallbackEnabled,
					runtime: this.runtime
				};
			}
			inject() {
				return {
					hooks: { proxyToggleCard: this.store },
					refreshRuntime: (force) => {
						this.refreshRuntime(force === true);
					},
					edit: (key, value) => {
						if (this.disposed) return;
						this.staged.set(key, value);
						this.failedReason = undefined;
						this.fieldNotice = "";
						this.store.set(this.projection());
					},
					notice: (text) => {
						if (this.disposed) return;
						this.fieldNotice = text || "";
						this.store.set(this.projection());
					},
					discard: () => {
						if (this.disposed) return;
						if (this.staged.size === 0 && this.failedReason === undefined) return;
						this.staged.clear();
						this.failedReason = undefined;
						this.fieldNotice = "";
						this.store.set(this.projection());
					},
					logout: async () => {
						if (this.disposed) return;
						try {
							await fetch("/vpn/logout", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(3000) });
						} catch {}
						if (this.disposed) return;
						this.runtime = undefined;
						this.authRequired = true;
						this.authMessage = "";
						this.store.set(this.projection());
					},
					renew: async () => {
						if (this.disposed || this.authBusy || this.runtime?.authMethod !== "session") return false;
						this.authBusy = true;
						this.authMessage = T.renewing;
						this.store.set(this.projection());
						try {
							const response = await fetch("/vpn/renew", { method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(5000) });
							if (response.status === 401) {
								this.runtime = undefined;
								this.authRequired = true;
								this.authMessage = this.fallbackEnabled ? T.authorizationRequired : T.hostAuthorizationRequired;
								return false;
							}
							if (!response.ok) throw new Error("HTTP " + response.status);
							this.authMessage = T.authorized;
							this.authRequired = false;
							await this.refreshRuntime(true);
							return true;
						} catch (cause) {
							if (!this.disposed) this.authMessage = T.authorizationRequired + " (" + (cause instanceof Error ? cause.message : String(cause)) + ")";
							return false;
						} finally {
							this.authBusy = false;
							if (!this.disposed) this.store.set(this.projection());
						}
					},
					pair: async (token) => {
						if (this.disposed || this.authBusy) return false;
						let credential = String(token ?? "").trim();
						if (credential === "") {
							this.authMessage = this.fallbackEnabled ? T.authorizationRequired : T.hostAuthorizationRequired;
							this.store.set(this.projection());
							return false;
						}
						this.authBusy = true;
						this.authMessage = T.authorizing;
						this.store.set(this.projection());
						try {
							const response = await fetch("/vpn/pair", {
								method: "POST",
								credentials: "same-origin",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ token: credential }),
								signal: AbortSignal.timeout(5000)
							});
							if (!response.ok) throw new Error("HTTP " + response.status);
							this.authMessage = T.authorized;
							this.authRequired = false;
							await this.refreshRuntime(true);
							return true;
						} catch (cause) {
							this.authRequired = true;
							if (!this.disposed) this.authMessage = T.authorizationRequired + " (" + (cause instanceof Error ? cause.message : String(cause)) + ")";
							return false;
						} finally {
							credential = "";
							this.authBusy = false;
							if (!this.disposed) this.store.set(this.projection());
						}
					},
					runTest: async () => {
						if (this.disposed || this.testing || this.toggling) return;
						const generation = ++this.actionGeneration;
						this.testing = true;
						this.testResult = "";
						this.store.set(this.projection());
						const controller = new AbortController();
						this.testAbort = controller;
						const timeout = setTimeout(() => controller.abort(), 15000);
						try {
							const response = await fetch("/vpn/test", { method: "POST", credentials: "same-origin", signal: controller.signal });
							const data = await response.json();
							if (response.status === 401) {
								this.runtime = undefined;
								this.authRequired = true;
								this.authMessage = this.fallbackEnabled ? T.authorizationRequired : T.hostAuthorizationRequired;
								return;
							}
							if (this.disposed || generation !== this.actionGeneration) return;
							if (data.ok && data.exitIp) {
								this.testResult = T.testExit(data.exitIp, data.latencyMs, data.via === "proxy" ? T.viaProxy : T.viaDirect) + (data.pending ? T.pendingSuffix : "");
							} else if (data.ok) {
								this.testResult = data.hint || T.proxyAlive;
							} else {
								this.testResult = T.testNotOk + (data.hint || data.stage || T.unknownReason);
							}
						} catch (cause) {
							if (!this.disposed && generation === this.actionGeneration) this.testResult = T.testErr + (cause instanceof Error ? cause.message : String(cause));
						} finally {
							clearTimeout(timeout);
							if (this.testAbort === controller) this.testAbort = undefined;
							this.testing = false;
							if (this.disposed || generation !== this.actionGeneration) return;
							this.store.set(this.projection());
						}
					},
					switchProxy: async (on) => {
						if (this.disposed || this.toggling || this.testing) return;
						const generation = ++this.actionGeneration;
						this.toggling = true;
						this.switchMsg = "";
						this.store.set(this.projection());
						const controller = new AbortController();
						this.switchAbort = controller;
						const timeout = setTimeout(() => controller.abort(), 8000);
						try {
							const response = await fetch("/vpn/" + (on ? "on" : "off"), { method: "POST", credentials: "same-origin", signal: controller.signal });
							const data = await response.json().catch(() => null);
							if (response.status === 401) {
								this.runtime = undefined;
								this.authRequired = true;
								this.authMessage = this.fallbackEnabled ? T.authorizationRequired : T.hostAuthorizationRequired;
								return;
							}
							if (this.disposed || generation !== this.actionGeneration) return;
							if (!response.ok) this.switchMsg = data && data.error ? data.error : "HTTP " + response.status;
						} catch (cause) {
							if (!this.disposed && generation === this.actionGeneration) this.switchMsg = T.switchFailed + (cause instanceof Error ? cause.message : String(cause));
						} finally {
							clearTimeout(timeout);
							if (this.switchAbort === controller) this.switchAbort = undefined;
							this.toggling = false;
							if (this.disposed || generation !== this.actionGeneration) return;
							this.runtimeAt = 0;
							await this.refreshRuntime();
						}
					},
					save: async () => {
						if (this.disposed) return;
						const snapshot = this.snapshot();
						if (this.saving || snapshot.status !== "ready") return;
						const projected = this.projection();
						const proxyDraft = normalizeUserProxy(this.draftValue("proxy"));
						if (!isValidProxy(proxyDraft)) {
							this.failedReason = T.invalidProxy;
							this.store.set(this.projection());
							return;
						}
						const sensitivePatch = {};
						const settingWrites = [];
						for (const field of FIELDS) {
							const draft = field.key === "proxy" ? proxyDraft : this.draftValue(field.key);
							if (draft === projected.values[field.key]) continue;
							if (SENSITIVE_FIELDS.has(field.key)) sensitivePatch[field.key] = draft;
							else settingWrites.push([field.key, draft]);
						}
						if (Object.keys(sensitivePatch).length === 0 && settingWrites.length === 0) return;
						this.saving = true;
						this.failedReason = undefined;
						this.fieldNotice = "";
						this.store.set(this.projection());
						try {
							if (Object.keys(sensitivePatch).length !== 0) {
								const response = await fetch("/vpn/proxy", {
									method: "POST",
									credentials: "same-origin",
									headers: { "content-type": "application/json" },
									body: JSON.stringify(sensitivePatch),
									signal: AbortSignal.timeout(10000)
								});
								const data = await response.json().catch(() => null);
								if (response.status === 401) {
									this.runtime = undefined;
									this.authRequired = true;
									this.authMessage = this.fallbackEnabled ? T.authorizationRequired : T.hostAuthorizationRequired;
								}
								if (!response.ok) throw new Error(data?.error || "HTTP " + response.status);
								await this.refreshRuntime(true);
								if (this.runtime === undefined) throw new Error(T.authorizationRequired);
								for (const key of Object.keys(sensitivePatch)) this.staged.delete(key);
							}
							for (const [key, value] of settingWrites) {
								if (this.disposed) return;
								await this.scope.set(key, value);
								if (this.disposed) return;
								const landed = this.scope.getSnapshot()?.value?.[key];
								if (landed !== value) throw new Error("setting was not accepted: " + key);
							}
							this.staged.clear();
						} catch (cause) {
							this.failedReason = cause instanceof Error ? cause.message : String(cause);
						} finally {
							this.saving = false;
							if (!this.disposed) this.store.set(this.projection());
						}
					}
				};
			}
		};
		//#endregion
		//#region card
		const S = {
			wrap: { border: "1px solid var(--dsw-alias-border-l2, #2b2f36)", background: "var(--dsw-alias-bg-layer-3, #17191d)", borderRadius: 12, padding: 0, margin: 0, listStyle: "none", overflow: "hidden", display: "block", width: "100%", boxSizing: "border-box" },
			header: { display: "flex", alignItems: "center", gap: 8, padding: "15px 16px", cursor: "pointer", background: "transparent", border: "none", width: "100%", textAlign: "left", font: "inherit", color: "inherit" },
			title: { fontSize: 14, fontWeight: 600, margin: 0, lineHeight: 1.45 },
			desc: { fontSize: 12, opacity: 0.65, margin: 0, marginTop: 5, lineHeight: 1.4 },
			body: { padding: "4px 16px 16px", display: "flex", flexDirection: "column", gap: 12 },
			label: { fontSize: 13, fontWeight: 600, display: "block", marginBottom: 4 },
			hint: { fontSize: 12, opacity: 0.6, marginTop: 4, lineHeight: 1.5 },
			input: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #2b2f36)", background: "var(--dsw-alias-bg-layer-2, #101215)", color: "inherit" },
			boolRow: { display: "flex", alignItems: "flex-start", gap: 10 },
			boolLabel: { fontSize: 13, fontWeight: 600 },
			actions: { display: "flex", alignItems: "center", gap: 10, marginTop: 4 },
			auth: { padding: "12px", border: "1px solid var(--dsw-alias-border-l2, #2b2f36)", borderRadius: 8, display: "flex", flexDirection: "column", gap: 8 },
			authInput: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #2b2f36)", background: "var(--dsw-alias-bg-layer-2, #101215)", color: "inherit" },
			button: { appearance: "none", font: "inherit", cursor: "pointer", background: "var(--dsw-alias-label-primary, #5b77ff)", color: "var(--dsw-alias-bg-layer-3, #101215)", border: "1px solid transparent", borderRadius: 8, padding: "6px 18px", fontSize: 13 },
			ghost: { appearance: "none", font: "inherit", cursor: "pointer", background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, #2b2f36)", borderRadius: 8, padding: "6px 14px", fontSize: 13 },
			note: { fontSize: 12, opacity: 0.6, margin: 0 },
			warn: { fontSize: 12, color: "var(--dsw-alias-label-warning, #e6a23c)", margin: 0, fontWeight: 600 },
			error: { fontSize: 12, color: "var(--dsw-alias-label-error, #e5484d)", margin: 0 }
		};
		function TextField(props) {
			return createElement("label", { style: { display: "block" } },
				createElement("span", { style: S.label }, props.field.label),
				createElement("input", {
					style: S.input,
					value: props.value,
					placeholder: props.field.placeholder || "",
					spellCheck: false,
					disabled: props.disabled,
					onChange: (event) => props.onEdit(props.field.key, event.target.value)
				}),
				createElement("span", { style: S.hint }, props.field.hint)
			);
		}
		function BoolField(props) {
			return createElement("div", { style: S.boolRow },
				createElement("input", {
					id: "proxy-toggle-" + props.field.key,
					type: "checkbox",
					checked: !!props.value,
					disabled: props.disabled,
					onChange: (event) => props.onEdit(props.field.key, event.target.checked)
				}),
				createElement("label", { htmlFor: "proxy-toggle-" + props.field.key, style: { display: "block", cursor: "pointer" } },
					createElement("span", { style: S.boolLabel }, props.field.label),
					createElement("span", { style: S.hint, display: "block" }, " — " + props.field.hint)
				)
			);
		}
		function SelectField(props) {
			return createElement("label", { style: { display: "block" } },
				createElement("span", { style: S.label }, props.field.label),
				createElement("select", {
					style: S.input,
					value: props.value,
					disabled: props.disabled,
					onChange: (event) => props.onEdit(props.field.key, event.target.value)
				},
					(props.field.options || []).map(([value, text]) => createElement("option", { key: value, value }, text))
				),
				createElement("span", { style: S.hint }, props.field.hint)
			);
		}
		function AuthPanel(props) {
			const authorized = props.state.runtime !== undefined;
			const sessionAuthorized = authorized && props.state.runtime.authMethod === "session";
			const fallbackAvailable = props.state.fallbackEnabled === true || props.state.runtime?.fallbackEnabled === true;
			if (authorized && props.state.runtime.authMethod === "host") return null;
			if (!authorized && props.state.fallbackEnabled === false) {
				if (!props.state.authRequired) return null;
				return createElement("div", { style: S.auth },
					createElement("span", { style: S.label }, T.authTitle),
					createElement("span", { style: S.hint }, props.state.authMessage || T.hostAuthorizationRequired)
				);
			}
			return createElement("div", { style: S.auth },
				createElement("span", { style: S.label }, T.authTitle),
				createElement("span", { style: S.hint }, authorized ? T.authorized : T.authHint),
				!authorized && fallbackAvailable ? createElement("input", { type: "password", autoComplete: "off", spellCheck: false, style: S.authInput, value: props.token, placeholder: T.authPlaceholder, disabled: props.state.authBusy, onChange: (event) => props.onToken(event.target.value) }) : null,
				createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
					!authorized && fallbackAvailable ? createElement("button", { type: "button", style: S.button, disabled: props.state.authBusy || props.token.trim() === "", onClick: props.onPair }, props.state.authBusy ? T.authorizing : T.authorize) : null,
					sessionAuthorized ? createElement("button", { type: "button", style: S.button, disabled: props.state.authBusy, onClick: props.onRenew }, props.state.authBusy ? T.renewing : T.renew) : null,
					authorized ? createElement("button", { type: "button", style: S.ghost, disabled: props.state.authBusy, onClick: props.onLogout }, T.logout) : null
				),
				props.state.authMessage && props.state.authMessage !== T.authorized ? createElement("span", { style: S.error }, props.state.authMessage) : null
			);
		}
		function FallbackStatus(props) {
			if (props.state.runtime === undefined) return null;
			return createElement("p", { style: S.note }, props.state.runtime.fallbackEnabled === true ? T.fallbackEnabled : T.fallbackDisabled);
		}
		//#region hotkey record
		// Keyboard-event -> Electron accelerator mapping. VERBATIM COPY of
		// codeToAccelerator/acceleratorFromEvent from lib/pure.js (the client
		// module is served as one self-contained script and cannot import) —
		// keep the two in sync; pure.js carries the unit tests.
		const MODIFIER_CODES = new Set([
			"ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight",
			"MetaLeft", "MetaRight", "OSLeft", "OSRight", "Fn", "FnLock"
		]);
		function codeToAccelerator(code) {
			if (typeof code !== "string" || code === "") return "";
			if (/^Key[A-Z]$/.test(code)) return code.slice(3);
			if (/^Digit[0-9]$/.test(code)) return code.slice(5);
			if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
			const named = {
				ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
				Space: "Space", Enter: "Return", NumpadEnter: "Return", Escape: "Esc",
				Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Tab: "Tab",
				CapsLock: "Capslock", NumLock: "Numlock", ScrollLock: "Scrolllock",
				Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Pause: "Pause",
				Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";",
				Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/", Backslash: "\\",
				Numpad0: "num0", Numpad1: "num1", Numpad2: "num2", Numpad3: "num3", Numpad4: "num4",
				Numpad5: "num5", Numpad6: "num6", Numpad7: "num7", Numpad8: "num8", Numpad9: "num9",
				NumpadAdd: "numadd", NumpadSubtract: "numsub", NumpadMultiply: "nummult",
				NumpadDivide: "numdiv", NumpadDecimal: "numdec"
			};
			return named[code] || "";
		}
		function acceleratorFromEvent(evnt) {
			const parts = [];
			if (evnt.ctrlKey) parts.push("Control");
			if (evnt.altKey) parts.push("Alt");
			if (evnt.shiftKey) parts.push("Shift");
			if (evnt.metaKey) parts.push("Super");
			const code = evnt.code || "";
			if (MODIFIER_CODES.has(code)) return { ok: false, reason: "modifier-only" };
			const base = codeToAccelerator(code);
			if (base === "") {
				return parts.length ? { ok: false, reason: "unsupported" } : { ok: false, reason: "modifier-only" };
			}
			const realMods = (evnt.ctrlKey ? 1 : 0) + (evnt.altKey ? 1 : 0) + (evnt.metaKey ? 1 : 0);
			if (realMods === 0) return { ok: false, reason: "need-modifier" };
			parts.push(base);
			return { ok: true, accelerator: parts.join("+") };
		}
		//#endregion
		//#region proxy url check
		// Keep in sync with pure.js normalizeUserProxy/isValidProxyUrl (client
		// cannot import): bare host:port normalizes to http://host:port; only
		// http(s)/socks5 schemes are storable; empty = auto mode.
		function normalizeUserProxy(raw) {
			const s = String(raw ?? "").trim();
			if (s === "") return "";
			if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
			if (/^\[[^\]]+\]:\d{1,5}$/.test(s)) return "http://" + s;
			const ipv6Port = s.match(/^(.+):(\d{1,5})$/);
			if (ipv6Port && ipv6Port[1].includes(":")) return "http://[" + ipv6Port[1] + "]:" + ipv6Port[2];
			if (/^[^\s/:]+:\d{1,5}$/.test(s)) return "http://" + s;
			return s;
		}
		function isValidProxy(normalized) {
			if (normalized === "") return true;
			try {
				const url = new URL(normalized);
				if (!(url.protocol === "http:" || url.protocol === "https:" || url.protocol === "socks5:") || url.hostname === "") return false;
				const pathOk = url.protocol === "socks5:" ? (url.pathname === "" || url.pathname === "/") : url.pathname === "/";
				if (url.username !== "" || url.password !== "" || !pathOk || url.search !== "" || url.hash !== "") return false;
				if (url.port !== "") {
					const port = Number(url.port);
					if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
				}
				return true;
			} catch {
				return false;
			}
		}
		function displayProxy(raw) {
			const value = String(raw || "");
			if (value === "") return "";
			try {
				if (!isValidProxy(value)) return "<configured proxy>";
				const url = new URL(value);
				url.username = "";
				url.password = "";
				url.search = "";
				url.hash = "";
				return url.toString();
			} catch {
				return value.includes("@") || value.includes("?") || value.includes("#") ? "<configured proxy>" : value;
			}
		}
		//#endregion
		/**
		 * Hotkey field: manual accelerator input + a record button that
		 * captures the next pressed combo and converts it to an accelerator
		 * string. Plain Escape cancels recording; combos need at least one
		 * of Control/Alt/Super (a bare global hotkey would swallow the key
		 * system-wide).
		 */
		function HotkeyField(props) {
			const inputRef = useRef(null);
			const [recording, setRecording] = useState(false);
			const startRecording = useCallback(() => {
				setRecording(true);
				setTimeout(() => {
					try {
						if (inputRef.current) inputRef.current.focus();
					} catch {}
				}, 0);
			}, []);
			const onKeyDown = useCallback((event) => {
				if (!recording) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
					setRecording(false);
					return;
				}
				const decision = acceleratorFromEvent(event);
				if (!decision.ok) {
					if (decision.reason === "need-modifier") props.onNotice(T.needModifier);
					else if (decision.reason === "unsupported") props.onNotice(T.unsupportedKey);
					// modifier-only: keep waiting silently
					return;
				}
				props.onEdit(props.field.key, decision.accelerator);
				setRecording(false);
			}, [recording, props.field.key, props.onEdit, props.onNotice]);
			const clear = useCallback(() => {
				props.onEdit(props.field.key, "");
			}, [props.field.key, props.onEdit]);
			return createElement("label", { style: { display: "block" } },
				createElement("span", { style: S.label }, props.field.label),
				createElement("input", {
					ref: inputRef,
					style: S.input,
					value: recording ? T.recordingPrompt : props.value,
					placeholder: props.field.placeholder || "",
					spellCheck: false,
					readOnly: recording,
					disabled: props.disabled,
					onKeyDown,
					onBlur: () => setRecording(false)
				}),
				createElement("span", { style: { display: "flex", gap: 8, marginTop: 6 } },
					createElement("button", { type: "button", style: S.ghost, disabled: props.disabled || recording, onClick: startRecording }, recording ? T.recording : T.record),
					createElement("button", { type: "button", style: S.ghost, disabled: props.disabled || !props.value, onClick: clear }, T.clearBtn)
				),
				createElement("span", { style: S.hint }, props.field.hint)
			);
		}
		/**
		 * Runtime on/off switch, placed BELOW the save actions so the card
		 * reads edit -> save -> toggle. Unlike the config fields it is NOT a
		 * settings draft: it reads live state from GET /vpn and acts
		 * immediately via POST /vpn/on|off (same-origin, same as the pill
		 * and the standalone page).
		 */
		function SwitchRow(props) {
			const rt = props.state.runtime;
			const on = !!(rt && rt.enabled);
			const face = Object.assign({}, S.button, {
				background: on ? "#2f9e44" : "var(--dsw-alias-bg-layer-2, #101215)",
				color: "#fff",
				border: on ? "1px solid #2f9e44" : "1px solid var(--dsw-alias-border-l2, #2b2f36)",
				minWidth: 168,
				textAlign: "center"
			});
			return createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 12px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2, #2b2f36)", background: on ? "rgba(47,158,68,.10)" : "transparent" } },
				createElement("button", {
					type: "button",
					style: face,
					disabled: props.toggling || props.testing || rt == null,
					onClick: () => props.onSwitch(!on)
				}, props.toggling ? T.switching : on ? T.onBtn : T.offBtn),
				createElement("span", { style: S.hint },
					rt == null ? T.readingRuntime : on ? T.walking + (displayProxy(rt.proxy) || T.unset) + T.modeTag + (rt.mode === "allowlist" ? T.modeShortList : T.modeShortAll) + (rt.note ? " · " + rt.note : "") : T.directNow,
					props.state.dirty ? createElement("span", { style: S.warn }, T.dirtySwitchHint) : null
				)
			);
		}
		/**
		 * Dynamic header line: current route (direct vs proxied, manual vs
		 * auto-detected) plus the active routing mode. Manual means the
		 * saved settings carry a proxy; auto means the host detected one.
		 */
		function describeRuntime(state) {
			const rt = state.runtime;
			const mode = state.values.mode === "allowlist" ? T.modeShortList : T.modeShortAll;
			let route;
			if (rt && rt.enabled) {
				const settingsProxy = state.values.proxy !== "" ? state.values.proxy : "";
				const runtimeOverride = rt.proxySource === "api";
				const manual = runtimeOverride || settingsProxy !== "";
				const proxy = runtimeOverride ? rt.proxy || T.unset : settingsProxy || rt.proxy || T.unset;
				route = T.via + displayProxy(proxy) + (manual ? T.manual : T.autoDetected);
			} else {
				route = T.directNow.slice(T.now.length);
			}
			return T.now + route + T.modeTag + mode;
		}
		/**
		 * The proxy-toggle settings card: registers into the `settings.plugin.item`
		 * slot keyed by the `proxy-toggle` settings namespace, dispatched by the
		 * plugin-configuration tab's served-namespace ledger.
		 */
		function ProxyToggleCard(props) {
			const state = props.useProxyToggleCard((snapshot) => snapshot);
			const [open, setOpen] = useState(false);
			const [authToken, setAuthToken] = useState("");
			const disabled = !state.writable || state.saving || state.runtime === undefined;
			const onSave = useCallback(() => {
				props.save();
			}, [props.save]);
			const onDiscard = useCallback(() => {
				props.discard();
			}, [props.discard]);
			const onTest = useCallback(() => {
				props.runTest();
			}, [props.runTest]);
			const onPair = useCallback(async () => {
				if (await props.pair(authToken)) setAuthToken("");
			}, [props.pair, authToken]);
			const onLogout = useCallback(() => {
				setAuthToken("");
				props.logout();
			}, [props.logout]);
			const onRenew = useCallback(() => {
				props.renew();
			}, [props.renew]);
			if (!state.available) return createElement("li", { style: S.wrap },
				createElement("div", { style: S.header }, createElement("div", { style: { flex: 1 } },
					createElement("p", { style: S.title }, T.title),
					createElement("p", { style: state.status === "loading" ? S.note : S.error }, state.status === "loading" ? T.settingsLoading : T.settingsUnavailable)
				)),
				createElement(AuthPanel, { state, token: authToken, onToken: setAuthToken, onPair, onRenew, onLogout })
			);
			return createElement("li", { style: S.wrap },
				createElement("button", {
					type: "button",
					style: S.header,
					onClick: () => {
						const next = !open;
						setOpen(next);
						// Expanding is exactly when fresh state matters: force one
						// immediate GET /vpn instead of waiting for the interval.
						if (next && props.refreshRuntime) props.refreshRuntime(true);
					},
					"aria-expanded": open
				},
					createElement("div", { style: { flex: 1 } },
						createElement("p", { style: S.title }, T.title),
						createElement("p", { style: S.desc }, describeRuntime(state))
					),
					createElement("span", { style: { opacity: 0.6, fontSize: 12 } }, open ? T.collapse : T.expand)
				),
				open ? createElement("div", { style: S.body },
					createElement(AuthPanel, { state, token: authToken, onToken: setAuthToken, onPair, onRenew, onLogout }),
					createElement(FallbackStatus, { state }),
					FIELDS.map((field) => field.kind === "text"
						? createElement(TextField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit })
						: field.kind === "select"
							? createElement(SelectField, { key: field.key, field, value: state.drafts[field.key] || "all", disabled, onEdit: props.edit })
							: field.kind === "hotkey"
								? createElement(HotkeyField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit, onNotice: props.notice })
								: createElement(BoolField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit })),
					createElement("div", { style: S.actions },
						createElement("button", { type: "button", style: S.button, disabled: state.runtime === undefined || !state.writable || state.saving || !state.dirty, onClick: onSave }, state.saving ? T.saving : T.save),
						createElement("button", { type: "button", style: S.ghost, disabled: state.runtime === undefined || state.testing || state.toggling, onClick: onTest }, state.testing ? T.testing : T.testConn),
						state.dirty || state.failedReason ? createElement("button", { type: "button", style: S.ghost, disabled: state.saving, onClick: onDiscard }, T.discard) : null,
						state.failedReason ? createElement("p", { style: S.error }, T.saveFailed + state.failedReason) : state.dirty ? createElement("p", { style: S.warn }, T.dirty) : createElement("p", { style: S.note }, T.saved),
						state.fieldNotice ? createElement("p", { style: S.note }, state.fieldNotice) : null
					),
					state.testResult ? createElement("p", { style: state.testResult.indexOf(T.testNotOk) === 0 || state.testResult.indexOf(T.testErr) === 0 ? S.error : S.note }, state.testResult) : null,
					// The switch sits BELOW save so the flow reads edit -> save ->
					// toggle; a draft can't be missed before toggling. With a dirty
					// draft the row also says the switch acts on the saved config.
					createElement(SwitchRow, { key: "switch", state, toggling: state.toggling, testing: state.testing, onSwitch: props.switchProxy }),
					state.switchMsg ? createElement("p", { style: S.error }, state.switchMsg) : null,
					state.values.hotkey ? createElement("p", { style: S.note }, state.runtime ? (state.runtime.hotkeyRegistered ? T.hotkeyOk(state.values.hotkey) : T.hotkeyBad(state.values.hotkey)) : T.hotkeyReading) : null,
					createElement("p", { style: S.note }, T.footer)
				) : null
			);
		}
		//#endregion
		//#region apply
		/** Services required by this client module. */
		const inject = ["slots", "settingsScope"];
		/**
		 * Mount the card. The plugin-configuration tab dispatches the
		 * settings.plugin.item slot keyed by the settings namespace the Host
		 * serves (the describe mirror ∩ registered cards), so the card claims the
		 * proxy-toggle namespace.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			let controller;
			ctx.effect(() => {
				try {
					const scope = (ctx.get("webUiSettings") ?? ctx.settingsScope).bind({ namespace: NS });
					controller = new ProxyCardController(scope);
					const disposeInject = ctx.slots.inject("settings.plugin.item", () => {
						try {
							return ctx.slots.register({
								name: "settings.plugin.item",
								key: NS,
								inject: () => controller.inject()
							}, ProxyToggleCard);
						} catch (error) {
							console.error("[proxy-toggle] slot register failed", error);
							return () => {};
						}
					});
					return () => {
						try {
							if (disposeInject) disposeInject();
						} catch {}
						try {
							if (controller) controller.dispose();
						} catch {}
					};
				} catch (error) {
					console.error("[proxy-toggle] client mount failed", error);
					try {
						if (controller) controller.dispose();
					} catch {}
					return () => {};
				}
			}, "proxy-toggle: settings card");
		}
		//#endregion
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
