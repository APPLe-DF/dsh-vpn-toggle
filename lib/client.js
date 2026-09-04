window.__ModuleLoader__.load({
	id: "dsh-vpn-toggle",
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
		const NS = "vpn-toggle";
		// Card language: follow the renderer locale (navigator.language). In the
		// Electron window this mirrors the app/system language; in an external
		// browser it follows that browser. Falls back to English.
		const LANG_ZH = (navigator.language || "en").toLowerCase().indexOf("zh") === 0;
		const T = LANG_ZH ? {
			title: "VPN 开关",
			proxyLabel: "代理地址",
			proxyHint: "VPN 本地代理地址（http(s):// 或 socks5://，实测两者均经隧道）；留空 = 自动模式，插件自动探测并可在端口失效时自动切换",
			proxyPlaceholder: "留空自动探测，如 http://127.0.0.1:7897",
			invalidProxy: "代理地址必须是 http(s):// 或 socks5:// URL",
			noProxyLabel: "绕过列表",
			noProxyHint: "不走代理的地址（逗号分隔）；优先级最高，命中即直连",
			modeLabel: "分流模式",
			modeHint: "全部流量 = 所有请求走 VPN；仅列表流量 = 只有命中 allowlist 的主机走 VPN（模型 API 直连 + web 抓取走 VPN）",
			modeAll: "全部流量",
			modeAllowlist: "仅列表流量",
			allowProxyLabel: "代理 allowlist",
			allowProxyHint: "allowlist 模式下走 VPN 的主机（逗号分隔，支持 .example.com 后缀）；仅 allowlist 模式生效，留空则全部直连",
			allowProxyPlaceholder: "api.ipify.org,.github.com",
			hotkeyLabel: "全局热键",
			hotkeyHint: "点击「录制组合键」后直接按键自动识别（Esc 取消），或手动填 Electron accelerator（如 Control+Alt+V）；留空则不启用",
			hotkeyPlaceholder: "留空则不启用，如 Control+Alt+V",
			record: "录制组合键", recording: "录制中…", recordingPrompt: "按下组合键…（Esc 取消）", clearBtn: "清除",
			needModifier: "至少需要 Control / Alt / Super 之一——纯字母或 Shift+键做全局热键会占掉整个系统的这个键",
			unsupportedKey: "这个键不能用作热键，换一个组合",
			pillLabel: "悬浮按钮", pillHint: "在 Web GUI 右下角显示 VPN 开关胶囊",
			guidanceLabel: "agent 指引", guidanceHint: "向 agent 会话注入 VPN 开关使用指引",
			save: "保存", saving: "保存中…", testConn: "测试连通性", testing: "测试中…", discard: "撤销",
			saveFailed: "保存失败：", dirty: "● 有未保存的修改，记得保存", saved: "已保存",
			dirtySwitchHint: " · 上方有未保存的修改，开关按已保存配置执行",
			switching: "切换中…", onBtn: "已开启 · 点击关闭", offBtn: "已关闭 · 点击开启",
			readingRuntime: "读取运行状态中…", walking: "DSH 正在走 VPN：",
			unset: "(未设置)", directNow: "当前：直连", now: "当前：", via: "经 ",
			manual: "（手动设置）", autoDetected: "（自动探测）",
			modeShortAll: "全部流量", modeShortList: "仅列表", modeTag: " · 模式：",
			switchFailed: "切换失败：",
			testExit: (ip, ms, via) => `出口 ${ip} · ${ms}ms · ${via}`,
			testNotOk: "测试未通过：", testErr: "测试失败：", unknownReason: "未知原因",
			viaProxy: "经代理", viaDirect: "直连",
			hotkeyOk: (k) => `热键 ${k} 已注册生效。`,
			hotkeyBad: (k) => `热键 ${k} 注册失败（可能被其他程序占用），换一个组合或清除后保存。`,
			hotkeyReading: "热键注册状态读取中…",
			footer: "运行状态见右下角悬浮按钮；开关即时生效，修改代理地址后同样即时被下一个请求读取。",
			expand: "展开", collapse: "收起"
		} : {
			title: "VPN Toggle",
			proxyLabel: "Proxy address",
			proxyHint: "Local VPN proxy address (http(s):// or socks5://, both tested); leave empty for auto mode - the plugin detects the system proxy and can switch ports automatically when one dies",
			proxyPlaceholder: "Leave empty to auto-detect, e.g. http://127.0.0.1:7897",
			invalidProxy: "The proxy address must be an http(s):// or socks5:// URL",
			noProxyLabel: "Bypass list",
			noProxyHint: "Hosts that never go through the proxy (comma separated); highest priority - a hit stays direct",
			modeLabel: "Routing mode",
			modeHint: "All traffic = every request goes through VPN; Allowlist only = only hosts matching the list go through VPN (model API direct + web scraping via VPN)",
			modeAll: "All traffic",
			modeAllowlist: "Allowlist only",
			allowProxyLabel: "Proxy allowlist",
			allowProxyHint: "Hosts tunneled in allowlist mode (comma separated, .example.com suffix works); only effective in allowlist mode, empty = nothing proxied",
			allowProxyPlaceholder: "api.ipify.org,.github.com",
			hotkeyLabel: "Global hotkey",
			hotkeyHint: "Click Record combo then press it to capture (Esc cancels), or type an Electron accelerator such as Control+Alt+V; empty = disabled",
			hotkeyPlaceholder: "Empty = disabled, e.g. Control+Alt+V",
			record: "Record combo", recording: "Recording…", recordingPrompt: "Press the key combo… (Esc to cancel)", clearBtn: "Clear",
			needModifier: "Needs at least one of Control / Alt / Super - a bare letter or Shift+key as a GLOBAL hotkey would swallow that key system-wide",
			unsupportedKey: "That key cannot be used as a hotkey, try another combo",
			pillLabel: "Floating pill", pillHint: "Show the VPN toggle pill in the bottom-right corner of the Web GUI",
			guidanceLabel: "Agent guidance", guidanceHint: "Inject VPN toggle usage guidance into agent sessions",
			save: "Save", saving: "Saving…", testConn: "Test connectivity", testing: "Testing…", discard: "Discard",
			saveFailed: "Save failed: ", dirty: "● Unsaved changes - remember to save", saved: "Saved",
			dirtySwitchHint: " · Unsaved changes above - the switch applies the SAVED config",
			switching: "Switching…", onBtn: "ON · click to turn off", offBtn: "OFF · click to turn on",
			readingRuntime: "Reading runtime state…", walking: "DSH is using VPN: ",
			unset: "(not set)", directNow: "Now: direct", now: "Now: ", via: "via ",
			manual: " (manual)", autoDetected: " (auto-detected)",
			modeShortAll: "All traffic", modeShortList: "Allowlist", modeTag: " · mode: ",
			switchFailed: "Switch failed: ",
			testExit: (ip, ms, via) => `Exit ${ip} · ${ms}ms · ${via}`,
			testNotOk: "Test did not pass: ", testErr: "Test error: ", unknownReason: "unknown reason",
			viaProxy: "via proxy", viaDirect: "direct",
			hotkeyOk: (k) => `Hotkey ${k} is registered and active.`,
			hotkeyBad: (k) => `Hotkey ${k} registration FAILED (probably taken by another app) - pick another combo or clear and save.`,
			hotkeyReading: "Reading hotkey registration state…",
			footer: "Runtime also shows in the bottom-right pill; the switch takes effect immediately, and a changed proxy address is picked up by the next request.",
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
		/**
		 * Bridges the bound `vpn-toggle` settings scope onto the card: staged
		 * drafts in memory, per-field writes on save, read-back from the Host.
		 */
		var VpnCardController = class {
			scope;
			store;
			saving = false;
			failedReason;
			testing = false;
			testResult = "";
			toggling = false;
			switchMsg = "";
			fieldNotice = "";
			runtime;
			runtimeAt = 0;
			runtimeTimer;
			staged = new Map();
			disposeScope;
			constructor(scope) {
				this.scope = scope;
				this.store = createSnapshotStore(this.projection());
				try {
					this.disposeScope = scope.subscribe(() => {
						this.refreshRuntime();
						this.store.set(this.projection());
					});
				} catch {}
				this.refreshRuntime();
				// Keep the runtime mirror live: toggles from the pill / hotkey /
				// another page must reach the card within one interval, or the
				// card would show a snapshot from page-load time forever.
				this.runtimeTimer = setInterval(() => {
					this.refreshRuntime();
				}, 5000);
			}
			/** Runtime mirror of GET /vpn (throttled to at least 5s unless forced). */
			async refreshRuntime(force) {
				const now = Date.now();
				if (!force && now - this.runtimeAt < 5000) return;
				this.runtimeAt = now;
				try {
					const response = await fetch("/vpn", { signal: AbortSignal.timeout(2500) });
					if (response.ok) this.runtime = await response.json();
				} catch {
					this.runtime = undefined;
				}
				this.store.set(this.projection());
			}
			dispose() {
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
			draftValue(key) {
				if (this.staged.has(key)) return this.staged.get(key);
				const value = this.snapshot().value?.[key];
				return typeof value === "boolean" ? !!value : value == null ? "" : String(value);
			}
			projection() {
				const snapshot = this.snapshot();
				const values = {};
				const drafts = {};
				for (const field of FIELDS) {
					const value = snapshot.value?.[field.key];
					values[field.key] = typeof value === "boolean" ? !!value : value == null ? "" : String(value);
					drafts[field.key] = this.draftValue(field.key);
				}
				let dirty = false;
				for (const field of FIELDS) if (drafts[field.key] !== values[field.key]) dirty = true;
				return {
					available: snapshot.status !== "loading",
					writable: snapshot.writable !== false,
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
					runtime: this.runtime
				};
			}
			inject() {
				return {
					hooks: { vpnToggleCard: this.store },
					refreshRuntime: (force) => {
						this.refreshRuntime(force === true);
					},
					edit: (key, value) => {
						this.staged.set(key, value);
						this.failedReason = undefined;
						this.fieldNotice = "";
						this.store.set(this.projection());
					},
					notice: (text) => {
						this.fieldNotice = text || "";
						this.store.set(this.projection());
					},
					discard: () => {
						if (this.staged.size === 0 && this.failedReason === undefined) return;
						this.staged.clear();
						this.failedReason = undefined;
						this.fieldNotice = "";
						this.store.set(this.projection());
					},
					runTest: async () => {
						if (this.testing) return;
						this.testing = true;
						this.testResult = "";
						this.store.set(this.projection());
						try {
							const response = await fetch("/vpn/test", { method: "POST", signal: AbortSignal.timeout(9000) });
							const data = await response.json();
							this.testResult = data.ok
								? T.testExit(data.exitIp, data.latencyMs, data.via === "proxy" ? T.viaProxy : T.viaDirect)
								: T.testNotOk + (data.hint || data.stage || T.unknownReason);
						} catch (cause) {
							this.testResult = T.testErr + (cause instanceof Error ? cause.message : String(cause));
						}
						this.testing = false;
						this.store.set(this.projection());
					},
					switchVpn: async (on) => {
						if (this.toggling) return;
						this.toggling = true;
						this.switchMsg = "";
						this.store.set(this.projection());
						try {
							const response = await fetch("/vpn/" + (on ? "on" : "off"), { method: "POST", signal: AbortSignal.timeout(8000) });
							const data = await response.json().catch(() => null);
							if (!response.ok) this.switchMsg = data && data.error ? data.error : "HTTP " + response.status;
						} catch (cause) {
							this.switchMsg = T.switchFailed + (cause instanceof Error ? cause.message : String(cause));
						}
						this.toggling = false;
						this.runtimeAt = 0;
						await this.refreshRuntime();
					},
					save: async () => {
						const snapshot = this.snapshot();
						if (this.saving || snapshot.status !== "ready") return;
						const proxyDraft = this.draftValue("proxy");
						if (proxyDraft !== "" && !isValidProxyUrl(proxyDraft)) {
							this.failedReason = T.invalidProxy;
							this.store.set(this.projection());
							return;
						}
						const writes = [];
						for (const field of FIELDS) {
							const draft = this.draftValue(field.key);
							if (draft !== this.projection().values[field.key]) writes.push([field.key, draft]);
						}
						if (writes.length === 0) return;
						this.saving = true;
						this.failedReason = undefined;
						this.fieldNotice = "";
						this.store.set(this.projection());
						try {
							for (const [key, value] of writes) await this.scope.set(key, value);
							this.staged.clear();
						} catch (cause) {
							this.failedReason = cause instanceof Error ? cause.message : String(cause);
						}
						this.saving = false;
						this.store.set(this.projection());
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
					type: "checkbox",
					checked: !!props.value,
					disabled: props.disabled,
					onChange: (event) => props.onEdit(props.field.key, event.target.checked)
				}),
				createElement("label", { style: { display: "block", cursor: "pointer" } },
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
		// Keep in sync with pure.js isValidProxyUrl (client cannot import):
		// only http(s):// and socks5:// URLs are storable; empty = auto mode.
		function isValidProxyUrl(raw) {
			const s = String(raw ?? "").trim();
			if (s === "") return true;
			try {
				const url = new URL(s);
				return (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "socks5:") && url.hostname !== "";
			} catch {
				return false;
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
					createElement("button", { style: S.ghost, disabled: props.disabled || recording, onClick: startRecording }, recording ? T.recording : T.record),
					createElement("button", { style: S.ghost, disabled: props.disabled || !props.value, onClick: clear }, T.clearBtn)
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
					style: face,
					disabled: props.toggling || rt == null,
					onClick: () => props.onSwitch(!on)
				}, props.toggling ? T.switching : on ? T.onBtn : T.offBtn),
				createElement("span", { style: S.hint },
					rt == null ? T.readingRuntime : on ? T.walking + (rt.proxy || T.unset) + T.modeTag + (rt.mode === "allowlist" ? T.modeShortList : T.modeShortAll) + (rt.note ? " · " + rt.note : "") : T.directNow,
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
				const manual = state.values.proxy !== "";
				const proxy = manual ? state.values.proxy : rt.proxy || T.unset;
				route = T.via + proxy + (manual ? T.manual : T.autoDetected);
			} else {
				route = T.directNow.slice(T.now.length);
			}
			return T.now + route + T.modeTag + mode;
		}
		/**
		 * The vpn-toggle settings card: registers into the `settings.plugin.item`
		 * slot keyed by the `vpn-toggle` settings namespace, dispatched by the
		 * plugin-configuration tab's served-namespace ledger.
		 */
		function VpnToggleCard(props) {
			const state = props.useVpnToggleCard((snapshot) => snapshot);
			const [open, setOpen] = useState(false);
			const disabled = !state.writable || state.saving;
			const onSave = useCallback(() => {
				props.save();
			}, [props.save]);
			const onDiscard = useCallback(() => {
				props.discard();
			}, [props.discard]);
			const onTest = useCallback(() => {
				props.runTest();
			}, [props.runTest]);
			return createElement("li", { style: S.wrap },
				createElement("button", {
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
					FIELDS.map((field) => field.kind === "text"
						? createElement(TextField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit })
						: field.kind === "select"
							? createElement(SelectField, { key: field.key, field, value: state.drafts[field.key] || "all", disabled, onEdit: props.edit })
							: field.kind === "hotkey"
								? createElement(HotkeyField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit, onNotice: props.notice })
								: createElement(BoolField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit })),
					createElement("div", { style: S.actions },
						createElement("button", { style: S.button, disabled: !state.writable || state.saving || !state.dirty, onClick: onSave }, state.saving ? T.saving : T.save),
						createElement("button", { style: S.ghost, disabled: state.testing, onClick: onTest }, state.testing ? T.testing : T.testConn),
						state.dirty || state.failedReason ? createElement("button", { style: S.ghost, disabled: state.saving, onClick: onDiscard }, T.discard) : null,
						state.failedReason ? createElement("p", { style: S.error }, T.saveFailed + state.failedReason) : state.dirty ? createElement("p", { style: S.warn }, T.dirty) : createElement("p", { style: S.note }, T.saved),
						state.fieldNotice ? createElement("p", { style: S.note }, state.fieldNotice) : null
					),
					state.testResult ? createElement("p", { style: state.testResult.indexOf(T.testNotOk) === 0 || state.testResult.indexOf(T.testErr) === 0 ? S.error : S.note }, state.testResult) : null,
					// The switch sits BELOW save so the flow reads edit -> save ->
					// toggle; a draft can't be missed before toggling. With a dirty
					// draft the row also says the switch acts on the saved config.
					createElement(SwitchRow, { key: "switch", state, toggling: state.toggling, onSwitch: props.switchVpn }),
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
		 * vpn-toggle namespace.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			let controller;
			ctx.effect(() => {
				try {
					const scope = (ctx.get("webUiSettings") ?? ctx.settingsScope).bind({ namespace: NS });
					controller = new VpnCardController(scope);
					const disposeInject = ctx.slots.inject("settings.plugin.item", () => {
						try {
							return ctx.slots.register({
								name: "settings.plugin.item",
								key: NS,
								inject: () => controller.inject()
							}, VpnToggleCard);
						} catch (error) {
							console.error("[vpn-toggle] slot register failed", error);
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
					console.error("[vpn-toggle] client mount failed", error);
					return () => {};
				}
			}, "vpn-toggle: settings card");
		}
		//#endregion
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
