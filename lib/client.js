window.__ModuleLoader__.load({
	id: "dsh-ctx-visualizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react_jsx_runtime = require("react/jsx-runtime");
		const react = require("react");

		//#region constants
		const SLOT_ID = "ctx-visualizer";
		/**
		 * Hand-written TypertRemoteContribution matching the host's SRC-marked
		 * `ctxVisualizer` service. Strict string codecs describe business ids;
		 * captured results retain the host SRC JSON contract.
		 */
		const ID_CODEC = Object.freeze({
			mode: "strict",
			typeSymbol: "dsh-ctx-visualizer#ContextId",
			create: () => ({ parse(value) {
				if (typeof value !== "string") throw new TypeError("Context id must be a string");
				return value;
			} }),
		});
		const CONTRIBUTION = {
			package: "dsh-ctx-visualizer",
			descriptors: [
				{
					id: "dsh-ctx-visualizer#ctxVisualizer/listSessions",
					service: "ctxVisualizer",
					namespace: "ctxVisualizer",
					method: "listSessions",
					invocation: { kind: "direct" },
					parameters: [],
					cancellation: { parameter: "signal" },
					result: { mode: "src-json" },
				},
				{
					id: "dsh-ctx-visualizer#ctxVisualizer/listSteps",
					service: "ctxVisualizer",
					namespace: "ctxVisualizer",
					method: "listSteps",
					invocation: { kind: "direct" },
					parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: ID_CODEC }],
					cancellation: { parameter: "signal" },
					result: { mode: "src-json" },
				},
				{
					id: "dsh-ctx-visualizer#ctxVisualizer/getStep",
					service: "ctxVisualizer",
					namespace: "ctxVisualizer",
					method: "getStep",
					invocation: { kind: "direct" },
					parameters: [
						{ name: "sessionId", wire: "sessionId", source: "json", codec: ID_CODEC },
						{ name: "stepId", wire: "stepId", source: "json", codec: ID_CODEC },
					],
					cancellation: { parameter: "signal" },
					result: { mode: "src-json" },
				},
				{
					id: "dsh-ctx-visualizer#ctxVisualizer/backfill",
					service: "ctxVisualizer",
					namespace: "ctxVisualizer",
					method: "backfill",
					invocation: { kind: "direct" },
					parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: ID_CODEC }],
					cancellation: { parameter: "signal" },
					result: { mode: "src-json" },
				},
				{
					id: "dsh-ctx-visualizer#ctxVisualizer/clearStore",
					service: "ctxVisualizer",
					namespace: "ctxVisualizer",
					method: "clearStore",
					invocation: { kind: "direct" },
					parameters: [],
					cancellation: { parameter: "signal" },
					result: { mode: "src-json" },
				},
			],
		};
		//#endregion

		//#region helpers
		function h(type, props, ...children) {
			const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true);
			const merged = { ...(props ?? {}) };
			if (flat.length === 1) merged.children = flat[0];
			else if (flat.length > 1) merged.children = flat;
			const key = typeof merged.key === "string" || typeof merged.key === "number" ? String(merged.key) : undefined;
			delete merged.key;
			// Spread children are static: jsxs tells React they need no keys.
			return flat.length > 1 ? react_jsx_runtime.jsxs(type, merged, key) : react_jsx_runtime.jsx(type, merged, key);
		}
		function fmtTime(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "–";
			const d = new Date(ms);
			const pad = (n, w = 2) => String(n).padStart(w, "0");
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		}
		function fmtDuration(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms)) return "–";
			if (ms < 1000) return `${Math.round(ms)}ms`;
			return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
		}
		function fmtChars(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return "–";
			if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
			if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(Math.abs(n) >= 10_000 ? 0 : 1)}k`;
			return String(n);
		}
		function blockText(blocks) {
			if (!Array.isArray(blocks)) return "";
			return blocks.map((block) => {
				if (block?.type === "text") return block.text ?? "";
				if (block?.type === "reasoning") return block.text ?? "";
				if (block?.type === "tool-call") return `[工具调用 ${block.name} · id=${block.id}]\n${typeof block.arguments === "string" ? block.arguments : pretty(block.arguments ?? {})}`;
				if (block?.type === "tool-result") return `[工具结果 →${block.toolCallId}${block.isError ? " · 出错" : ""}]\n${blockText(block.content)}`;
				if (block?.type === "image") return `[图片 ${block.attachment?.id ?? JSON.stringify(block.attachment)?.slice(0, 80) ?? ""}]`;
				if (block?.type === "file") return `[文件 ${block.attachment?.name ?? ""}]`;
				return `[${block?.type ?? "unknown"}] ${JSON.stringify(block)?.slice(0, 400) ?? ""}`;
			}).join("\n");
		}
		function pretty(value) {
			try { return JSON.stringify(value, null, 2) ?? "null"; } catch (error) { return String(error); }
		}
		function finishLabel(reason) {
			if (typeof reason === "string") return reason;
			if (!reason) return "–";
			const labels = { stop: "正常结束", "tool-calls": "调用工具", length: "达到长度上限", aborted: "已取消", error: "失败" };
			return labels[reason.kind] ?? reason.kind ?? pretty(reason);
		}
		function unwrap(result) {
			if (!result?.ok) throw new Error(result?.error?.message ?? "RPC 未返回成功结果");
			return result.value;
		}
		function isMcpTool(name) {
			return typeof name === "string" && (name.startsWith("mcp") || name.includes("__mcp__") || /(^|__)mcp/i.test(name));
		}
		async function copyText(text) {
			try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
		}
		//#endregion

		//#region style
		let styleInjected = false;
		function injectStyle() {
			if (styleInjected || typeof document === "undefined") return;
			styleInjected = true;
			const style = document.createElement("style");
			style.textContent = `
