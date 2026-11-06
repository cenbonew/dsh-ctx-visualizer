// Self-contained tests: a minimal fake Cordis context, no DeepSeek Harness
// install required. Every run uses a fresh temp directory for persistence and
// never touches ~/.dsh.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import * as plugin from "../lib/index.js";

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ✓ ${name}`);
	} catch (error) {
		console.error(`  ✗ ${name}\n`, error);
		process.exitCode = 1;
	}
}

/** Minimal fake of the Cordis context surface the host half uses. */
function fakeContext(services = {}) {
	const listeners = new Map();
	const disposers = [];
	const provided = {};
	const ctx = {
		logger: { info() {}, warn() {} },
		reflect: { provide: (name, value) => { provided[name] = value; } },
		on: (name, fn) => { listeners.set(name, fn); },
		effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); },
		inject: (deps, cb) => { if (deps.every((d) => services[d])) cb({ ...services, effect: ctx.effect }); },
		emit: (name, ...args) => listeners.get(name)?.(...args),
		waterfall: (name, payload, next) => listeners.get(name)(payload, next),
		dispose: () => { for (const d of disposers.splice(0)) d(); },
		get service() { return provided.ctxVisualizer; },
	};
	return ctx;
}

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ctx-visualizer-test-"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = (id) => ({ session: { id } });

async function modelCall(ctx, { session, turn, step, messages, tools = [], chunks, purpose }) {
	await ctx.waterfall("agent/request", { agent: agent(session), turn, step }, async () => ({}));
	const stream = ctx.waterfall("llm/stream", { provider: "p", model: "m", sessionId: session, purpose, messages, tools },
		() => (async function* () { for (const c of chunks) yield c; })());
	const out = [];
	for await (const c of stream) out.push(c);
	return out;
}

const sys = (id, text) => ({ id, role: "system", content: [{ type: "text", text }], source: { kind: "plugin", plugin: "system-prompt" } });
const user = (id, text) => ({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
const asst = (id, content) => ({ id, role: "assistant", content, source: { kind: "model" } });
const toolResult = (id, callId, name, text) => ({ id, role: "user", content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }], source: { kind: "tool", callId, name } });

console.log("host half");

await test("captures request, passes the stream through untouched, and correlates tool runs", async () => {
	const ctx = fakeContext();
	plugin.apply(ctx, { persist: false, backfill: false });
	const chunks = [
		{ type: "tool-call-delta", index: 0, id: "c1", name: "bash", argumentsDelta: "{\"cmd\":" },
		{ type: "tool-call-delta", index: 0, id: "c1", argumentsDelta: "\"ls\"}" },
		{ type: "usage", usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 900 } },
		{ type: "finish", reason: "tool-calls" },
	];
	const out = await modelCall(ctx, { session: "S", turn: 1, step: 1, messages: [sys("s", "SYS"), user("u", "hi")], tools: [{ name: "bash", description: "", inputSchema: {} }], chunks });
	assert.deepEqual(out, chunks, "stream must be passed through unchanged");
	await ctx.waterfall("tools/execute", { callId: "c1", agent: agent("S") }, async () => ({}));
	ctx.emit("tools/result", { callId: "c1", name: "bash", arguments: { cmd: "ls" }, agent: agent("S") }, { isError: false, content: [{ type: "text", text: "a.txt" }] });
	const { steps } = await ctx.service.listSteps("S");
	assert.equal(steps.length, 1);
	assert.equal(steps[0].turn, 1);
	assert.equal(steps[0].step, 1);
	const rec = await ctx.service.getStep("S", steps[0].id);
	assert.deepEqual(rec.response.toolCalls, [{ id: "c1", name: "bash", arguments: "{\"cmd\":\"ls\"}" }]);
	assert.equal(rec.toolRuns[0].content[0].text, "a.txt");
	assert.equal(rec.status, "tool-calls");
});

await test("keeps partial output and marks the step failed when the provider stream throws", async () => {
	const ctx = fakeContext();
	plugin.apply(ctx, { persist: false, backfill: false });
	await ctx.waterfall("agent/request", { agent: agent("E"), turn: 1, step: 1 }, async () => ({}));
	const stream = ctx.waterfall("llm/stream", { provider: "p", model: "m", sessionId: "E", messages: [] },
		() => (async function* () { yield { type: "text-delta", index: 0, text: "partial" }; throw new Error("provider failed"); })());
	await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } }, /provider failed/);
	const { steps } = await ctx.service.listSteps("E");
	const rec = await ctx.service.getStep("E", steps[0].id);
	assert.equal(rec.status, "error");
	assert.match(rec.error.message, /provider failed/);
});

await test("reports per-step increments: new messages, unchanged system/tools", async () => {
	const ctx = fakeContext();
	plugin.apply(ctx, { persist: false, backfill: false });
	const history = [sys("s", "SYS"), user("u", "q")];
	await modelCall(ctx, { session: "D", turn: 1, step: 1, messages: history, chunks: [{ type: "tool-call-delta", index: 0, id: "c1", name: "bash", argumentsDelta: "{}" }] });
	await modelCall(ctx, { session: "D", turn: 1, step: 2, messages: [...history, asst("a", [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }]), toolResult("t", "c1", "bash", "ok")], chunks: [{ type: "text-delta", index: 0, text: "done" }] });
	const { steps } = await ctx.service.listSteps("D");
	assert.deepEqual(steps[1].newMessageIds, ["a", "t"]);
	assert.equal(steps[1].systemChanged, false);
	assert.equal(steps[1].toolsChanged, false);
	assert.ok(steps[1].breakdown.toolResult > 0);
});

await test("redacts prefixed secrets before storing", async () => {
	const ctx = fakeContext();
	plugin.apply(ctx, { persist: false, backfill: false });
	await modelCall(ctx, { session: "R", turn: 1, step: 1, messages: [user("u", "key tos_ABCDEFGHIJKLMNOP and Bearer abcdefghijkl")], chunks: [] });
	const { steps } = await ctx.service.listSteps("R");
	const text = (await ctx.service.getStep("R", steps[0].id)).request.messages[0].content[0].text;
	assert.ok(!text.includes("ABCDEFGHIJKLMNOP") && !text.includes("abcdefghijkl"), text);
	assert.match(text, /tos_«redacted»/);
});

await test("backfills pre-capture steps from the session log, honouring replace (compaction) ops", async () => {
	let seq = 0;
	const E = (type, data, extra = {}) => ({ type, seq: ++seq, time: 1000 + seq, data, ...extra });
	const events = [
		E("request/header", { header: { config: { provider: "p", model: "m" }, tools: [{ name: "bash", description: "", inputSchema: {} }] }, reason: "initial" }),
		E("step/start", { turn: 1, step: 1 }),
		E("system/message", { turn: 1, step: 1, message: sys("s", "SYS") }, { surfaceOp: "append" }),
		E("user/message", user("u1", "first"), { surfaceOp: "append" }),
		E("assistant/message", { turn: 1, step: 1, message: asst("a1", [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }]), stream: [] }, { surfaceOp: "append" }),
		E("tool/call", { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" }),
		E("tool/result", { turn: 1, step: 1, message: toolResult("t1", "c1", "bash", "out") }, { surfaceOp: "append" }),
		E("step/start", { turn: 2, step: 1 }),
	];
	// compaction: replace u1..t1 with a summary
	events.push(E("user/message", user("sum", "summary"), { surfaceOp: { op: "replace", startSeq: 4, endSeq: 7 } }));
	events.push(E("user/message", user("u2", "second"), { surfaceOp: "append" }));
	events.push(E("assistant/message", { turn: 2, step: 1, message: asst("a2", [{ type: "text", text: "ok" }]), stream: [] }, { surfaceOp: "append" }));
	const ctx = fakeContext({ sessionQuery: { readSession: async () => ({ events, inheritedEventCount: 0 }) } });
	plugin.apply(ctx, { persist: false, backfill: true });
	const result = await ctx.service.listSteps("B");
	assert.equal(result.backfill.steps, 2);
	const [s1, s2] = result.steps;
	assert.equal(s1.origin, "reconstructed");
	const r1 = await ctx.service.getStep("B", s1.id);
	assert.deepEqual(r1.request.messages.map((m) => m.id), ["s", "u1"]);
	assert.equal(r1.toolRuns[0].content[0].text, "out");
	const r2 = await ctx.service.getStep("B", s2.id);
	assert.deepEqual(r2.request.messages.map((m) => m.id), ["s", "sum", "u2"], "compaction must replace the summarised range");
});

await test("backfill skips steps already captured live", async () => {
	const events = [
		{ type: "user/message", seq: 1, time: 1, data: user("u", "q"), surfaceOp: "append" },
		{ type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: asst("a", [{ type: "text", text: "x" }]), stream: [] }, surfaceOp: "append" },
	];
	const ctx = fakeContext({ sessionQuery: { readSession: async () => ({ events }) } });
	plugin.apply(ctx, { persist: false, backfill: true, backfillIntervalMs: 0 });
	await modelCall(ctx, { session: "L", turn: 1, step: 1, messages: [user("u", "q")], chunks: [] });
	const { steps } = await ctx.service.listSteps("L");
	assert.deepEqual(steps.map((s) => s.origin), ["loop"]);
});

await test("persists live captures with a deduplicated message table and restores them", async () => {
	const dir = tempDir();
	try {
		let ctx = fakeContext();
		plugin.apply(ctx, { persistDir: dir, backfill: false });
		const big = "x".repeat(50_000);
		const history = [sys("s", big)];
		for (let i = 1; i <= 5; i++) {
			history.push(user(`u${i}`, `q${i}`));
			await modelCall(ctx, { session: "P", turn: 1, step: i, messages: [...history], chunks: [{ type: "text-delta", index: 0, text: "a" }] });
		}
		await sleep(1700);
		const file = path.join(dir, "P.json");
		const saved = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(saved.version, 2);
		assert.ok(fs.statSync(file).size < 5 * 50_000, "shared system prompt must be stored once");
		ctx.dispose();
		ctx = fakeContext();
		plugin.apply(ctx, { persistDir: dir, backfill: false });
		await sleep(100);
		const { steps } = await ctx.service.listSteps("P");
		assert.equal(steps.length, 5);
		const first = await ctx.service.getStep("P", steps[0].id);
		const last = await ctx.service.getStep("P", steps[4].id);
		assert.equal(first.request.messages[0], last.request.messages[0], "restored messages stay shared");
		assert.deepEqual(steps[4].newMessageIds, ["u5"]);
		await ctx.service.clearStore();
		assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length, 0, "clear removes persisted files");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

console.log("client half");

await test("client bundle registers a conversation view and mounts a strict-codec contribution", async () => {
	let registration;
	const src = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	vm.runInNewContext(src, { window: { __ModuleLoader__: { load: (r) => { registration = r; } } }, console });
	const jsx = (type, props, key) => ({ type, props, key });
	const react = {
		useState: (init) => [typeof init === "function" ? init() : init, () => {}],
		useEffect() {},
		useRef: () => ({ current: null }),
		useMemo: (f) => f(),
		useContext: (ctx) => ctx,
		createContext: (v) => v,
		Fragment: "Fragment",
	};
	const mod = registration.factory((name) => (name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : (() => { throw new Error(name); })()));
	assert.deepEqual([...mod.inject], ["slots", "remote"]);
	let contribution;
	let slot;
	mod.apply({
		remote: { $mount: async (c) => { contribution = c; return () => {}; } },
		inject: () => {},
		slots: { inject: (name, factory) => { slot = { name, entry: factory() }; }, register: (options, component) => ({ ...options, component }) },
	});
	await sleep(0);
	assert.equal(slot.name, "conversation.view");
	assert.equal(slot.entry.id, "ctx-visualizer");
	for (const d of contribution.descriptors) {
		for (const p of d.parameters) assert.equal(p.codec.mode, "strict", `${d.method}.${p.name} must use a strict codec`);
	}
	assert.deepEqual([...contribution.descriptors].map((d) => d.method).sort(), ["backfill", "clearStore", "getStep", "listSessions", "listSteps"]);
});

console.log("i18n");

/** Load the client bundle in a sandbox with optional stored language. */
function loadClient(stored) {
	const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	// a mutable localStorage so storeLang/storedLang behave like a browser
	const store = new Map(stored ? [["dsh-ctx-visualizer:lang", stored]] : []);
	const sandbox = {
		window: { __ModuleLoader__: {} },
		console,
		navigator: { language: "en-US" },
		localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
	};
	let registration;
	sandbox.window.__ModuleLoader__.load = (r) => { registration = r; };
	vm.runInNewContext(source, sandbox);
	const jsx = (type, props, key) => ({ type, props, key });
	const react = {
		useState: (init) => [typeof init === "function" ? init() : init, () => {}],
		useEffect() {},
		useRef: () => ({ current: null }),
		useMemo: (f) => f(),
		Fragment: "Fragment",
	};
	const mod = registration.factory((name) => (name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : (() => { throw new Error(name); })()));
	// mirror what apply() does on boot: a stored choice wins, else the environment
	mod.__test.setLang(stored ?? mod.__test.langFromEnvironment(null));
	return mod.__test;
}

const CJK = /[\u4e00-\u9fff]/;
const flatten = (node, out = []) => {
	if (!node) return out;
	if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out; }
	if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
	if (typeof node !== "object") return out;
	if (node.props?.children !== undefined) flatten(node.props.children, out);
	for (const v of Object.values(node.props ?? {})) if (typeof v === "string") out.push(v);
	return out;
};

const record = {
	id: "cv-1", sessionId: "S", origin: "loop", provider: "deepseek", model: "deepseek-flash",
	turn: 2, step: 3, startedAt: 1_700_000_000_000, endedAt: 1_700_000_001_200, durationMs: 1200, status: "tool-calls",
	request: {
		messages: [
			{ id: "s", role: "system", cvKey: "s", content: [{ type: "text", text: "# Identity\nYou are an agent" }], source: { kind: "plugin", plugin: "system-prompt" } },
			{ id: "u", role: "user", cvKey: "u", content: [{ type: "text", text: "check the venue" }], source: { kind: "user" } },
			{ id: "a", role: "assistant", cvKey: "a", content: [{ type: "tool-call", id: "c1", name: "mcp__tos__whoami", arguments: "{}" }], source: { kind: "model" } },
		],
		messageSummaries: [{ role: "user", kind: "user", origin: "user input", chars: 10 }],
		tools: [{ name: "mcp__tos__whoami", description: "who am i", inputSchema: {} }],
		toolCount: 1, approxChars: 900, temperature: 0.2, maxTokens: 1000,
	},
	response: {
		text: "done", reasoning: "thinking", toolCalls: [{ id: "c1", name: "mcp__tos__whoami", arguments: "{}" }],
		usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 900 }, finishReason: "tool-calls",
	},
	toolRuns: [{ callId: "c1", rootCallId: "c1", nested: false, name: "mcp__tos__whoami", arguments: {}, startedAt: 1, endedAt: 2, durationMs: 1, isError: false, content: [{ type: "text", text: "ok" }] }],
	error: null,
};
const summary = {
	id: "cv-1", turn: 2, step: 3, status: "tool-calls", model: "deepseek-flash", startedAt: 1_700_000_000_000,
	durationMs: 1200, requestChars: 900, deltaChars: 300, messageCount: 3, toolCount: 1, parsedToolCalls: 1, toolRuns: 1,
	newMessageIds: ["a"], droppedCount: 0, systemChanged: false, toolsChanged: false,
	breakdown: { system: 100, userInput: 50, toolResult: 0, injection: 0, assistant: 80, tools: 40 },
	toolCallNames: ["mcp__tos__whoami"], finishReason: "tool-calls", usage: record.response.usage, origin: "loop", purpose: undefined,
};

await test("English renders every view without Chinese UI text", async () => {
	const t = loadClient("en");
	const views = {
		RequestTab: t.RequestTab({ record, summary }),
		ResponseTab: t.ResponseTab({ record }),
		ToolsTab: t.ToolsTab({ record }),
		JsonTab: t.JsonTab({ record }),
		ArchitectureTab: t.ArchitectureTab({ record, summary }),
		TurnCard: t.TurnCard({ group: { key: "t2", turn: 2, steps: [summary], preview: "check the venue", aux: false }, selected: true, onSelect() {}, scale: 900 }),
		TurnTimeline: t.TurnTimeline({ group: { key: "t2", turn: 2, steps: [summary], preview: "check the venue" }, selected: "cv-1", onSelect() {} }),
	};
	for (const [name, tree] of Object.entries(views)) {
		const text = flatten(tree).join(" ");
		const offending = text.match(new RegExp(`[^ ]*${CJK.source}[^ ]*`, "g"));
		assert.equal(offending, null, `${name} still has Chinese UI text: ${offending}`);
	}
	assert.match(flatten(views.RequestTab).join(" "), /User content|New this step|Tools/);
});

await test("Chinese renders Chinese UI text", async () => {
	const t = loadClient("zh");
	t.setLang("zh");
	const text = flatten(t.RequestTab({ record, summary })).join(" ");
	assert.match(text, CJK);
	assert.match(text, /本步新增|用户/);
});

await test("language follows the Harness locale, and an explicit choice wins", async () => {
	const t = loadClient(null);
	// en-US browser, locale service says zh → Chinese wins over the browser
	assert.equal(t.langFromEnvironment({ getLocale: () => ({ active: "zh" }) }), "zh");
	assert.equal(t.langFromEnvironment({ getLocale: () => ({ active: "en" }) }), "en");
	assert.equal(t.langFromEnvironment(null), "en", "en-US browser without a locale service");
	// an explicit stored choice overrides both
	t.storeLang("zh");
	assert.equal(t.storedLang(), "zh");
	t.setLang(t.storedLang() ?? t.langFromEnvironment({ getLocale: () => ({ active: "en" }) }));
	assert.equal(t.getLang(), "zh");
});

await test("every tr() pair is complete and the English side has no Chinese", async () => {
	const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	// walk to each `tr(` and read its two arguments as raw source windows
	const problems = [];
	let index = source.indexOf("tr(");
	while (index !== -1) {
		const isDefinition = source.slice(index - 9, index).includes("const tr");
		if (!isDefinition) {
			const rest = source.slice(index + 3);
			// first argument must be a literal that closes before the second begins
			const closeQuote = rest[0];
			if (closeQuote === `"` || closeQuote === `'` || closeQuote === "`") {
				let i = 1, depth = 0, end = -1;
				while (i < rest.length) {
					if (closeQuote === "`" && rest[i] === "$" && rest[i + 1] === "{") { depth++; i += 2; continue; }
					if (closeQuote === "`" && depth > 0 && rest[i] === "}") { depth--; i++; continue; }
					if (rest[i] === "\\") { i += 2; continue; }
					if (rest[i] === closeQuote && depth === 0) { end = i; break; }
					i++;
				}
				if (end === -1) problems.push(`unterminated first argument at ${index}`);
				else {
					const after = rest.slice(end + 1).trimStart();
					if (!after.startsWith(",")) problems.push(`tr() at ${index} has a single argument`);
					else {
						const en = after.slice(1).trimStart();
						if (!en.startsWith(`"`) && !en.startsWith("`")) problems.push(`tr() at ${index} has a non-literal second argument`);
						else {
							// read the second argument and assert no CJK
							const q2 = en[0];
							let j = 1, d2 = 0, e2 = -1;
							while (j < en.length) {
								if (q2 === "`" && en[j] === "$" && en[j + 1] === "{") { d2++; j += 2; continue; }
								if (q2 === "`" && d2 > 0 && en[j] === "}") { d2--; j++; continue; }
								if (en[j] === "\\") { j += 2; continue; }
								if (en[j] === q2 && d2 === 0) { e2 = j; break; }
								j++;
							}
							const body = e2 === -1 ? en : en.slice(1, e2);
							if (/[\u4e00-\u9fff]/.test(body)) problems.push(`tr() English side still Chinese near ${index}: ${body.slice(0, 40)}`);
						}
					}
				}
			} else problems.push(`tr() at ${index} has a non-literal first argument`);
		}
		index = source.indexOf("tr(", index + 1);
	}
	assert.deepEqual(problems, []);
});

