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
	const react = { useState: (v) => [v, () => {}], useEffect() {}, useRef: () => ({ current: null }), useMemo: (f) => f(), Fragment: "Fragment" };
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

console.log(process.exitCode ? "\nFAILED" : `\n${passed} passed`);