.cv-root{font-size:12.5px;line-height:1.55;display:flex;flex-direction:column;height:100%;min-height:0;color:inherit}
.cv-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid rgba(127,127,127,.25)}
.cv-title{font-weight:700;font-size:13px}
.cv-badge{max-width:100%;overflow-wrap:anywhere;display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;border:1px solid rgba(127,127,127,.35);font-size:11px;white-space:normal}
.cv-badge.ok{border-color:rgba(60,160,90,.5);color:rgb(60,160,90)}
.cv-badge.warn{border-color:rgba(200,140,20,.55);color:rgb(200,140,20)}
.cv-badge.err{border-color:rgba(200,70,70,.55);color:rgb(200,70,70)}
.cv-badge.dim{opacity:.75}
.cv-btn{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;padding:2px 9px;cursor:pointer;font-size:12px}
.cv-btn:hover{background:rgba(127,127,127,.12)}
.cv-select{border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;padding:2px 6px;font-size:12px;max-width:340px}
.cv-pipeline{display:flex;gap:6px;align-items:stretch;padding:8px 10px 0;flex-wrap:wrap}
.cv-stage{flex:1 1 190px;min-width:170px;border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:6px 9px;background:rgba(127,127,127,.06)}
.cv-stage .cv-stage-label{font-weight:600}
.cv-stage .cv-stage-detail{opacity:.8;font-size:11.5px;margin-top:2px;white-space:pre-wrap;word-break:break-word}
.cv-stage.active{border-color:rgba(80,140,255,.7);box-shadow:0 0 0 1px rgba(80,140,255,.35) inset}
.cv-main{display:flex;flex:1;min-height:0;border-top:1px solid rgba(127,127,127,.25)}
.cv-steps{width:230px;flex:0 0 auto;overflow:auto;border-right:1px solid rgba(127,127,127,.25);padding:6px}
.cv-step{border:1px solid rgba(127,127,127,.28);border-radius:8px;padding:5px 8px;margin-bottom:6px;cursor:pointer}
.cv-step:hover{background:rgba(127,127,127,.1)}
.cv-step.sel{border-color:rgba(80,140,255,.8);background:rgba(80,140,255,.08)}
.cv-step-head{display:flex;gap:6px;align-items:baseline;justify-content:space-between}
.cv-step-model{min-width:0;overflow-wrap:anywhere;font-weight:600;font-size:12px}
.cv-step-sub{opacity:.75;font-size:11px;margin-top:1px;white-space:pre-wrap}
.cv-detail{flex:1;min-width:0;display:flex;flex-direction:column}
.cv-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:6px 10px 0;border-bottom:1px solid rgba(127,127,127,.25)}
.cv-tab{border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;padding:3px 12px;cursor:pointer;opacity:.75;background:transparent;color:inherit;font-size:12.5px}
.cv-tab.sel{border-color:rgba(127,127,127,.35);background:rgba(127,127,127,.08);opacity:1}
.cv-body{flex:1;overflow:auto;padding:10px 12px;min-height:0}
.cv-section{margin-bottom:14px}
.cv-section-head{width:100%;border:0;background:transparent;color:inherit;text-align:left;font:inherit;display:flex;gap:8px;align-items:center;flex-wrap:wrap;cursor:pointer;user-select:none;padding:4px 0;font-weight:600}
.cv-count{opacity:.7;font-weight:400;font-size:11.5px}
.cv-pre{white-space:pre-wrap;word-break:break-word;border:1px solid rgba(127,127,127,.25);border-radius:8px;padding:8px 10px;margin:4px 0 0;background:rgba(127,127,127,.05);overflow:auto;max-height:420px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.8px}
.cv-pre.open{max-height:none}
.cv-msg{border:1px solid rgba(127,127,127,.25);border-radius:8px;margin-top:8px;overflow:hidden}
.cv-msg-head{display:flex;gap:6px;align-items:center;padding:4px 9px;background:rgba(127,127,127,.07);border-bottom:1px solid rgba(127,127,127,.18);font-size:11.5px;flex-wrap:wrap}
.cv-msg-body{padding:0}
.cv-toolcard{border:1px solid rgba(127,127,127,.3);border-radius:8px;margin-top:8px;overflow:hidden}
.cv-toolcard-head{display:flex;gap:7px;align-items:center;padding:5px 9px;background:rgba(127,127,127,.07);flex-wrap:wrap}
.cv-kv{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;opacity:.85}
.cv-empty{opacity:.7;padding:24px;text-align:center}
.cv-err{color:rgb(200,70,70)}
.cv-copy{font-size:11px}
.cv-summary-wrap{overflow-x:auto}
.cv-summary{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
.cv-summary th,.cv-summary td{padding:6px 10px;text-align:left;vertical-align:top;border-bottom:1px solid rgba(127,127,127,.16);overflow-wrap:anywhere}
.cv-summary th{font-weight:600;background:rgba(127,127,127,.06)}
.cv-summary th:nth-child(1){width:48px}.cv-summary th:nth-child(2){width:100px}.cv-summary th:nth-child(4){width:110px}
.cv-summary td:last-child{white-space:nowrap;font-variant-numeric:tabular-nums}
.cv-summary{min-width:480px}
.cv-btn:disabled{opacity:.5;cursor:default}
.cv-tab:focus-visible,.cv-step:focus-visible,.cv-section-head:focus-visible{outline:2px solid #508cff;outline-offset:2px}
@media(max-width:800px){.cv-steps{width:180px}.cv-stage{min-width:140px}.cv-tab{padding:5px 8px}}
@media(max-width:560px){.cv-main{flex-direction:column}.cv-steps{width:auto;max-height:180px;border-right:0;border-bottom:1px solid rgba(127,127,127,.25)}.cv-select{max-width:100%}}

.cv-delta-up{color:rgb(200,140,20)}
.cv-delta-down{color:rgb(60,160,90)}
.cv-summary th:nth-child(5){width:64px}
.cv-bar{display:flex;width:100%;border-radius:3px;overflow:hidden;background:rgba(127,127,127,.12);margin-top:4px}
.cv-bar>span{display:block;height:100%;min-width:1px}
.cv-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:11.5px}
.cv-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.cv-seg{display:inline-flex;border:1px solid rgba(127,127,127,.35);border-radius:7px;overflow:hidden;margin:2px 0 12px}
.cv-seg button{border:none;background:transparent;color:inherit;padding:3px 12px;cursor:pointer;font-size:12px}
.cv-seg button.sel{background:rgba(80,140,255,.16);font-weight:600}
.cv-seg button:disabled{opacity:.45;cursor:not-allowed}
.cv-search{width:100%;box-sizing:border-box;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;border-radius:6px;padding:4px 8px;font-size:12px;margin:4px 0}
.cv-group-title{font-weight:600;font-size:11.5px;opacity:.8;margin:4px 0}
.cv-msg.new{border-color:rgba(200,140,20,.6);box-shadow:0 0 0 1px rgba(200,140,20,.2) inset}
.cv-group{margin-bottom:10px}
.cv-group-head{display:flex;gap:6px;align-items:baseline;padding:2px 2px 4px;font-size:12px;min-width:0}
.cv-group-quote{opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.cv-timeline{padding:8px 10px 6px}
.cv-tl-head{display:flex;gap:8px;align-items:baseline;font-weight:600;margin-bottom:6px;min-width:0}
.cv-tl-quote{font-weight:400;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.cv-tl-track{display:flex;align-items:center;gap:0;overflow-x:auto;padding-bottom:4px}
.cv-tl-node{flex:0 0 auto;min-width:130px;text-align:left;border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:5px 9px;background:rgba(127,127,127,.05);color:inherit;cursor:pointer;font-size:12px}
.cv-tl-node:hover{background:rgba(127,127,127,.12)}
.cv-tl-node.sel{border-color:rgba(80,140,255,.85);box-shadow:0 0 0 1px rgba(80,140,255,.4) inset}
.cv-tl-node.err{border-color:rgba(200,70,70,.6)}
.cv-tl-title{font-weight:600}
.cv-tl-sub{opacity:.75;font-size:11px}
.cv-tl-edge{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;padding:0 8px;font-size:11px;max-width:220px}
.cv-tl-edge-label{color:rgb(200,140,20);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px}
.cv-tl-arrow{opacity:.7;white-space:nowrap;border-top:1px dashed rgba(127,127,127,.6);padding-top:1px;margin-top:2px}
.cv-turn{border:1px solid rgba(127,127,127,.28);border-radius:8px;padding:6px 9px;margin-bottom:6px;cursor:pointer}
.cv-turn:hover{background:rgba(127,127,127,.08)}
.cv-turn.sel{border-color:rgba(80,140,255,.85);background:rgba(80,140,255,.07);box-shadow:0 0 0 1px rgba(80,140,255,.3) inset}
.cv-turn-head{display:flex;justify-content:space-between;align-items:baseline;gap:6px}
.cv-turn-quote{opacity:.8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:1px 0 2px}
.cv-turn-meta{display:flex;flex-wrap:wrap;gap:3px 8px;align-items:center;font-size:11px;opacity:.8;margin-top:4px}
.cv-turn-tools{font-size:11px;opacity:.65;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace}
.cv-arch{display:flex;gap:14px;align-items:flex-start;min-width:0}
.cv-arch-col{flex:1;min-width:0}
.cv-arch-col.narrow{flex:0 0 250px;position:sticky;top:0}
.cv-arch-title{font-weight:700;margin-bottom:8px}
.cv-arch-layer{border:1px solid rgba(127,127,127,.25);border-left:4px solid;border-radius:8px;padding:7px 10px;margin-bottom:8px;background:rgba(127,127,127,.03)}
.cv-arch-layer-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:5px}
.cv-arch-outline{display:flex;flex-wrap:wrap;gap:4px}
.cv-arch-chip{display:inline-flex;gap:5px;align-items:baseline;border:1px solid rgba(127,127,127,.3);border-radius:5px;padding:1px 7px;font-size:11.5px;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cv-arch-chip em{font-style:normal;opacity:.6;font-size:10.5px}
.cv-arch-chip.l1{font-weight:600;border-color:rgba(124,108,240,.55)}
.cv-arch-chip.l2{border-color:rgba(124,108,240,.35)}
.cv-arch-chip.l3{opacity:.8}
.cv-arch-chip.dup{border-style:dashed;color:rgb(200,140,20)}
.cv-arch-chip.mcp{border-color:rgba(200,140,20,.6)}
.cv-arch-seg{border:1px solid rgba(127,127,127,.2);border-radius:7px;margin-top:6px;overflow:hidden}
.cv-arch-seg.new{border-color:rgba(200,140,20,.55)}
.cv-arch-seg-head{display:flex;gap:7px;align-items:center;padding:4px 8px;background:rgba(127,127,127,.06);cursor:pointer;font-size:12px;min-width:0}
.cv-arch-seg-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.85}
.cv-arch-chain{display:flex;flex-wrap:wrap;gap:5px 3px;align-items:center;padding:7px 8px}
.cv-arch-item{display:inline-flex;align-items:center;gap:5px;border:1px solid;border-radius:6px;padding:2px 7px 2px 5px;font-size:11.5px;max-width:300px;background:rgba(127,127,127,.03)}
.cv-arch-item i{display:inline-block;height:6px;border-radius:3px;opacity:.85;flex:none}
.cv-arch-item b{font-weight:600;flex:none}
.cv-arch-item span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.cv-arch-item em{font-style:normal;opacity:.55;font-size:10.5px;flex:none}
.cv-arch-item.new{box-shadow:0 0 0 2px rgba(200,140,20,.35)}
.cv-arch-arrow{opacity:.45;font-size:11px}
.cv-arch-gap{opacity:.6;font-size:11px;padding:0 6px}
.cv-flow-node{border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:6px 9px;background:rgba(127,127,127,.04)}
.cv-flow-node.model{border-color:rgba(74,144,217,.7);background:rgba(74,144,217,.07)}
.cv-flow-node.err{border-color:rgba(200,70,70,.7)}
.cv-flow-node.end{border-color:rgba(60,160,90,.6);color:rgb(60,160,90)}
.cv-flow-node.next{border-style:dashed}
.cv-flow-arrow{text-align:center;opacity:.5;line-height:18px}
.cv-flow-call{border:1px solid rgba(224,144,42,.55);border-radius:7px;padding:4px 8px;margin-bottom:5px;font-size:12px}
.cv-flow-call.ok{border-color:rgba(60,160,90,.55)}
.cv-flow-call.err{border-color:rgba(200,70,70,.65)}
@media (max-width:900px){.cv-arch{flex-direction:column}.cv-arch-col.narrow{flex:none;width:100%;position:static}}
.cv-json{border:1px solid rgba(127,127,127,.25);border-radius:8px;margin-bottom:8px;overflow:hidden}
.cv-json.lvl1{margin:6px 0 0;border-color:rgba(127,127,127,.2)}
.cv-json.lvl2{margin:5px 0 0;border-color:rgba(127,127,127,.16)}
.cv-json-head{display:flex;align-items:center;gap:7px;padding:5px 9px;cursor:pointer;background:rgba(127,127,127,.06);min-width:0}
.cv-json.lvl1>.cv-json-head{background:rgba(127,127,127,.04)}
.cv-json.lvl2>.cv-json-head{background:transparent;font-size:12px}
.cv-json-head:hover{background:rgba(127,127,127,.11)}
.cv-json-caret{width:10px;opacity:.7}
.cv-json-desc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}
.cv-json-children{padding:0 8px 8px 16px}
.cv-json-pre{margin:0;border:none;border-top:1px solid rgba(127,127,127,.18);border-radius:0;max-height:70vh}
.cv-tl-end{flex:0 0 auto;padding:0 10px;font-size:11.5px;color:rgb(60,160,90);white-space:nowrap}
`;
			document.head.appendChild(style);
		}
		//#endregion

		//#region atoms
		function Badge({ kind = "", children, title }) {
			return h("span", { className: `cv-badge ${kind}`, title }, children);
		}
		function Pre({ text, openDefault = false, maxHeight }) {
			const [open, setOpen] = react.useState(openDefault);
			const [copied, setCopied] = react.useState(false);
			if (text === undefined || text === null || text === "") return h("div", { className: "cv-count", style: { padding: "4px 2px" } }, "（空）");
			const expandable = text.length > 400 || text.split("\n").length > 8;
			return h("div", null,
				h("div", { style: { display: "flex", gap: 6, marginTop: 4 } },
					expandable ? h("button", {
						className: "cv-btn cv-copy", onClick: () => setOpen(!open),
					}, open ? "收起" : `展开（${fmtChars(text.length)} 字符）`) : null,
					h("button", {
						className: "cv-btn cv-copy", onClick: async () => {
							setCopied(await copyText(text) ? "success" : "error"); setTimeout(() => setCopied(false), 1200);
						},
					}, copied === "success" ? "已复制 ✓" : copied === "error" ? "复制失败" : "复制"),
				),
				h("pre", { className: `cv-pre${open ? " open" : ""}`, style: { maxHeight: open ? "none" : (maxHeight ?? 180) } }, text),
			);
		}
		function Section({ title, meta, children, openDefault = true }) {
			const [open, setOpen] = react.useState(openDefault);
			return h("div", { className: "cv-section" },
				h("button", { type: "button", className: "cv-section-head", "aria-expanded": open, onClick: () => setOpen(!open) },
					h("span", null, open ? "▾ " : "▸ ", title),
					meta ? h("span", { className: "cv-count" }, meta) : null,
				),
				open ? children : null,
			);
		}
		function Delta({ value }) {
			if (value === null || value === undefined) return h("span", { className: "cv-count" }, "·");
			const cls = value > 0 ? "cv-delta-up" : value < 0 ? "cv-delta-down" : "cv-count";
			const text = value > 0 ? `+${fmtChars(value)}` : value < 0 ? `−${fmtChars(-value)}` : "±0";
			return h("span", { className: cls, title: "较上一步请求体积变化" }, text);
		}
		//#endregion

		//#region request sections
		function MessageCard({ message, isNew = false }) {
			const source = message?.source ?? {};
			let originLabel = source.kind ?? "unknown";
			let badgeKind = "dim";
			if (originLabel === "user") { originLabel = "用户输入"; badgeKind = "ok"; }
			else if (originLabel === "tool") { originLabel = `工具结果${source.name ? ` · ${source.name}` : ""}${source.callId ? ` · ${source.callId}` : ""}`; badgeKind = ""; }
			else if (originLabel === "plugin") { originLabel = `插件注入 · ${source.plugin ?? "?"}${source.form ? ` · ${source.form}` : ""}`; badgeKind = "warn"; }
			else if (originLabel === "model") { originLabel = `模型输出 · ${source.provider ?? ""}${source.model ? `/${source.model}` : ""}`; badgeKind = ""; }
			return h("div", { className: `cv-msg${isNew ? " new" : ""}` },
				h("div", { className: "cv-msg-head" },
					isNew ? h(Badge, { kind: "warn" }, "本步新增") : null,
					h(Badge, { kind: badgeKind }, originLabel),
					h("span", { className: "cv-count" }, `role=${message.role} · ${fmtChars(JSON.stringify(message.content ?? []).length)} 字符`),
					source.id ? h("span", { className: "cv-count" }, `id=${String(source.id).slice(0, 12)}`) : null,
				),
				h("div", { className: "cv-msg-body", style: { padding: "6px 9px" } },
					h(Pre, { text: blockText(message.content) }),
				),
			);
		}

		function ToolSchemaRow({ tool }) {
			const [open, setOpen] = react.useState(false);
			const desc = typeof tool.description === "string" ? tool.description : "";
			return h("div", { className: "cv-toolcard" },
				h("div", { className: "cv-toolcard-head" },
					h("strong", null, tool.name),
					isMcpTool(tool.name) ? h(Badge, { kind: "warn", title: "名字形态像 MCP 工具" }, "MCP?") : null,
					h("button", { className: "cv-btn cv-copy", onClick: () => setOpen(!open) }, open ? "收起 schema" : "schema"),
				),
				h("div", { style: { padding: "5px 9px 7px" } },
					h("div", { className: "cv-count", style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }, open ? desc : desc.length > 200 ? desc.slice(0, 200) + "…" : desc),
					open ? h(Pre, { text: pretty(tool), openDefault: false }) : null,
				),
			);
		}

		//#region context buckets
		const BUCKETS = [
			["system", "System", "#7c6cf0"],
			["userInput", "用户输入", "#2fa36b"],
			["toolResult", "工具结果", "#e0902a"],
			["injection", "插件注入", "#d35d8c"],
			["assistant", "Assistant 历史", "#4a90d9"],
			["tools", "工具 schema", "#8a8f98"],
		];
		function bucketOf(message) {
			if (message?.role === "system") return "system";
			if (message?.role === "assistant") return "assistant";
			const kind = message?.source?.kind;
			if (kind === "user") return "userInput";
			if (kind === "tool" || message?.role === "tool") return "toolResult";
			return "injection";
		}
		function bucketLabel(key) {
			return BUCKETS.find(([k]) => k === key)?.[1] ?? key;
		}
		function messageKey(message) {
			return message?.cvKey ?? (message?.id !== undefined ? String(message.id) : undefined);
		}
		/** Token counts from provider usage, tolerant of field naming. */
		function usageTokens(usage) {
			if (!usage || typeof usage !== "object") return null;
			const pick = (...names) => { for (const n of names) if (typeof usage[n] === "number") return usage[n]; return undefined; };
			const input = pick("input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
			const output = pick("output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens");
			const cacheRead = pick("cacheRead", "cacheReadTokens", "cache_read_input_tokens", "cachedTokens", "prompt_cache_hit_tokens");
			const cacheWrite = pick("cacheWrite", "cacheWriteTokens", "cache_creation_input_tokens");
			if (input === undefined && output === undefined) return null;
			// DSH TokenUsage.inputTokens is the UNCACHED part only; the full prompt
			// is uncached + cache-read + cache-write (or total − output).
			const total = pick("totalTokens", "total_tokens");
			const summed = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
			const prompt = typeof total === "number" && typeof output === "number" && total - output >= summed ? total - output : summed;
			return { input: prompt, uncached: input, output, cacheRead, cacheWrite };
		}
		function TokenBadges({ usage }) {
			const t = usageTokens(usage);
			if (!t) return h(Badge, { kind: "dim", title: "provider 未返回 usage" }, "tokens: –");
			return h(react.Fragment ?? "span", null,
				t.input !== undefined ? h(Badge, { title: `输入 tokens（含缓存）· 其中未命中缓存 ${t.uncached ?? "?"}` }, `输入 ${fmtChars(t.input)} tok`) : null,
				t.output !== undefined ? h(Badge, { kind: "dim", title: "输出 tokens" }, `输出 ${fmtChars(t.output)} tok`) : null,
				t.cacheRead ? h(Badge, { kind: "ok", title: "缓存命中 tokens" }, `缓存命中 ${fmtChars(t.cacheRead)}${t.input ? `（${Math.round((t.cacheRead / t.input) * 100)}%）` : ""}`) : null,
				t.cacheWrite ? h(Badge, { kind: "dim", title: "写入缓存 tokens" }, `写缓存 ${fmtChars(t.cacheWrite)}`) : null,
			);
		}
		/** Stacked bar of request size by bucket. `scale` lets rows share one axis. */
		function BreakdownBar({ breakdown, scale, height = 8, legend = false }) {
			if (!breakdown) return null;
			const total = BUCKETS.reduce((sum, [k]) => sum + (breakdown[k] ?? 0), 0);
			const denom = Math.max(scale ?? total, 1);
			return h("div", null,
				h("div", { className: "cv-bar", style: { height }, title: BUCKETS.map(([k, label]) => `${label}: ${fmtChars(breakdown[k] ?? 0)}`).join("\n") },
					BUCKETS.map(([k, label, color]) => (breakdown[k] ?? 0) > 0
						? h("span", { key: k, style: { width: `${((breakdown[k] ?? 0) / denom) * 100}%`, background: color } })
						: null),
				),
				legend ? h("div", { className: "cv-legend" },
					BUCKETS.map(([k, label, color]) => h("span", { key: k },
						h("i", { style: { background: color } }),
						`${label} ${fmtChars(breakdown[k] ?? 0)}`,
						total > 0 ? h("span", { className: "cv-count" }, ` ${Math.round(((breakdown[k] ?? 0) / total) * 100)}%`) : null,
					)),
				) : null,
			);
		}
		//#endregion

		//#region request tab
		/** `mcp__server__tool` / `server__tool` → server; otherwise built-in. */
		function toolGroup(name) {
			if (typeof name !== "string") return "内置";
			const parts = name.split("__");
			if (parts[0] === "mcp" && parts.length >= 3) return `MCP · ${parts[1]}`;
			if (parts.length >= 2) return `MCP · ${parts[0]}`;
			return "内置";
		}

		function ToolsSection({ tools, unchanged }) {
			const [query, setQuery] = react.useState("");
			const [open, setOpen] = react.useState(!unchanged);
			const groups = new Map();
			for (const tool of tools) {
				const group = toolGroup(tool.name);
				if (!groups.has(group)) groups.set(group, []);
				groups.get(group).push(tool);
			}
			const q = query.trim().toLowerCase();
			const matches = (tool) => q === "" || String(tool.name).toLowerCase().includes(q) || String(tool.description ?? "").toLowerCase().includes(q);
			const groupSummary = [...groups.entries()].map(([g, list]) => `${g} ${list.length}`).join(" · ");
			return h("div", { className: "cv-section" },
				h("div", { className: "cv-section-head", onClick: () => setOpen(!open) },
					h("span", null, open ? "▾ " : "▸ ", "Tools（本次请求携带的工具清单）"),
					h("span", { className: "cv-count" }, `${tools.length} 个 · ${groupSummary}`),
					unchanged ? h(Badge, { kind: "ok" }, "与上一步相同") : unchanged === false ? h(Badge, { kind: "warn" }, "较上一步有变化") : null,
				),
				open ? h("div", null,
					h("input", { className: "cv-search", placeholder: "按工具名或描述过滤…", value: query, onChange: (e) => setQuery(e.target.value) }),
					tools.length === 0 ? h("div", { className: "cv-count" }, "本请求未携带工具") :
						[...groups.entries()].map(([group, list]) => {
							const visible = list.filter(matches);
							if (visible.length === 0) return null;
							return h("div", { key: group, style: { marginTop: 8 } },
								h("div", { className: "cv-group-title" }, `${group}（${visible.length}${visible.length !== list.length ? `/${list.length}` : ""}）`),
								visible.map((t) => h(ToolSchemaRow, { key: t.name, tool: t })),
							);
						}),
				) : null,
			);
		}

		function SystemSection({ system, oneShot, summary }) {
			const unchanged = summary?.systemChanged === false;
			const [open, setOpen] = react.useState(!unchanged);
			const chars = summary?.breakdown?.system;
			return h("div", { className: "cv-section" },
				h("div", { className: "cv-section-head", onClick: () => setOpen(!open) },
					h("span", null, open ? "▾ " : "▸ ", "System content（系统内容）"),
					h("span", { className: "cv-count" }, `${system.length + oneShot.length} 条 · ${fmtChars(chars)} 字符`),
					unchanged ? h(Badge, { kind: "ok" }, "与上一步相同") : summary?.systemChanged === true ? h(Badge, { kind: "warn" }, "较上一步有变化") : null,
				),
				open ? (system.length + oneShot.length === 0
					? h("div", { className: "cv-count" }, "本请求没有系统内容")
					: [...system, ...oneShot].map((m, index) => h(MessageCard, { key: `sys-${index}`, message: m }))) : null,
			);
		}

		function RequestTab({ record, summary }) {
			const messages = record.request.messages ?? [];
			const hasBase = Array.isArray(summary?.newMessageIds) && summary?.systemChanged !== null && summary?.systemChanged !== undefined;
			const [mode, setMode] = react.useState(hasBase ? "delta" : "full");
			const system = messages.filter((m) => m.role === "system");
			const oneShot = record.request.system ? [{ role: "system", content: [{ type: "text", text: record.request.system }], source: { kind: "plugin", plugin: "独立 system 字段" } }] : [];
			const nonSystem = messages.filter((m) => m.role !== "system");
			const newSet = new Set(summary?.newMessageIds ?? []);
			const added = nonSystem.filter((m) => newSet.has(messageKey(m)));
			const carried = nonSystem.length - added.length;
			const tools = record.request.tools ?? [];
			const byBucket = (key) => nonSystem.filter((m) => bucketOf(m) === key);
			const listOf = (list, empty) => list.length === 0 ? h("div", { className: "cv-count" }, empty) : list.map((m, index) => h(MessageCard, { key: `${messageKey(m) ?? "m"}-${index}`, message: m, isNew: hasBase && newSet.has(messageKey(m)) }));
			return h("div", null,
				h("div", { className: "cv-kv", style: { marginBottom: 8 } },
					record.origin === "reconstructed" ? h(Badge, { kind: "warn", title: "由会话日志重放上下文变化得到，与当时发给模型的消息一致；文件附件等在请求中被投影成文本的部分可能显示为原始块" }, "按会话日志重建") : null,
					h(Badge, null, `${record.model ?? "?"} · ${record.provider ?? "?"}`),
					h(TokenBadges, { usage: record.response?.usage }),
					h(Badge, { kind: "dim" }, `≈ ${fmtChars(record.request.approxChars)} 字符 · ${messages.length} 条消息`),
					summary?.deltaChars !== null && summary?.deltaChars !== undefined ? h("span", null, "较上一步 ", h(Delta, { value: summary.deltaChars })) : null,
					record.request.temperature !== undefined ? h(Badge, { kind: "dim" }, `temp=${record.request.temperature}`) : null,
					record.request.maxTokens !== undefined ? h(Badge, { kind: "dim" }, `max_tokens=${record.request.maxTokens}`) : null,
				),
				h("div", { className: "cv-section" },
					h("div", { className: "cv-count", style: { marginBottom: 4 } }, "上下文构成（按字符估算）"),
					h(BreakdownBar, { breakdown: summary?.breakdown, height: 14, legend: true }),
				),
				h("div", { className: "cv-seg", role: "tablist" },
					h("button", { className: mode === "delta" ? "sel" : "", disabled: !hasBase, title: hasBase ? "" : "本步是本会话首个主循环调用，没有可对比的上一步", onClick: () => setMode("delta") }, `本步新增${hasBase ? `（${added.length}）` : ""}`),
					h("button", { className: mode === "full" ? "sel" : "", onClick: () => setMode("full") }, `完整上下文（${messages.length}）`),
				),
				h(SystemSection, { system, oneShot, summary }),
				mode === "delta"
					? h("div", null,
						h("div", { className: "cv-section" },
							h("div", { className: "cv-section-head", style: { cursor: "default" } },
								h("span", null, "本步新进入上下文的消息"),
								h("span", { className: "cv-count" }, `${added.length} 条新增 · ${carried} 条沿用上一步${summary?.droppedCount ? ` · ${summary.droppedCount} 条较上一步被移除（可能被压缩/裁剪）` : ""}`),
							),
							added.length === 0
								? h("div", { className: "cv-count" }, "没有新增消息")
								: added.map((m, index) => h(MessageCard, { key: `${messageKey(m) ?? "m"}-${index}`, message: m, isNew: true })),
						),
					)
					: h("div", null,
						h(Section, { title: "User content · 用户输入", meta: `${byBucket("userInput").length} 条` }, listOf(byBucket("userInput"), "无")),
						h(Section, { title: "User content · 工具结果回填", meta: `${byBucket("toolResult").length} 条`, openDefault: false }, listOf(byBucket("toolResult"), "无（首步通常没有）")),
						h(Section, { title: "User content · 插件 / 系统注入", meta: `${byBucket("injection").length} 条`, openDefault: false }, listOf(byBucket("injection"), "无")),
						h(Section, { title: "Assistant 历史（发给模型的上文）", meta: `${byBucket("assistant").length} 条`, openDefault: false }, listOf(byBucket("assistant"), "无")),
						h(Section, { title: "按发送顺序逐条（来源溯源）", meta: `${nonSystem.length} 条`, openDefault: false },
							h("div", { className: "cv-summary-wrap" },
								h("table", { className: "cv-summary", "aria-label": "消息来源摘要" },
									h("thead", null, h("tr", null, ["#", "类别", "来源", "字符", ""].map((label) => h("th", { key: label || "n", scope: "col" }, label)))),
									h("tbody", null, messages.map((m, index) => h("tr", { key: index },
										h("td", null, index + 1),
										h("td", null, bucketLabel(bucketOf(m))),
										h("td", null, record.request.messageSummaries?.[index]?.origin ?? "未知"),
										h("td", null, fmtChars(JSON.stringify(m.content ?? []).length)),
										h("td", null, hasBase && m.role !== "system" && newSet.has(messageKey(m)) ? h(Badge, { kind: "warn" }, "新增") : null),
									))),
								),
							),
						),
					),
				h(ToolsSection, { key: summary?.id, tools, unchanged: summary?.toolsChanged === false ? true : summary?.toolsChanged === true ? false : undefined }),
			);
		}
		//#endregion

		//#region architecture tab
		/** Section titles found in system text: markdown headings and top-level XML-ish tags. */
		function systemOutline(messages) {
			const out = [];
			const seen = new Set();
			for (const message of messages) {
				const text = blockText(message.content);
				const lines = text.split("\n");
				let current = null;
				for (const line of lines) {
					const heading = /^(#{1,3})\s+(.{1,80})/.exec(line);
					const tag = /^<([a-zA-Z][\w-]{1,40})(\s[^>]*)?>\s*$/.exec(line.trim());
					const title = heading ? heading[2].trim() : tag ? `<${tag[1]}>` : null;
					if (title) {
						const key = `${heading ? heading[1].length : 1}:${title}`;
						current = { title, level: heading ? heading[1].length : 1, chars: 0, dup: seen.has(key) };
						seen.add(key);
						out.push(current);
					} else if (current) current.chars += line.length + 1;
				}
			}
			return out;
		}

		/** Split non-system history into segments, each opened by a human input. */
		function historySegments(messages) {
			const segments = [];
			let current = null;
			for (const message of messages) {
				if (message.role === "system") continue;
				const bucket = bucketOf(message);
				if (bucket === "userInput" || current === null) {
					current = { items: [], opener: bucket === "userInput" ? message : null };
					segments.push(current);
				}
				current.items.push(message);
			}
			return segments;
		}

		const ITEM_STYLE = {
			userInput: ["#2fa36b", "用户"],
			assistant: ["#4a90d9", "模型"],
			toolResult: ["#e0902a", "结果"],
			injection: ["#d35d8c", "注入"],
		};

		function sizeWidth(chars) {
			// log scale: 50 chars → ~4px, 1M chars → ~96px
			return Math.max(4, Math.min(96, Math.round(Math.log10(Math.max(chars, 10)) * 18 - 26)));
		}

		function HistoryItem({ message, isNew }) {
			const bucket = bucketOf(message);
			const [color, label] = ITEM_STYLE[bucket] ?? ["#8a8f98", bucket];
			const chars = JSON.stringify(message.content ?? []).length;
			let text = "";
			if (bucket === "assistant") {
				const calls = (message.content ?? []).filter((b) => b?.type === "tool-call").map((b) => b.name);
				const said = (message.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(" ").trim();
				text = calls.length > 0 ? `调用 ${calls.join(", ")}` : said.slice(0, 40) || "（仅推理）";
			} else if (bucket === "toolResult") {
				const block = (message.content ?? [])[0];
				text = `${message.source?.name ?? "工具"}${block?.isError ? " ✗" : ""}`;
			} else if (bucket === "injection") {
				text = message.source?.plugin ?? message.source?.kind ?? "注入";
			} else {
				text = blockText(message.content).replace(/\s+/g, " ").slice(0, 40);
			}
			return h("span", {
				className: `cv-arch-item${isNew ? " new" : ""}`,
				style: { borderColor: color },
				title: `${label} · ${fmtChars(chars)} 字符\n${blockText(message.content).slice(0, 600)}`,
			},
				h("i", { style: { background: color, width: sizeWidth(chars) } }),
				h("b", { style: { color } }, label),
				h("span", null, text),
				h("em", null, fmtChars(chars)),
			);
		}

		function Segment({ segment, index, total, newSet, defaultOpen }) {
			const [open, setOpen] = react.useState(defaultOpen);
			const items = segment.items;
			const hasNew = items.some((m) => newSet.has(messageKey(m)));
			const chars = items.reduce((n, m) => n + JSON.stringify(m.content ?? []).length, 0);
			const counts = items.reduce((acc, m) => { const b = bucketOf(m); acc[b] = (acc[b] ?? 0) + 1; return acc; }, {});
			const compacted = segment.opener && /压缩|摘要|summary|compact/i.test(blockText(segment.opener.content).slice(0, 200));
			const title = segment.opener ? blockText(segment.opener.content).replace(/\s+/g, " ").slice(0, 60) : "（无用户输入开头的片段）";
			const MAX = 14;
			const shown = open ? (items.length > MAX ? [...items.slice(0, 4), null, ...items.slice(-(MAX - 5))] : items) : [];
			return h("div", { className: `cv-arch-seg${hasNew ? " new" : ""}` },
				h("div", { className: "cv-arch-seg-head", onClick: () => setOpen(!open) },
					h("span", null, open ? "▾" : "▸"),
					h("strong", null, `段 ${index + 1}/${total}`),
					compacted ? h(Badge, { kind: "warn", title: "开头像是上下文压缩产生的摘要" }, "压缩摘要") : null,
					h("span", { className: "cv-arch-seg-title" }, title),
					h("span", { className: "cv-count" }, [
						counts.assistant ? `${counts.assistant} 次模型` : null,
						counts.toolResult ? `${counts.toolResult} 个结果` : null,
						counts.injection ? `${counts.injection} 注入` : null,
						`${fmtChars(chars)} 字符`,
					].filter(Boolean).join(" · ")),
					hasNew ? h(Badge, { kind: "warn" }, "含本步新增") : null,
				),
				open ? h("div", { className: "cv-arch-chain" },
					shown.map((m, i) => m === null
						? h("span", { key: `gap-${i}`, className: "cv-arch-gap" }, `… 中间 ${items.length - (MAX - 1)} 条 …`)
						: h(react.Fragment ?? "span", { key: `${messageKey(m) ?? "m"}-${i}` },
							i > 0 ? h("span", { className: "cv-arch-arrow" }, "→") : null,
							h(HistoryItem, { message: m, isNew: newSet.has(messageKey(m)) }),
						)),
				) : null,
			);
		}

		function ArchitectureTab({ record, summary }) {
			const messages = record.request.messages ?? [];
			const system = messages.filter((m) => m.role === "system");
			const outline = systemOutline(system);
			const tools = record.request.tools ?? [];
			const toolGroups = new Map();
			for (const t of tools) { const g = toolGroup(t.name); toolGroups.set(g, [...(toolGroups.get(g) ?? []), t]); }
			const segments = historySegments(messages);
			const newSet = new Set(summary?.newMessageIds ?? []);
			const calls = record.response?.toolCalls ?? [];
			const runs = record.toolRuns ?? [];
			const runByCall = new Map(runs.map((r) => [String(r.callId), r]));
			const bd = summary?.breakdown ?? {};
			const total = Object.values(bd).reduce((a, b) => a + (b ?? 0), 0) || 1;
			const pct = (n) => `${Math.round(((n ?? 0) / total) * 100)}%`;
			const tok = usageTokens(record.response?.usage);
			return h("div", { className: "cv-arch" },
				h("div", { className: "cv-arch-col" },
					h("div", { className: "cv-arch-title" }, "① 请求上下文结构", h("span", { className: "cv-count" }, ` 发给 ${record.model ?? "模型"} 的内容，自上而下即发送顺序`)),
					// System
					h("div", { className: "cv-arch-layer", style: { borderLeftColor: "#7c6cf0" } },
						h("div", { className: "cv-arch-layer-head" },
							h("strong", null, "System"),
							h("span", { className: "cv-count" }, `${system.length} 条 · ${fmtChars(bd.system)} 字符 · ${pct(bd.system)}`),
							summary?.systemChanged === true ? h(Badge, { kind: "warn" }, "较上一步变化") : summary?.systemChanged === false ? h(Badge, { kind: "ok" }, "未变") : null,
						),
						outline.length === 0
							? h("div", { className: "cv-count" }, "未识别到章节标题（纯文本 system）")
							: h("div", { className: "cv-arch-outline" }, outline.slice(0, 40).map((o, i) => h("span", {
								key: i, className: `cv-arch-chip l${Math.min(o.level, 3)}${o.dup ? " dup" : ""}`,
								title: o.dup ? "该标题在 system 中重复出现" : `${fmtChars(o.chars)} 字符`,
							}, o.title, h("em", null, fmtChars(o.chars))))),
						outline.length > 40 ? h("div", { className: "cv-count" }, `… 另有 ${outline.length - 40} 个章节`) : null,
					),
					// Tools
					h("div", { className: "cv-arch-layer", style: { borderLeftColor: "#8a8f98" } },
						h("div", { className: "cv-arch-layer-head" },
							h("strong", null, "Tools"),
							h("span", { className: "cv-count" }, `${tools.length} 个 · ${fmtChars(bd.tools)} 字符 · ${pct(bd.tools)}`),
							summary?.toolsChanged === true ? h(Badge, { kind: "warn" }, "较上一步变化") : summary?.toolsChanged === false ? h(Badge, { kind: "ok" }, "未变") : null,
						),
						h("div", { className: "cv-arch-outline" }, [...toolGroups.entries()].map(([g, list]) => h("span", {
							key: g, className: `cv-arch-chip tools${g.startsWith("MCP") ? " mcp" : ""}`,
							title: list.map((t) => t.name).join("\n"),
						}, g, h("em", null, String(list.length))))),
					),
					// History
					h("div", { className: "cv-arch-layer", style: { borderLeftColor: "#4a90d9" } },
						h("div", { className: "cv-arch-layer-head" },
							h("strong", null, "对话历史"),
							h("span", { className: "cv-count" }, `${segments.length} 段 · ${messages.length - system.length} 条 · 用户 ${pct(bd.userInput)} / 模型 ${pct(bd.assistant)} / 工具结果 ${pct(bd.toolResult)} / 注入 ${pct(bd.injection)}`),
						),
						segments.length === 0 ? h("div", { className: "cv-count" }, "无") :
							segments.map((seg, i) => h(Segment, {
								key: `${record.id}-${i}`, segment: seg, index: i, total: segments.length, newSet,
								defaultOpen: i >= segments.length - 2 || seg.items.some((m) => newSet.has(messageKey(m))),
							})),
					),
				),
				h("div", { className: "cv-arch-col narrow" },
					h("div", { className: "cv-arch-title" }, "② 本步流转"),
					h("div", { className: "cv-flow-node" },
						h("strong", null, "请求"),
						h("div", { className: "cv-count" }, `${messages.length} 条消息 · ${tools.length} 个工具`),
						h("div", { className: "cv-count" }, tok?.input !== undefined ? `输入 ${fmtChars(tok.input)} tok${tok.cacheRead ? ` · 缓存 ${Math.round((tok.cacheRead / tok.input) * 100)}%` : ""}` : `≈ ${fmtChars(record.request.approxChars)} 字符`),
						newSet.size > 0 ? h("div", { className: "cv-count" }, `本步新增 ${summary?.newMessageIds?.length ?? 0} 条`) : null,
					),
					h("div", { className: "cv-flow-arrow" }, "↓"),
					h("div", { className: `cv-flow-node model${record.status === "error" ? " err" : ""}` },
						h("strong", null, record.model ?? "模型"),
						h("div", { className: "cv-count" }, `${fmtDuration(record.durationMs)}${tok?.output !== undefined ? ` · 输出 ${fmtChars(tok.output)} tok` : ""}`),
						record.response?.reasoning ? h("div", { className: "cv-count" }, `推理 ${fmtChars(record.response.reasoning.length)} 字符`) : null,
						record.response?.text ? h("div", { className: "cv-count" }, `回复 ${fmtChars(record.response.text.length)} 字符`) : null,
						record.error ? h("div", { className: "cv-err" }, record.error.message) : null,
					),
					h("div", { className: "cv-flow-arrow" }, "↓"),
					calls.length === 0
						? h("div", { className: "cv-flow-node end" }, h("strong", null, record.status === "streaming" ? "流式接收中…" : "文本回复 · 回合结束"))
						: h("div", null,
							h("div", { className: "cv-count", style: { margin: "0 0 4px" } }, `解析出 ${calls.length} 个工具调用`),
							calls.map((call, i) => {
								const run = runByCall.get(String(call.id));
								const resultChars = run ? JSON.stringify(run.content ?? []).length : null;
								return h("div", { key: call.id ?? i, className: `cv-flow-call${run?.isError ? " err" : run ? " ok" : ""}` },
									h("div", null, h("strong", null, call.name), isMcpTool(call.name) || toolGroup(call.name).startsWith("MCP") ? h(Badge, { kind: "warn" }, "MCP") : null),
									h("div", { className: "cv-count", title: call.arguments }, `参数 ${fmtChars((call.arguments ?? "").length)} 字符`),
									h("div", { className: "cv-count" }, run ? `${run.isError ? "失败" : "成功"} · ${fmtDuration(run.durationMs)} · 结果 ${fmtChars(resultChars)} 字符` : "未执行 / 执行中"),
								);
							}),
							h("div", { className: "cv-flow-arrow" }, "↓"),
							h("div", { className: "cv-flow-node next" },
								h("strong", null, "回填 → 下一步"),
								h("div", { className: "cv-count" }, `${runs.length} 条工具结果进入下一次请求`),
							),
						),
				),
			);
		}
		//#endregion

		//#region response / tools / json tabs
		function ResponseTab({ record }) {
			const response = record.response ?? {};
			const calls = response.toolCalls ?? [];
			return h("div", null,
				h("div", { className: "cv-kv", style: { marginBottom: 10 } },
					h(Badge, { kind: record.status === "error" ? "err" : calls.length > 0 ? "warn" : "ok" },
						record.status === "streaming" ? "流式接收中…" : record.status === "error" ? "请求失败" : calls.length > 0 ? `解析出 ${calls.length} 个工具调用` : "纯文本回复（无工具调用）"),
					response.finishReason ? h(Badge, { kind: "dim" }, `结束原因：${finishLabel(response.finishReason)}`) : null,
					record.durationMs !== null && record.durationMs !== undefined ? h(Badge, null, `耗时 ${fmtDuration(record.durationMs)}`) : null,
					response.usage ? h(Badge, { kind: "dim" }, `输入（未缓存）${fmtChars(response.usage.inputTokens)} · 缓存读取 ${fmtChars(response.usage.cacheReadTokens ?? 0)} · 缓存写入 ${fmtChars(response.usage.cacheWriteTokens ?? 0)} · 输出 ${fmtChars(response.usage.outputTokens)} · 合计 ${fmtChars(response.usage.totalTokens)} tokens`) : null,
				),
				record.error ? h("div", { className: "cv-err", style: { margin: "6px 0" } }, `错误：${record.error.message}`) : null,
				h(Section, { title: "推理（reasoning）", meta: `${(response.reasoning ?? "").length} 字符`, openDefault: false },
					h(Pre, { text: response.reasoning ?? "" }),
				),
				h(Section, { title: "回复文本", meta: `${(response.text ?? "").length} 字符` },
					h(Pre, { text: response.text ?? "" }),
				),
				h(Section, { title: "解析出的工具调用（模型原始产出）", meta: `${calls.length} 个`, openDefault: calls.length > 0 },
					calls.length === 0 ? h("div", { className: "cv-count" }, "无") : calls.map((call, index) => h("div", { className: "cv-toolcard", key: call.id ?? index },
						h("div", { className: "cv-toolcard-head" },
							h("strong", null, call.name ?? "?"),
							h(Badge, { kind: "dim" }, `id=${call.id}`),
							isMcpTool(call.name) ? h(Badge, { kind: "warn" }, "MCP?") : null,
						),
						h("div", { style: { padding: "5px 9px 7px" } },
							h("div", { className: "cv-count", style: { marginBottom: 2 } }, "arguments（模型给的原始 JSON 串）"),
							h(Pre, { text: (() => { try { return typeof call.arguments === "string" ? pretty(JSON.parse(call.arguments || "{}")) : pretty(call.arguments ?? {}); } catch { return String(call.arguments); } })(), openDefault: true, maxHeight: 260 }),
						),
					)),
				),
			);
		}

		function ToolRunCard({ run }) {
			return h("div", { className: "cv-toolcard" },
				h("div", { className: "cv-toolcard-head" },
					h("strong", null, run.name),
					run.isError ? h(Badge, { kind: "err" }, "失败") : h(Badge, { kind: "ok" }, "成功"),
					run.nested ? h(Badge, { kind: "dim", title: `嵌套于 ${run.rootCallId}` }, "嵌套") : null,
					run.durationMs !== null && run.durationMs !== undefined ? h(Badge, { kind: "dim" }, fmtDuration(run.durationMs)) : null,
					h("span", { className: "cv-count" }, `callId=${run.callId}`),
				),
				h("div", { style: { padding: "5px 9px 7px" } },
					h("div", { className: "cv-count", style: { marginBottom: 2 } }, "入参"),
					h(Pre, { text: pretty(run.arguments), openDefault: false, maxHeight: 200 }),
					h("div", { className: "cv-count", style: { margin: "6px 0 2px" } }, "结果（模型看到的 content）"),
					h(Pre, { text: blockText(run.content) || JSON.stringify(run.content), openDefault: false, maxHeight: 300 }),
					run.meta !== undefined && run.meta !== null ? h("details", { style: { marginTop: 4 } }, h("summary", { className: "cv-count" }, "meta"), h(Pre, { text: pretty(run.meta), openDefault: true, maxHeight: 200 })) : null,
				),
			);
		}

		function ToolsTab({ record }) {
			const runs = record.toolRuns ?? [];
			return h("div", null,
				h("div", { className: "cv-kv", style: { marginBottom: 10 } },
					h(Badge, null, `工具执行 ${runs.length} 次`),
					h(Badge, { kind: runs.some((r) => r.isError) ? "err" : "ok" }, `失败 ${runs.filter((r) => r.isError).length} 次`),
					runs.length === 0 ? h(Badge, { kind: "dim" }, "本步没有工具执行（要么纯文本回复，要么执行尚未开始/发生）") : null,
				),
				runs.length === 0 ? h("div", { className: "cv-empty" }, "无工具执行记录") : runs.map((run, index) => h(ToolRunCard, { key: run.callId ?? index, run })),
			);
		}

		/** One collapsible JSON block: serialized only while open, copyable without opening. */
		function JsonBlock({ title, desc, value, count, level = 0, children, defaultOpen = false }) {
			const [open, setOpen] = react.useState(defaultOpen);
			const [copied, setCopied] = react.useState(false);
			const [wrap, setWrap] = react.useState(true);
			// size is cheap enough to compute once; the pretty text only while open
			const size = react.useMemo(() => { try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; } }, [value]);
			const text = open && !children ? pretty(value) : "";
			const copy = async (event) => {
				event.stopPropagation();
				const ok = await copyText(pretty(value));
				setCopied(ok ? "ok" : "err");
				setTimeout(() => setCopied(false), 1200);
			};
			return h("div", { className: `cv-json lvl${level}` },
				h("div", { className: "cv-json-head", role: "button", tabIndex: 0, "aria-expanded": open,
					onClick: () => setOpen(!open),
					onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } },
				},
					h("span", { className: "cv-json-caret" }, open ? "▾" : "▸"),
					h("strong", null, title),
					count !== undefined ? h(Badge, { kind: "dim" }, `${count} 条`) : null,
					h("span", { className: "cv-count" }, `${fmtChars(size)} 字符`),
					desc ? h("span", { className: "cv-count cv-json-desc" }, desc) : null,
					h("span", { style: { flex: 1 } }),
					open && !children ? h("button", { className: "cv-btn cv-copy", onClick: (e) => { e.stopPropagation(); setWrap(!wrap); } }, wrap ? "不换行" : "自动换行") : null,
					h("button", { className: "cv-btn cv-copy", onClick: copy }, copied === "ok" ? "已复制 ✓" : copied === "err" ? "复制失败" : "复制 JSON"),
				),
				open ? (children
					? h("div", { className: "cv-json-children" }, children)
					: h("pre", { className: "cv-pre open cv-json-pre", style: wrap ? undefined : { whiteSpace: "pre", overflowX: "auto" } }, text)) : null,
			);
		}

		function JsonTab({ record }) {
			const messages = record.request?.messages ?? [];
			const system = messages.filter((m) => m.role === "system");
			if (record.request?.system) system.push({ role: "system", content: [{ type: "text", text: record.request.system }], source: { kind: "plugin", plugin: "独立 system 字段" } });
			const users = messages.filter((m) => m.role === "user");
			const byBucket = (key) => users.filter((m) => bucketOf(m) === key);
			const userInput = byBucket("userInput");
			const toolResults = byBucket("toolResult");
			const injections = byBucket("injection");
			const assistantHistory = messages.filter((m) => m.role === "assistant");
			const response = record.response ?? {};
			// The assistant message as it will enter the next request's history.
			const assistantMessage = {
				role: "assistant",
				content: [
					...(response.reasoning ? [{ type: "reasoning", text: response.reasoning }] : []),
					...(response.text ? [{ type: "text", text: response.text }] : []),
					...(response.toolCalls ?? []).map((c) => ({ type: "tool-call", id: c.id, name: c.name, arguments: c.arguments })),
				],
			};
			const perMessage = (list, prefix) => list.map((m, i) => h(JsonBlock, {
				key: `${messageKey(m) ?? prefix}-${i}`, level: 2,
				title: `${prefix} #${i + 1}`,
				desc: blockText(m.content).replace(/\s+/g, " ").slice(0, 80),
				value: m,
			}));
			const userValue = { userInput, toolResults, injections };
			return h("div", null,
				h("div", { className: "cv-count", style: { marginBottom: 8 } },
					`第 ${record.turn ?? "?"} 轮 · 第 ${record.step ?? "?"} 步 · ${record.model ?? "?"}`,
					record.origin === "reconstructed" ? " · 按会话日志重建" : "",
					" — 全部默认折叠；子模块的「复制 JSON」无需展开即可复制。"),
				h(JsonBlock, { title: "完整记录", desc: "本步捕获的全部字段（请求、响应、工具执行、元数据）", value: record }),
				h(JsonBlock, { title: "System content", desc: "system-role 消息，发送时位于最前", value: system, count: system.length },
					system.length === 0 ? h("div", { className: "cv-count" }, "本请求没有系统内容") : perMessage(system, "System"),
				),
				h(JsonBlock, { title: "User content", desc: "user-role 消息，按来源拆分", value: userValue, count: users.length },
					h(JsonBlock, { level: 1, title: "用户输入", value: userInput, count: userInput.length }, userInput.length ? perMessage(userInput, "用户输入") : h("div", { className: "cv-count" }, "无")),
					h(JsonBlock, { level: 1, title: "工具结果回填", value: toolResults, count: toolResults.length }, toolResults.length ? perMessage(toolResults, "工具结果") : h("div", { className: "cv-count" }, "无")),
					h(JsonBlock, { level: 1, title: "插件 / 系统注入", value: injections, count: injections.length }, injections.length ? perMessage(injections, "注入") : h("div", { className: "cv-count" }, "无")),
				),
				h(JsonBlock, { title: "模型返回", desc: `${(response.toolCalls ?? []).length} 个工具调用 · finish=${typeof response.finishReason === "string" ? response.finishReason : finishLabel(response.finishReason)}`, value: response },
					h(JsonBlock, { level: 1, title: "Assistant 消息（将进入下一步上下文）", value: assistantMessage }),
					h(JsonBlock, { level: 1, title: "回复文本", value: response.text ?? "" }),
					h(JsonBlock, { level: 1, title: "推理", value: response.reasoning ?? "" }),
					h(JsonBlock, { level: 1, title: "工具调用", value: response.toolCalls ?? [], count: (response.toolCalls ?? []).length }),
					h(JsonBlock, { level: 1, title: "Token 用量", value: response.usage ?? null }),
				),
				h(JsonBlock, { title: "其他请求字段", desc: "Assistant 历史、工具 schema、采样参数", value: { assistantHistory, tools: record.request?.tools ?? [], temperature: record.request?.temperature, maxTokens: record.request?.maxTokens, stop: record.request?.stop } },
					h(JsonBlock, { level: 1, title: "Assistant 历史", value: assistantHistory, count: assistantHistory.length }, assistantHistory.length ? perMessage(assistantHistory, "Assistant") : h("div", { className: "cv-count" }, "无")),
					h(JsonBlock, { level: 1, title: "工具 schema", value: record.request?.tools ?? [], count: (record.request?.tools ?? []).length }),
					h(JsonBlock, { level: 1, title: "采样参数", value: { provider: record.provider, model: record.model, temperature: record.request?.temperature, maxTokens: record.request?.maxTokens, stop: record.request?.stop } }),
				),
				h(JsonBlock, { title: "工具执行", desc: "本步解析出的调用实际执行后的入参与结果", value: record.toolRuns ?? [], count: (record.toolRuns ?? []).length }),
			);
		}
		//#endregion

		//#region turn grouping + timeline
		/** Group main-loop steps by turn; auxiliary calls (title, compaction…) are separate. */
		function groupTurns(steps, showAux) {
			const groups = [];
			let current = null;
			for (const s of steps) {
				const aux = s.purpose !== undefined && s.purpose !== null;
				if (aux && !showAux) continue;
				const key = aux ? `aux:${s.id}` : s.turn !== undefined ? `turn:${s.turn}` : `loose:${s.id}`;
				if (!current || current.key !== key) {
					current = { key, turn: s.turn, aux, steps: [], preview: s.userPreview };
					groups.push(current);
				}
				current.steps.push(s);
				if (!current.preview && s.userPreview) current.preview = s.userPreview;
			}
			return groups;
		}

		function stepOutcome(s) {
			if (s.status === "streaming") return { text: "流式中…", kind: "warn" };
			if (s.status === "error") return { text: "失败", kind: "err" };
			if (s.parsedToolCalls > 0) return { text: `调用 ${s.parsedToolCalls}`, kind: "warn" };
			return { text: "文本回复", kind: "ok" };
		}

		function TurnTimeline({ group, selected, onSelect }) {
			const trackRef = react.useRef(null);
			react.useEffect(() => {
				const node = trackRef.current?.querySelector(".cv-tl-node.sel");
				if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
			}, [selected, group?.key]);
			if (!group) return null;
			const items = [];
			group.steps.forEach((s, index) => {
				const outcome = stepOutcome(s);
				const tok = usageTokens(s.usage);
				items.push(h("button", {
					key: s.id, className: `cv-tl-node${s.id === selected ? " sel" : ""} ${outcome.kind}`,
					onClick: () => onSelect(s.id),
					title: `${s.model ?? ""} · ${fmtDuration(s.durationMs)}`,
				},
					h("div", { className: "cv-tl-title" }, s.purpose ? s.purpose : `第 ${s.step ?? index + 1} 步 · 调模型`, s.origin === "reconstructed" ? h("span", { className: "cv-count", style: { fontWeight: 400 } }, " · 重建") : null),
					h("div", { className: "cv-tl-sub" }, tok?.input !== undefined ? `${fmtChars(tok.input)} tok` : `${fmtChars(s.requestChars)} 字符`, " · ", fmtDuration(s.durationMs)),
					h(BreakdownBar, { breakdown: s.breakdown, height: 4 }),
				));
				const names = s.toolCallNames ?? [];
				const last = index === group.steps.length - 1;
				if (names.length > 0) {
					const label = names.length <= 2 ? names.join(" + ") : `${names.slice(0, 2).join(" + ")} +${names.length - 2}`;
					items.push(h("div", { key: `${s.id}-edge`, className: "cv-tl-edge", title: names.join("\n") },
						h("span", { className: "cv-tl-edge-label" }, `执行 ${label}`),
						h("span", { className: "cv-tl-arrow" }, last ? (s.status === "streaming" ? "…" : `${s.toolRuns}/${names.length} 已执行 →`) : "结果回填 →"),
					));
				} else if (last && s.status !== "streaming" && s.status !== "error" && !group.aux) {
					items.push(h("div", { key: `${s.id}-end`, className: "cv-tl-end" }, "■ 回合结束"));
				}
			});
			return h("div", { className: "cv-timeline" },
				h("div", { className: "cv-tl-head" },
					group.aux ? "辅助调用" : `第 ${group.turn ?? "?"} 轮`,
					group.preview ? h("span", { className: "cv-tl-quote" }, `「${group.preview}」`) : null,
					h("span", { className: "cv-count" }, `${group.steps.length} 次模型调用 · ${group.steps.reduce((n, s) => n + (s.toolRuns ?? 0), 0)} 次工具执行`),
				),
				h("div", { className: "cv-tl-track", ref: trackRef }, items),
			);
		}

		/** One turn in the left rail: the steps themselves live in the horizontal timeline. */
		function TurnCard({ group, selected, onSelect, scale }) {
			const steps = group.steps;
			const last = steps[steps.length - 1];
			const first = steps[0];
			const runs = steps.reduce((n, s) => n + (s.toolRuns ?? 0), 0);
			const errors = steps.filter((s) => s.status === "error").length;
			const streaming = steps.some((s) => s.status === "streaming");
			const tok = usageTokens(last?.usage);
			const span = last && first && typeof last.startedAt === "number" ? (last.startedAt + (last.durationMs ?? 0)) - first.startedAt : null;
			const tools = new Map();
			for (const s of steps) for (const name of s.toolCallNames ?? []) tools.set(name, (tools.get(name) ?? 0) + 1);
			const topTools = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
			const reconstructed = steps.every((s) => s.origin === "reconstructed");
			return h("div", {
				className: `cv-turn${selected ? " sel" : ""}`, role: "button", tabIndex: 0, "aria-pressed": selected,
				onClick: () => onSelect(last.id),
				onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(last.id); } },
				title: group.preview ?? "",
			},
				h("div", { className: "cv-turn-head" },
					h("strong", null, group.aux ? "辅助调用" : `第 ${group.turn ?? "?"} 轮`),
					h("span", { className: "cv-count" }, fmtTime(first?.startedAt)),
				),
				group.preview ? h("div", { className: "cv-turn-quote" }, group.preview) : null,
				h(BreakdownBar, { breakdown: last?.breakdown, scale, height: 5 }),
				h("div", { className: "cv-turn-meta" },
					streaming ? h(Badge, { kind: "warn" }, "进行中") : errors ? h(Badge, { kind: "err" }, `${errors} 步失败`) : null,
					h("span", null, `${steps.length} 次调用`),
					runs ? h("span", null, `${runs} 次工具`) : null,
					h("span", null, tok?.input !== undefined ? `${fmtChars(tok.input)} tok` : `${fmtChars(last?.requestChars)} 字符`),
					span !== null ? h("span", null, fmtDuration(span)) : null,
					reconstructed ? h("span", { title: "本轮全部来自会话日志重建" }, "重建") : null,
				),
				topTools.length ? h("div", { className: "cv-turn-tools" }, topTools.map(([name, count]) => `${name}×${count}`).join("  ")) : null,
			);
		}

		function StepRow({ summary, selected, onSelect, scale }) {
			const outcome = stepOutcome(summary);
			const tok = usageTokens(summary.usage);
			return h("div", {
				className: `cv-step${selected ? " sel" : ""}`, role: "button", tabIndex: 0, "aria-pressed": selected,
				onKeyDown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(summary.id); } },
				onClick: () => onSelect(summary.id),
			},
				h("div", { className: "cv-step-head" },
					h("span", { className: "cv-step-model" }, summary.purpose ? summary.purpose : `step ${summary.step ?? "?"}`),
					h("span", { className: "cv-count" }, fmtTime(summary.startedAt)),
				),
				h(BreakdownBar, { breakdown: summary.breakdown, scale, height: 6 }),
				h("div", { style: { display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap", alignItems: "center" } },
					h(Badge, { kind: outcome.kind }, outcome.text),
					summary.origin === "reconstructed" ? h(Badge, { kind: "dim", title: "插件启用前发生，按会话日志重放还原；没有实时捕获时的耗时细节" }, "重建") : null,
					h("span", { className: "cv-count" }, tok?.input !== undefined ? `${fmtChars(tok.input)} tok` : `${fmtChars(summary.requestChars)} 字符`),
					h(Delta, { value: summary.deltaChars }),
					summary.newMessageIds && summary.systemChanged !== null ? h("span", { className: "cv-count", title: "相对上一步新增的消息数" }, `+${summary.newMessageIds.length} 条`) : null,
					summary.systemChanged ? h(Badge, { kind: "warn", title: "System content 较上一步有变化" }, "Sys 变化") : null,
				),
				(summary.toolCallNames ?? []).length > 0 ? h("div", { className: "cv-step-sub" }, `→ ${summary.toolCallNames.join(", ")}`) : null,
			);
		}
		//#endregion

		//#region root view
		const TABS = [["arch", "架构"], ["request", "请求上下文"], ["response", "模型响应"], ["tools", "工具执行"], ["json", "原始 JSON"]];

		function View(props) {
			const sessionId = props?.sessionId;
			const [api, setApi] = react.useState(null);
			const [apiError, setApiError] = react.useState(null);
			const [sessions, setSessions] = react.useState([]);
			const [activeSession, setActiveSession] = react.useState(undefined);
			const [steps, setSteps] = react.useState([]);
			const [selected, setSelected] = react.useState(null);
			const [detail, setDetail] = react.useState(null);
			const [tab, setTab] = react.useState("arch");
			const [auto, setAuto] = react.useState(true);
			const [refreshVersion, setRefreshVersion] = react.useState(0);
			const [refreshing, setRefreshing] = react.useState(false);
			const [follow, setFollow] = react.useState(true);
			const [showAux, setShowAux] = react.useState(false);
			const [backfillInfo, setBackfillInfo] = react.useState(null);
			const [backfilling, setBackfilling] = react.useState(false);
			const apiRef = react.useRef(null);
			react.useEffect(() => { apiRef.current = api; }, [api]);

			// mount the remote contribution once
			react.useEffect(() => {
				let disposed = false;
				(props.ready).then((remote) => {
					if (!disposed) setApi(() => remote);
				}, (error) => {
					console.error("ctx-visualizer: remote mount failed", error);
					if (!disposed) setApiError(String(error?.message ?? error));
				});
				return () => { disposed = true; };
			}, [props.ready]);

			// polling loop
			react.useEffect(() => {
				if (!api) return undefined;
				let stop = false;
				async function tick() {
					setRefreshing(true);
					try {
						const sessionsResult = await api.listSessions();
						if (stop) return;
						setSessions(unwrap(sessionsResult)?.sessions ?? []);
						const target = activeSession ?? sessionId;
						if (target === undefined) { setSteps([]); return; }
						const stepsResult = await api.listSteps(target);
						if (stop) return;
						const stepsValue = unwrap(stepsResult);
						setSteps(stepsValue?.steps ?? []);
						setBackfillInfo(stepsValue?.backfill ?? null);
						setApiError(null);
					} catch (error) {
						if (!stop) setApiError(String(error?.message ?? error));
					} finally { if (!stop) setRefreshing(false); }
				}
				tick();
				const timer = auto ? setInterval(tick, 1500) : undefined;
				return () => { stop = true; clearInterval(timer); };
			}, [api, activeSession, sessionId, auto, refreshVersion]);

			// Follow mode tracks the newest visible step; a manual pick turns it off.
			const visibleSteps = showAux ? steps : steps.filter((s) => s.purpose === undefined || s.purpose === null);
			const latestVisibleId = visibleSteps.length > 0 ? visibleSteps[visibleSteps.length - 1].id : null;
			react.useEffect(() => {
				if (latestVisibleId === null) { setSelected(null); setDetail(null); return; }
				if (follow || selected === null || !steps.some((s) => s.id === selected)) setSelected(latestVisibleId);
			}, [latestVisibleId, follow]); // eslint-disable-line react-hooks/exhaustive-deps
			const pick = (id) => { setFollow(id === latestVisibleId); setSelected(id); };

			// fetch detail when selection changes; refetch while streaming
			react.useEffect(() => {
				if (!api || selected === null || activeSession === undefined && sessionId === undefined) return undefined;
				let stop = false;
				async function fetchDetail() {
					const target = activeSession ?? sessionId;
					if (target === undefined || selected === null) return;
					try {
						const result = await api.getStep(target, selected);
						if (stop) return;
						if (result?.ok) setDetail(result.value);
						else if (result?.ok === false) setDetail({ _rpcError: result.error });
					} catch (error) {
						if (!stop) setDetail({ _rpcError: { message: String(error?.message ?? error) } });
					}
				}
				fetchDetail();
				const streaming = steps.find((s) => s.id === selected)?.status === "streaming";
				const timer = auto ? setInterval(fetchDetail, streaming ? 700 : 5000) : undefined;
				return () => { stop = true; clearInterval(timer); };
			}, [api, selected, activeSession, sessionId, steps, auto, refreshVersion]);

			// Shell switches reset the view; manual selection remains independent.
			react.useEffect(() => { setActiveSession(undefined); setSelected(null); setDetail(null); }, [sessionId]);

			injectStyle();
			const effectiveSession = activeSession ?? sessionId;
			const summary = steps.find((s) => s.id === selected) ?? null;
			const groups = groupTurns(steps, showAux);
			const selectedGroup = groups.find((g) => g.steps.some((s) => s.id === selected));
			const scale = Math.max(1, ...visibleSteps.map((s) => s.requestChars ?? 0));
			const turnScale = Math.max(1, ...groups.map((g) => g.steps[g.steps.length - 1]?.requestChars ?? 0));
			const auxCount = steps.length - steps.filter((s) => s.purpose === undefined || s.purpose === null).length;

			return h("div", { className: "cv-root" },
				h("div", { className: "cv-toolbar" },
					h("span", { className: "cv-title" }, "🔍 上下文透视"),
					h(Badge, { kind: apiError ? "err" : api ? "ok" : "warn" }, apiError ? `RPC 故障：${apiError}` : api ? "已连接" : "连接中…"),
					h(Badge, null, `${sessions.reduce((sum, s) => sum + s.steps, 0)} 步 / ${sessions.length} 会话`),
					h("label", { style: { display: "flex", gap: 4, alignItems: "center", fontSize: 12 } },
						h("input", { type: "checkbox", checked: auto, onChange: (e) => setAuto(e.target.checked) }), "自动刷新"),
					h("label", { style: { display: "flex", gap: 4, alignItems: "center", fontSize: 12 }, title: "新的一步出现时自动选中它" },
						h("input", { type: "checkbox", checked: follow, onChange: (e) => setFollow(e.target.checked) }), "跟随最新"),
					h("label", { style: { display: "flex", gap: 4, alignItems: "center", fontSize: 12 }, title: "会话标题生成、上下文压缩等非主循环调用" },
						h("input", { type: "checkbox", checked: showAux, onChange: (e) => setShowAux(e.target.checked) }), `显示辅助调用${auxCount ? `（${auxCount}）` : ""}`),
					h("select", {
						className: "cv-select", value: activeSession ?? "", onChange: (e) => { setActiveSession(e.target.value || undefined); setSteps([]); setSelected(null); setDetail(null); },
					},
						h("option", { value: "" }, "（当前会话）"),
						sessions.map((s) => h("option", { key: s.sessionId, value: s.sessionId }, `${s.sessionId.slice(0, 10)}… · ${s.steps} 步 · ${s.lastModel ?? "?"}`)),
					),
					h("button", {
						className: "cv-btn", disabled: !api, onClick: async () => {
							if (!apiRef.current) return;
							try { unwrap(await apiRef.current.clearStore()); setSessions([]); setSteps([]); setSelected(null); setDetail(null); setApiError(null); }
							catch (error) { setApiError(String(error?.message ?? error)); }
						},
						title: "同时删除磁盘上的持久化文件",
					}, "清空捕获"),
					h("button", {
						className: "cv-btn", disabled: !api || backfilling || effectiveSession === undefined,
						title: "从会话日志重建插件启用之前的步骤（打开时会自动执行，30 秒内最多一次）",
						onClick: async () => {
							if (!apiRef.current || effectiveSession === undefined) return;
							setBackfilling(true);
							try { setBackfillInfo(unwrap(await apiRef.current.backfill(effectiveSession))); setRefreshVersion((v) => v + 1); }
							catch (error) { setApiError(String(error?.message ?? error)); }
							finally { setBackfilling(false); }
						},
					}, backfilling ? "补录中…" : "立即补录"),
					backfillInfo ? h(Badge, { kind: backfillInfo.error ? "err" : "dim", title: backfillInfo.error ?? `读取 ${backfillInfo.events} 条日志事件，${fmtTime(backfillInfo.at)} 完成` },
						backfillInfo.error ? `补录失败：${backfillInfo.error}` : `重建 ${backfillInfo.steps} 步`) : null,
					h("button", { className: "cv-btn", disabled: !api || refreshing, onClick: () => setRefreshVersion(v => v + 1), title: "强制立即刷新" }, refreshing ? "刷新中…" : "立即刷新"),
				),
				h(TurnTimeline, { group: selectedGroup, selected, onSelect: pick }),
				h("div", { className: "cv-main" },
					h("div", { className: "cv-steps" },
						groups.length === 0
							? h("div", { className: "cv-empty" }, steps.length > 0 ? "只有辅助调用；勾选「显示辅助调用」查看。" : "此会话暂无捕获。\n插件启用之后的模型调用才会出现在这里；\n发一条消息即可触发。")
							: [...groups].reverse().map((g) => h(TurnCard, { key: g.key, group: g, selected: g === selectedGroup, onSelect: pick, scale: turnScale })),
					),
					h("div", { className: "cv-detail" },
						h("div", { className: "cv-tabs" },
							TABS.map(([key, label]) => h("button", { key, className: `cv-tab${tab === key ? " sel" : ""}`, onClick: () => setTab(key) }, label)),
						),
						h("div", { className: "cv-body" },
							detail === null ? h("div", { className: "cv-empty" }, "在左侧选择一步") :
								detail._rpcError ? h("div", { className: "cv-empty cv-err" }, `读取失败：${detail._rpcError.message}`) :
									tab === "arch" ? h(ArchitectureTab, { key: detail.id, record: detail, summary }) :
									tab === "request" ? h(RequestTab, { key: detail.id, record: detail, summary }) :
										tab === "response" ? h(ResponseTab, { key: detail.id, record: detail }) :
											tab === "tools" ? h(ToolsTab, { key: detail.id, record: detail }) :
												h(JsonTab, { record: detail }),
						),
					),
				),
			);
		}
		//#endregion

		//#region client plugin face
		const inject = ["slots", "remote"];

		function apply(ctx) {
			// Mount our Remote contribution in this plugin's fiber, then hand the
			// namespace to the view. Polling keeps the view live without needing a
			// forwarded Host event.
			const ready = (async () => {
				await ctx.remote.$mount(CONTRIBUTION);
				return new Promise((resolve) => {
					ctx.inject(["remote.ctxVisualizer"], (injected) => {
						resolve(injected.remote.ctxVisualizer);
					});
				});
			})();

			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: SLOT_ID,
				order: 20,
				label: () => "上下文透视",
				inject: (sessionId) => ({ sessionId, ready }),
			}, View));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