await test("no bare Chinese string literal remains in the client bundle", async () => {
	const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	const CJK_ONLY = /[\u4e00-\u9fff]/;
	const offenders = [];
	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (ch === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
		if (ch === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i + 2) + 1; continue; }
		if ((ch === `"` || ch === `'` || ch === "`") && source[i - 1] !== "\\") {
			const quote = ch;
			let j = i + 1, depth = 0, body = "";
			while (j < source.length) {
				if (quote === "`" && source[j] === "$" && source[j + 1] === "{") { depth++; body += "${"; j += 2; continue; }
				if (quote === "`" && depth > 0 && source[j] === "}") { depth--; body += "}"; j++; continue; }
				if (source[j] === "\\") { body += source[j] + source[j + 1]; j += 2; continue; }
				if (source[j] === quote && depth === 0) break;
				body += source[j]; j++;
			}
			if (CJK_ONLY.test(body)) {
				const before = source.slice(Math.max(0, i - 6), i);
				const isTrArg = /tr\(\s*$/.test(before);
				const isLanguageName = body === "中文";
				if (!isTrArg && !isLanguageName) offenders.push(source.slice(i, j + 1).slice(0, 80));
			}
			i = j;
		}
	}
	assert.deepEqual(offenders, []);
});

console.log(process.exitCode ? "\nFAILED" : `\n${passed} passed`);
