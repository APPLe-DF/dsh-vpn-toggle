window.__ModuleLoader__.load({
	id: "dsh-vpn-toggle",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const { createElement, useState, useCallback } = react;
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
		const FIELDS = [
			{ key: "proxy", kind: "text", label: "代理地址", hint: "VPN 本地代理地址（http(s):// 或 socks5://，实测两者均经隧道）；留空则自动探测系统代理", placeholder: "留空自动探测，如 http://127.0.0.1:7897" },
			{ key: "noProxy", kind: "text", label: "绕过列表", hint: "不走代理的地址（逗号分隔）；优先级最高，命中即直连", placeholder: "localhost,127.0.0.1,::1" },
			{ key: "mode", kind: "select", label: "分流模式", hint: "全部流量 = 所有请求走 VPN；仅列表流量 = 只有命中 allowlist 的主机走 VPN（模型 API 直连 + web 抓取走 VPN）", options: [["all", "全部流量"], ["allowlist", "仅列表流量"]] },
			{ key: "allowProxy", kind: "text", label: "代理 allowlist", hint: "allowlist 模式下走 VPN 的主机（逗号分隔，支持 .example.com 后缀）；仅 allowlist 模式生效，留空则全部直连", placeholder: "api.ipify.org,.github.com" },
			{ key: "hotkey", kind: "text", label: "全局热键", hint: "Electron accelerator（如 Control+Alt+V）；留空则不启用", placeholder: "留空则不启用" },
			{ key: "showPill", kind: "bool", label: "悬浮按钮", hint: "在 Web GUI 右下角显示 VPN 开关胶囊" },
			{ key: "announceToAgent", kind: "bool", label: "agent 指引", hint: "向 agent 会话注入 VPN 开关使用指引" }
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
			runtime;
			runtimeAt = 0;
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
			}
			/** Runtime mirror of GET /vpn (throttled to at least 5s). */
			async refreshRuntime() {
				const now = Date.now();
				if (now - this.runtimeAt < 5000) return;
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
					runtime: this.runtime
				};
			}
			inject() {
				return {
					hooks: { vpnToggleCard: this.store },
					edit: (key, value) => {
						this.staged.set(key, value);
						this.failedReason = undefined;
						this.store.set(this.projection());
					},
					discard: () => {
						if (this.staged.size === 0 && this.failedReason === undefined) return;
						this.staged.clear();
						this.failedReason = undefined;
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
								? "出口 " + data.exitIp + " · " + data.latencyMs + "ms · " + (data.via === "proxy" ? "经代理" : "直连")
								: "测试未通过：" + (data.hint || data.stage || "未知原因");
						} catch (cause) {
							this.testResult = "测试失败：" + (cause instanceof Error ? cause.message : String(cause));
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
							this.switchMsg = "切换失败：" + (cause instanceof Error ? cause.message : String(cause));
						}
						this.toggling = false;
						this.runtimeAt = 0;
						await this.refreshRuntime();
					},
					save: async () => {
						const snapshot = this.snapshot();
						if (this.saving || snapshot.status !== "ready") return;
						const writes = [];
						for (const field of FIELDS) {
							const draft = this.draftValue(field.key);
							if (draft !== this.projection().values[field.key]) writes.push([field.key, draft]);
						}
						if (writes.length === 0) return;
						this.saving = true;
						this.failedReason = undefined;
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
			wrap: { border: "1px solid var(--dsw-alias-border-l2, #2b2f36)", background: "var(--dsw-alias-bg-layer-3, #17191d)", borderRadius: 12, padding: 0, margin: 0, listStyle: "none", overflow: "hidden" },
			header: { display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", cursor: "pointer", background: "transparent", border: "none", width: "100%", textAlign: "left", font: "inherit", color: "inherit" },
			title: { fontSize: 14, fontWeight: 600, margin: 0 },
			desc: { fontSize: 12, opacity: 0.65, margin: 0 },
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
		/**
		 * Runtime on/off switch, first row of the expanded card. Unlike the
		 * config fields it is NOT a settings draft: it reads live state from
		 * GET /vpn and acts immediately via POST /vpn/on|off (same-origin,
		 * same as the pill and the standalone page).
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
				}, props.toggling ? "切换中…" : on ? "已开启 · 点击关闭" : "已关闭 · 点击开启"),
				createElement("span", { style: S.hint },
					rt == null ? "读取运行状态中…" : on ? "DSH 正在走 VPN：" + (rt.proxy || "(未设置)") + " · 模式：" + (rt.mode === "allowlist" ? "仅列表" : "全部流量") : "当前直连")
			);
		}
		/**
		 * Dynamic header line: current route (direct vs proxied, manual vs
		 * auto-detected) plus the active routing mode. Manual means the
		 * saved settings carry a proxy; auto means the host detected one.
		 */
		function describeRuntime(state) {
			const rt = state.runtime;
			const mode = state.values.mode === "allowlist" ? "仅列表" : "全部流量";
			let route;
			if (rt && rt.enabled) {
				const manual = state.values.proxy !== "";
				const proxy = manual ? state.values.proxy : rt.proxy || "(未设置)";
				route = "经 " + proxy + (manual ? "（手动设置）" : "（自动探测）");
			} else {
				route = "直连";
			}
			return "当前：" + route + " · 模式：" + mode;
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
				createElement("button", { style: S.header, onClick: () => setOpen(!open), "aria-expanded": open },
					createElement("div", { style: { flex: 1 } },
						createElement("p", { style: S.title }, "VPN 开关"),
						createElement("p", { style: S.desc }, describeRuntime(state))
					),
					createElement("span", { style: { opacity: 0.6, fontSize: 12 } }, open ? "收起" : "展开")
				),
				open ? createElement("div", { style: S.body },
					createElement(SwitchRow, { key: "switch", state, toggling: state.toggling, onSwitch: props.switchVpn }),
					state.switchMsg ? createElement("p", { style: S.error }, state.switchMsg) : null,
					FIELDS.map((field) => field.kind === "text"
						? createElement(TextField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit })
						: field.kind === "select"
							? createElement(SelectField, { key: field.key, field, value: state.drafts[field.key] || "all", disabled, onEdit: props.edit })
							: createElement(BoolField, { key: field.key, field, value: state.drafts[field.key], disabled, onEdit: props.edit })),
					createElement("div", { style: S.actions },
						createElement("button", { style: S.button, disabled: !state.writable || state.saving || !state.dirty, onClick: onSave }, state.saving ? "保存中…" : "保存"),
						createElement("button", { style: S.ghost, disabled: state.testing, onClick: onTest }, state.testing ? "测试中…" : "测试连通性"),
						state.dirty || state.failedReason ? createElement("button", { style: S.ghost, disabled: state.saving, onClick: onDiscard }, "撤销") : null,
						state.failedReason ? createElement("p", { style: S.error }, "保存失败：" + state.failedReason) : state.dirty ? createElement("p", { style: S.note }, "有未保存的修改") : createElement("p", { style: S.note }, "已保存")
					),
					state.testResult ? createElement("p", { style: state.testResult.indexOf("测试未通过") === 0 || state.testResult.indexOf("测试失败") === 0 ? S.error : S.note }, state.testResult) : null,
					createElement("p", { style: S.note }, "运行状态见右下角悬浮按钮；开关即时生效，修改代理地址后同样即时被下一个请求读取。")
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
