/**
 * dsh-ctx-visualizer — host half. Zero runtime imports by design:
 * everything the plugin needs from the harness is reached through the
 * Cordis context it is applied to (events, reflect, services), so the
 * package stays resolvable no matter how the installer lays it on disk.
 *
 * Captures, for every model call in this DSH process, EXACTLY what was
 * assembled into the request: the full message list (the leading
 * system-role message = system content; user-role messages = user content,
 * including tool-result messages and plugin injections), the tool schema
 * array, and the streamed response (text / reasoning / parsed tool calls /
 * usage / finish). Tool executions are captured from the tool pipeline and
 * correlated back to the step whose response produced the call, so each
 * step reads as:
 *
 *   [调模型] → [解析工具调用] → [执行工具] → [结果回填 → 再调模型] → …
 *
 * Exposed three ways:
 *   - Cordis Remote service `ctxVisualizer` (mounted by the client half)
 *   - Inspect provider `CtxVisualizer` (cordis_inspect_query from any agent)
 *
 * Live captures are persisted under ~/.dsh/ctx-visualizer/captures (v2 format:
 * one deduplicated message table + per-step message keys). Steps that predate
 * the plugin are rebuilt from the durable session log on demand.
 *
 * Tweaks: pass a config object on the Loader row, or edit DEFAULTS below (no
 * Config schema yet, to keep the package dependency-free).
 */

// Node built-ins always resolve, so the "no package imports" rule still holds.
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "ctx-visualizer";

const DEFAULTS = Object.freeze({
	capture: true,
	maxStepsPerSession: 80,
	maxSessions: 40,
	maxCharsPerText: 400_000,
	maxCharsPerToolResult: 120_000,
	redactSecrets: true,
	/** Persist live captures to disk so reloads / restarts keep them. */
	persist: true,
	persistDir: path.join(os.homedir(), ".dsh", "ctx-visualizer", "captures"),
	/** Rebuild steps that predate the capture from the durable session log. */
	backfill: true,
	/** Minimum gap between two backfill passes for one session (ms). */
	backfillIntervalMs: 30_000,
});

/* ------------------------------------------------------------------ */
/* cordis / typert SRC-mode plumbing without imports                   */
/* ------------------------------------------------------------------ */

const K_TRACKER = Symbol.for("cordis.tracker");
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** Register a plain object as a live Cordis service (like Service's ctor). */
function provideService(ctx, serviceName, instance) {
	instance.ctx = ctx;
	instance.name = serviceName;
	Object.defineProperty(instance, K_TRACKER, {
		configurable: true,
		value: { associate: serviceName, property: "ctx" },
	});
	ctx.reflect.provide(serviceName, instance);
	return instance;
}

/** Replicates @deepseek-ai/dsh-typert-protocol's `mark()` for plain JS. */
function markRemoteMethods(prototype, methodNames) {
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze(methodNames.map((method) => Object.freeze({
				method,
				invocation: Object.freeze({ kind: "direct" }),
			}))),
		}),
	});
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

// Bearer tokens, OpenAI-style sk-…, and prefixed agent keys like tos_….
const SUSPICIOUS_SECRET = /(Bearer\s+)[A-Za-z0-9._\-]{8,}|\b(sk-|tos_|ghp_|xox[bp]-)[A-Za-z0-9._\-]{8,}/g;

function truncate(text, max) {
	if (typeof text !== "string" || text.length <= max) return text;
	const head = Math.ceil(max * 0.7);
	const tail = Math.floor(max * 0.2);
	return text.slice(0, head) + `\n…[ctx-visualizer: truncated ${text.length - head - tail} of ${text.length} chars]\n` + text.slice(text.length - tail);
}

function jsonClone(value) {
	try {
		return JSON.parse(JSON.stringify(value));
	} catch {
		return null;
	}
}

/** Deep-walk a cloned JSON value, truncating long strings in place. */
function clampStrings(node, textMax, toolMax, redact, inToolResult) {
	if (node === null || typeof node !== "object") return node;
	if (typeof node === "string") return node;
	if (Array.isArray(node)) {
		for (let i = 0; i < node.length; i++) node[i] = clampStrings(node[i], textMax, toolMax, redact, inToolResult);
		return node;
	}
	if (node.type === "tool-result") inToolResult = true;
	for (const key of Object.keys(node)) {
		const value = node[key];
		if (typeof value === "string") {
			let out = truncate(value, inToolResult ? toolMax : textMax);
			if (redact) out = out.replace(SUSPICIOUS_SECRET, (_m, p1, p2) => (p1 ?? "") + (p2 ?? "") + "«redacted»");
			node[key] = out;
		} else if (value !== null && typeof value === "object") {
			clampStrings(value, textMax, toolMax, redact, inToolResult);
		}
	}
	return node;
}

/** Cheap stable 32-bit FNV-1a, enough to tell "same content" apart. */
function hashText(text) {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/** Classify one request message into a context bucket. */
function bucketOf(message) {
	if (message?.role === "system") return "system";
	if (message?.role === "assistant") return "assistant";
	const kind = message?.source?.kind;
	if (kind === "user") return "userInput";
	if (kind === "tool") return "toolResult";
	return "injection";
}

/** Text of the first text block, for previews. */
function firstText(content) {
	if (!Array.isArray(content)) return "";
	for (const block of content) if (block?.type === "text" && typeof block.text === "string") return block.text;
	return "";
}

/** Stable identity of one message across steps (id, else content hash). */
function messageKey(message, index) {
	if (message?.id !== undefined && message.id !== null) return String(message.id);
	// position-free so a message keeps its key when history shifts
	return `${message?.role ?? "?"}:${hashText(JSON.stringify(message?.content ?? ""))}`;
}

const factsCache = new WeakMap();
/** Derived, immutable-after-capture facts about one step's request. */
function stepFacts(record) {
	const cached = factsCache.get(record);
	if (cached) return cached;
	const messages = record.request.messages ?? [];
	const breakdown = { system: 0, userInput: 0, toolResult: 0, injection: 0, assistant: 0, tools: approxJsonSize(record.request.tools ?? []) };
	const systemParts = [];
	let userPreview = "";
	const messageIds = [];
	messages.forEach((message, index) => {
		const bucket = bucketOf(message);
		const size = approxJsonSize(message.content);
		breakdown[bucket] += size;
		if (bucket === "system") systemParts.push(JSON.stringify(message.content));
		if (bucket === "userInput") userPreview = firstText(message.content);
		messageIds.push(message.cvKey ?? messageKey(message, index));
	});
	if (typeof record.request.system === "string") {
		breakdown.system += record.request.system.length;
		systemParts.push(record.request.system);
	}
	const facts = {
		breakdown,
		systemHash: hashText(systemParts.join("\u0000")),
		toolsHash: hashText((record.request.tools ?? []).map((t) => JSON.stringify(t)).join("\u0000")),
		messageIds,
		messageIdSet: new Set(messageIds),
		userPreview: userPreview.replace(/\s+/g, " ").slice(0, 80),
		approxChars: record.request.approxChars,
	};
	factsCache.set(record, facts);
	return facts;
}

function approxJsonSize(value) {
	try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

function summarizeMessage(message) {
	const source = message?.source ?? {};
	let origin = source.kind ?? "unknown";
	if (origin === "tool") origin = `tool result ${source.name ?? ""}(${source.callId ?? ""})`.trim();
	else if (origin === "plugin") origin = `plugin injection ${source.plugin ?? ""}`;
	else if (origin === "user") origin = "user input";
	else if (origin === "model") origin = "model output";
	// `origin` stays a language-neutral description (it is stored in captures);
	// `kind` lets the client render a label in the reader's current language.
	return { id: message?.id, role: message?.role, kind: source.kind ?? "unknown", origin, chars: approxJsonSize(message?.content) };
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

let stepCounter = 0;

class CtxVisualizerStore {
	constructor(config) {
		this.#config = config;
		/** sessionId → { steps: Map<id, record>, order: string[] } */
		this.sessions = new Map();
		this.sessionOrder = [];
	}

	#config;
	get #maxSessions() {
		return this.#config.maxSessions ?? 40;
	}
	get #maxSteps() {
		return this.#config.maxStepsPerSession ?? 80;
	}

	#touch(sessionId) {
		let entry = this.sessions.get(sessionId);
		if (entry === undefined) {
			entry = { steps: new Map(), order: [] };
			this.sessions.set(sessionId, entry);
			this.sessionOrder.push(sessionId);
			while (this.sessionOrder.length > this.#maxSessions) {
				const drop = this.sessionOrder.shift();
				this.sessions.delete(drop);
			}
		}
		return entry;
	}

	beginStep(info) {
		// Intern messages per session: consecutive steps resend ~all history, so
		// sharing one object per stable key keeps memory (and disk) linear in the
		// conversation instead of quadratic in the step count.
		const internEntry = this.#touch(info.sessionId ?? "(unknown)");
		const intern = (internEntry.intern ??= new Map());
		const internedMessages = (info.messages ?? []).map((message, index) => {
			if (!message || typeof message !== "object") return message;
			const key = messageKey(message, index);
			const hit = intern.get(key);
			if (hit) return hit;
			message.cvKey = key;
			intern.set(key, message);
			return message;
		});
		const record = {
			id: `cv-${++stepCounter}`,
			sessionId: info.sessionId ?? "(unknown)",
			origin: info.origin ?? "loop",
			purpose: info.purpose,
			turn: info.turn,
			step: info.step,
			provider: info.provider,
			model: info.model,
			startedAt: Date.now(),
			endedAt: null,
			durationMs: null,
			status: "streaming",
			request: {
				messages: internedMessages,
				messageSummaries: internedMessages.map(summarizeMessage),
				system: info.system,
				tools: info.tools ?? [],
				toolCount: (info.tools ?? []).length,
				temperature: info.temperature,
				maxTokens: info.maxTokens,
				stop: info.stop,
				approxChars: approxJsonSize(info.messages ?? []) + approxJsonSize(info.tools ?? []) + (info.system?.length ?? 0),
			},
			response: {
				text: "",
				reasoning: "",
				toolCalls: [],
				usage: null,
				finishReason: null,
			},
			toolRuns: [],
			error: null,
		};
		const entry = this.#touch(record.sessionId);
		entry.steps.set(record.id, record);
		entry.order.push(record.id);
		this.#trimLive(entry);
		this.changed(record.sessionId);
		return record;
	}

	/** Called whenever a live record changes; wired to persistence by apply(). */
	onChange = null;
	changed(sessionId) {
		try { this.onChange?.(sessionId); } catch { /* persistence is best-effort */ }
	}

	/** Cap only live captures; reconstructed steps share message objects and are cheap. */
	#trimLive(entry) {
		const live = entry.order.filter((id) => entry.steps.get(id)?.origin !== "reconstructed");
		while (live.length > this.#maxSteps) {
			const drop = live.shift();
			entry.order.splice(entry.order.indexOf(drop), 1);
			entry.steps.delete(drop);
		}
	}

	/** Insert already-built records (restored from disk or reconstructed), keeping time order. */
	insertRecords(sessionId, records) {
		if (records.length === 0) return;
		const entry = this.#touch(sessionId);
		for (const record of records) {
			if (entry.steps.has(record.id)) continue;
			entry.steps.set(record.id, record);
			entry.order.push(record.id);
		}
		entry.order.sort((a, b) => (entry.steps.get(a)?.startedAt ?? 0) - (entry.steps.get(b)?.startedAt ?? 0));
		this.#trimLive(entry);
	}

	/** Live records of one session (persistence payload). */
	liveRecords(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return [];
		return entry.order.map((id) => entry.steps.get(id)).filter((r) => r && r.origin !== "reconstructed");
	}

	/** (turn:step) keys already covered by a live main-loop capture. */
	liveLoopKeys(sessionId) {
		const keys = new Set();
		for (const record of this.liveRecords(sessionId)) {
			if (record.purpose === undefined && record.turn !== undefined) keys.add(`${record.turn}:${record.step}`);
		}
		return keys;
	}

	/** Replace this session's reconstructed records with a fresh set. */
	replaceReconstructed(sessionId, records) {
		const entry = this.#touch(sessionId);
		for (const id of [...entry.order]) {
			if (entry.steps.get(id)?.origin === "reconstructed") {
				entry.steps.delete(id);
				entry.order.splice(entry.order.indexOf(id), 1);
			}
		}
		this.insertRecords(sessionId, records);
	}

	/** Backfill hook installed by apply(): (sessionId) => Promise<void>. */
	backfiller = null;
	#backfillAt = new Map();
	#backfillRunning = new Map();
	backfillMeta = new Map();
	async ensureBackfilled(sessionId, intervalMs) {
		if (!this.backfiller) return;
		const running = this.#backfillRunning.get(sessionId);
		if (running) return running;
		const last = this.#backfillAt.get(sessionId) ?? 0;
		if (Date.now() - last < intervalMs) return;
		this.#backfillAt.set(sessionId, Date.now());
		const job = (async () => {
			try { await this.backfiller(sessionId); }
			catch (error) { this.backfillMeta.set(sessionId, { error: String(error?.message ?? error), at: Date.now() }); }
			finally { this.#backfillRunning.delete(sessionId); }
		})();
		this.#backfillRunning.set(sessionId, job);
		return job;
	}

	findStepForCall(sessionId, callId) {
		const candidates = [];
		if (typeof sessionId === "string") {
			const entry = this.sessions.get(sessionId);
			if (entry) candidates.push(entry);
		}
		for (const sid of [...this.sessionOrder].reverse()) {
			if (sid === sessionId) continue;
			const entry = this.sessions.get(sid);
			if (entry) candidates.push(entry);
		}
		const key = callId === undefined ? undefined : String(callId);
		for (const entry of candidates) {
			for (let i = entry.order.length - 1; i >= 0; i--) {
				const record = entry.steps.get(entry.order[i]);
				if (!record || record.origin === "reconstructed" || record.response.toolCalls.length === 0) continue;
				if (key !== undefined && record.response.toolCalls.some((call) => String(call.id) === key)) return record;
			}
		}
		// fallback: latest step of the given session (a call id can be dispatched
		// before its producing stream finished parsing on our side)
		const live = sessionId !== undefined ? this.liveRecords(sessionId) : [];
		return live.at(-1);
	}

	addToolRun(sessionId, run) {
		const record = this.findStepForCall(sessionId, run.callId);
		if (!record) return;
		record.toolRuns.push(run);
		this.changed(record.sessionId);
	}

	listSessions() {
		const out = [];
		for (const sessionId of [...this.sessionOrder].reverse()) {
			const entry = this.sessions.get(sessionId);
			if (!entry || entry.order.length === 0) continue;
			const steps = entry.order.map((id) => entry.steps.get(id)).filter(Boolean);
			out.push({
				sessionId,
				steps: steps.length,
				firstAt: steps[0]?.startedAt ?? null,
				lastAt: steps.at(-1)?.startedAt ?? null,
				lastModel: steps.at(-1)?.model ?? null,
			});
		}
		return { sessions: out };
	}

	listSteps(sessionId) {
		const entry = this.sessions.get(sessionId);
		if (!entry) return { steps: [] };
		const steps = [];
		let previous = null;
		/** previous main-loop step's facts, for incremental diffs */
		let prevLoop = null;
		const charsByRole = (record, role) => record.request.messages
			.filter((m) => m.role === role)
			.reduce((sum, m) => sum + approxJsonSize(m.content), 0);
		for (const id of entry.order) {
			const record = entry.steps.get(id);
			if (!record) continue;
			const facts = stepFacts(record);
			const isLoop = record.purpose === undefined;
			const base = isLoop ? prevLoop : null;
			const prevIds = base ? new Set(base.messageIds) : null;
			const newMessageIds = prevIds ? facts.messageIds.filter((mid) => !prevIds.has(mid)) : facts.messageIds;
			const droppedCount = base ? base.messageIds.filter((mid) => !facts.messageIdSet.has(mid)).length : 0;
			steps.push({
				userPreview: facts.userPreview,
				breakdown: facts.breakdown,
				systemHash: facts.systemHash,
				toolsHash: facts.toolsHash,
				systemChanged: base ? base.systemHash !== facts.systemHash : null,
				toolsChanged: base ? base.toolsHash !== facts.toolsHash : null,
				newMessageIds,
				droppedCount,
				usage: record.response.usage,
				toolCallNames: record.response.toolCalls.map((c) => c.name),
				finishReason: record.response.finishReason,
				id: record.id,
				turn: record.turn,
				step: record.step,
				purpose: record.purpose,
				origin: record.origin,
				provider: record.provider,
				model: record.model,
				startedAt: record.startedAt,
				durationMs: record.durationMs,
				status: record.status,
				messageCount: record.request.messages.length,
				systemChars: charsByRole(record, "system") + (record.request.system?.length ?? 0),
				userChars: charsByRole(record, "user"),
				assistantChars: charsByRole(record, "assistant"),
				toolCount: record.request.toolCount,
				requestChars: record.request.approxChars,
				deltaChars: base ? record.request.approxChars - base.approxChars : null,
				parsedToolCalls: record.response.toolCalls.length,
				toolRuns: record.toolRuns.length,
			});
			previous = record.request.approxChars;
			if (isLoop) prevLoop = facts;
		}
		return { steps };
	}

	getStep(sessionId, stepId) {
		const entry = this.sessions.get(String(sessionId));
		const record = entry?.steps.get(String(stepId));
		if (!record) throw new Error(`step ${stepId} not found for session ${sessionId}`);
		return record;
	}

	clearStore() {
		this.sessions.clear();
		this.sessionOrder.length = 0;
		return { cleared: true };
	}
}

/* ------------------------------------------------------------------ */
/* backfill: rebuild steps from the durable session log                */
/* ------------------------------------------------------------------ */

const SURFACE_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);

/** The model-visible message a surface event contributes. */
function surfaceMessage(event) {
	if (event.type === "user/message") return event.data;
	return event.data?.message;
}

/**
 * Replay a session log's surface operations and emit one record per model
 * call (each `assistant/message`). The request of a step is the surface as it
 * stood right before that assistant message landed — the same derivation the
 * agent loop uses — so compaction (a `replace` surface op) is honoured.
 * @param sessionId - owning session.
 * @param events - raw session events in seq order.
 * @param config - resolved plugin config (truncation / redaction).
 * @param skipKeys - `turn:step` keys already covered by live captures.
 * @returns reconstructed records.
 */
function reconstructSteps(sessionId, events, config, skipKeys) {
	/** ordered surface nodes: { seq, message } */
	let surface = [];
	let tools = [];
	let callConfig = {};
	const stepStartedAt = new Map();
	const calls = new Map();
	const byKey = new Map();
	const records = [];
	const prepared = new Map();
	const prep = (message) => {
		const cacheKey = message?.id !== undefined ? `id:${message.id}` : null;
		if (cacheKey && prepared.has(cacheKey)) return prepared.get(cacheKey);
		const clone = clampStrings(jsonClone(message) ?? {}, config.maxCharsPerText, config.maxCharsPerToolResult, config.redactSecrets, false);
		clone.cvKey = messageKey(clone);
		if (cacheKey) prepared.set(cacheKey, clone);
		return clone;
	};
	let preparedTools = [];
	let toolsRef = null;
	let seq = 0;
	for (const event of events) {
		const data = event?.data ?? {};
		const key = `${data.turn}:${data.step}`;
		if (event.type === "request/header") {
			tools = data.header?.tools ?? [];
			callConfig = data.header?.config ?? {};
		} else if (event.type === "step/start") {
			stepStartedAt.set(key, event.time);
		} else if (event.type === "tool/call") {
			calls.set(String(data.callId), { name: data.name, arguments: data.arguments, time: event.time });
		}
		if (event.type === "assistant/message" && !skipKeys.has(key)) {
			if (toolsRef !== tools) { preparedTools = jsonClone(tools) ?? []; toolsRef = tools; }
			const messages = surface
				.map((node) => node.message)
				.filter((m) => m && !(m.role === "system" && (!Array.isArray(m.content) || m.content.length === 0)))
				.map(prep);
			const content = data.message?.content ?? [];
			const toolCalls = content.filter((b) => b?.type === "tool-call").map((b) => ({ id: b.id, name: b.name, arguments: b.arguments ?? "" }));
			const startedAt = stepStartedAt.get(key) ?? event.time;
			const record = {
				id: `cv-r-${sessionId.slice(-8)}-${event.seq ?? ++seq}`,
				sessionId,
				origin: "reconstructed",
				purpose: undefined,
				turn: data.turn,
				step: data.step,
				provider: callConfig.provider,
				model: callConfig.model,
				startedAt,
				endedAt: event.time,
				durationMs: typeof event.time === "number" && typeof startedAt === "number" ? event.time - startedAt : null,
				status: data.interrupted ? "error" : toolCalls.length > 0 ? "tool-calls" : "done",
				request: {
					messages,
					messageSummaries: messages.map(summarizeMessage),
					system: undefined,
					tools: preparedTools,
					toolCount: preparedTools.length,
					temperature: callConfig.temperature,
					maxTokens: callConfig.maxTokens,
					stop: undefined,
					approxChars: approxJsonSize(messages) + approxJsonSize(preparedTools),
				},
				response: {
					text: clampStrings({ v: content.filter((b) => b?.type === "text").map((b) => b.text).join("") }, config.maxCharsPerText, config.maxCharsPerText, config.redactSecrets, false).v,
					reasoning: content.filter((b) => b?.type === "reasoning").map((b) => b.text).join(""),
					toolCalls,
					usage: jsonClone(data.usage) ?? null,
					finishReason: data.interrupted ? "aborted" : toolCalls.length > 0 ? "tool-calls" : "stop",
				},
				toolRuns: [],
				error: data.interrupted ? { message: "This step was interrupted; only the part that had already streamed is preserved" } : null,
			};
			records.push(record);
			byKey.set(key, record);
		}
		if (event.type === "tool/result") {
			const record = byKey.get(key);
			const block = data.message?.content?.[0];
			const callId = String(data.message?.source?.callId ?? block?.toolCallId ?? "");
			if (record) {
				const call = calls.get(callId);
				let args = null;
				try { args = JSON.parse(call?.arguments ?? "null"); } catch { args = call?.arguments ?? null; }
				record.toolRuns.push({
					callId,
					rootCallId: callId,
					nested: false,
					name: call?.name ?? data.message?.source?.name ?? "(unknown)",
					arguments: clampStrings({ v: args }, 4000, config.maxCharsPerToolResult, config.redactSecrets, false).v,
					startedAt: call?.time ?? null,
					endedAt: event.time,
					durationMs: call?.time !== undefined ? event.time - call.time : null,
					isError: block?.isError === true,
					content: clampStrings(jsonClone(block?.content ?? []) ?? [], 4000, config.maxCharsPerToolResult, config.redactSecrets, true),
					meta: undefined,
				});
			}
		}
		if (SURFACE_TYPES.has(event.type)) {
			const message = surfaceMessage(event);
			const op = event.surfaceOp ?? "append";
			if (op === "append" || typeof op !== "object") {
				surface.push({ seq: event.seq, message });
			} else if (op.op === "replace") {
				const first = surface.findIndex((n) => n.seq >= op.startSeq && n.seq <= op.endSeq);
				const kept = surface.filter((n) => !(n.seq >= op.startSeq && n.seq <= op.endSeq));
				const at = first === -1 ? kept.length : first;
				kept.splice(at, 0, { seq: event.seq, message });
				surface = kept;
			}
		}
	}
	return records;
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

function captureFile(dir, sessionId) {
	return path.join(dir, `${encodeURIComponent(sessionId)}.json`);
}

async function writeCapture(dir, sessionId, records) {
	await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = captureFile(dir, sessionId);
	const tmp = `${file}.${process.pid}.tmp`;
	// v2: one shared message table; each step stores message keys only.
	const table = {};
	const compact = records.map((record) => ({
		...record,
		request: {
			...record.request,
			messages: (record.request?.messages ?? []).map((message) => {
				const key = message?.cvKey ?? messageKey(message);
				table[key] = message;
				return key;
			}),
		},
	}));
	await fsp.writeFile(tmp, JSON.stringify({ version: 2, sessionId, savedAt: Date.now(), messages: table, records: compact }), { mode: 0o600 });
	await fsp.rename(tmp, file);
}

async function readCaptures(dir, maxSessions) {
	let names;
	try { names = await fsp.readdir(dir); } catch { return []; }
	const files = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try { files.push({ file: path.join(dir, name), mtime: (await fsp.stat(path.join(dir, name))).mtimeMs }); } catch { /* raced */ }
	}
	files.sort((a, b) => b.mtime - a.mtime);
	const out = [];
	for (const { file } of files.slice(0, maxSessions)) {
		try {
			const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
			if (typeof parsed?.sessionId !== "string" || !Array.isArray(parsed.records)) continue;
			if (parsed.version === 2) {
				const table = parsed.messages ?? {};
				for (const record of parsed.records) {
					const keys = record.request?.messages ?? [];
					record.request.messages = keys.map((key) => table[key]).filter(Boolean);
				}
				out.push(parsed);
			} else if (parsed.version === 1) out.push(parsed);
		} catch { /* skip corrupt file */ }
	}
	return out.reverse();
}

/* ------------------------------------------------------------------ */
/* remote face (src-json, zero codegen)                                */
/* ------------------------------------------------------------------ */

class CtxVisualizerService {
	constructor(store, config) {
		this.store = store;
		this.config = config;
		/** Installed by apply(): wipes persisted files. */
		this.onClear = null;
		this.typertRemote = Object.freeze({
			service: this,
			serviceKey: "ctxVisualizer",
			namespace: "ctxVisualizer",
		});
	}

	async listSessions(signal) {
		return this.store.listSessions();
	}

	async listSteps(sessionId, signal) {
		const id = String(sessionId);
		if (this.config.backfill) await this.store.ensureBackfilled(id, this.config.backfillIntervalMs);
		return { ...this.store.listSteps(id), backfill: this.store.backfillMeta.get(id) ?? null };
	}

	async getStep(sessionId, stepId, signal) {
		return this.store.getStep(String(sessionId), String(stepId));
	}

	/** Force an immediate backfill pass for one session. */
	async backfill(sessionId, signal) {
		const id = String(sessionId);
		await this.store.ensureBackfilled(id, 0);
		return this.store.backfillMeta.get(id) ?? null;
	}

	async clearStore(signal) {
		const result = this.store.clearStore();
		try { await this.onClear?.(); } catch { /* ignore */ }
		return result;
	}
}

markRemoteMethods(CtxVisualizerService.prototype, ["listSessions", "listSteps", "getStep", "backfill", "clearStore"]);

/* ------------------------------------------------------------------ */
/* stream collection                                                   */
/* ------------------------------------------------------------------ */

function makeCollector(record, onSettled) {
	const texts = new Map();
	const reasonings = new Map();
	const calls = new Map();
	return async function* wrap(upstreamOrPromise) {
		try {
			const upstream = await upstreamOrPromise;
			for await (const chunk of upstream) {
				try {
					if (chunk.type === "text-delta") texts.set(chunk.index, (texts.get(chunk.index) ?? "") + chunk.text);
					else if (chunk.type === "reasoning-delta") reasonings.set(chunk.index, (reasonings.get(chunk.index) ?? "") + chunk.text);
					else if (chunk.type === "tool-call-delta") {
						const current = calls.get(chunk.index) ?? { id: chunk.id, name: undefined, arguments: "" };
						if (chunk.name !== undefined) current.name = chunk.name;
						if (chunk.id !== undefined) current.id = chunk.id;
						current.arguments += chunk.argumentsDelta ?? "";
						calls.set(chunk.index, current);
					} else if (chunk.type === "block-end" && chunk.block?.type === "tool-call") {
						calls.set(chunk.index, { id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments ?? "" });
					} else if (chunk.type === "usage") {
						record.response.usage = jsonClone(chunk.usage) ?? record.response.usage;
					} else if (chunk.type === "finish") {
						record.response.finishReason = chunk.reason ?? null;
					}
					record.response.text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join("");
					record.response.reasoning = [...reasonings.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join("");
					record.response.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
				} catch { /* a broken chunk must never break the stream */ }
				yield chunk;
			}
			record.response.text = [...texts.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join("");
			record.response.reasoning = [...reasonings.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).join("");
			record.response.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
		} catch (error) {
			record.status = "error";
			record.error = { message: String(error?.message ?? error) };
			throw error;
		} finally {
			record.endedAt = Date.now();
			record.durationMs = record.endedAt - record.startedAt;
			if (record.status === "streaming") record.status = record.response.toolCalls.length > 0 ? "tool-calls" : "done";
			try { onSettled?.(); } catch { /* ignore */ }
		}
	};
}

/* ------------------------------------------------------------------ */
/* plugin apply                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx, pluginConfig) {
	const config = { ...DEFAULTS, ...(typeof pluginConfig === "object" && pluginConfig !== null ? pluginConfig : {}) };

	if (config.capture === false) {
		ctx.logger?.info?.("ctx-visualizer: capture disabled by config");
		return;
	}

	const log = (level, message, error) => {
		try { ctx.logger?.[level]?.(`ctx-visualizer: ${message}`, error ?? ""); } catch { /* ignore */ }
	};

	const store = new CtxVisualizerStore(config);
	const service = new CtxVisualizerService(store, config);
	provideService(ctx, "ctxVisualizer", service);

	// ── persistence: restore, then save live records (debounced per session) ──
	if (config.persist) {
		const timers = new Map();
		const save = async (sessionId) => {
			timers.delete(sessionId);
			try { await writeCapture(config.persistDir, sessionId, store.liveRecords(sessionId)); }
			catch (error) { log("warn", `persist failed for ${sessionId}`, error); }
		};
		store.onChange = (sessionId) => {
			if (timers.has(sessionId)) clearTimeout(timers.get(sessionId));
			timers.set(sessionId, setTimeout(() => void save(sessionId), 1500));
		};
		service.onClear = async () => {
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
			let names = [];
			try { names = await fsp.readdir(config.persistDir); } catch { return; }
			await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => fsp.rm(path.join(config.persistDir, name), { force: true })));
		};
		// flush pending writes when the plugin unloads (reload / shutdown)
		ctx.effect(() => () => {
			for (const [sessionId, t] of timers) { clearTimeout(t); void save(sessionId); }
		}, "ctx-visualizer: flush captures");
		void readCaptures(config.persistDir, config.maxSessions).then((files) => {
			for (const file of files) {
				for (const record of file.records) {
					const n = Number(String(record.id).replace(/^cv-/, ""));
					if (Number.isFinite(n) && n > stepCounter) stepCounter = n;
					if (record.status === "streaming") record.status = "error", record.error ??= { message: "Capture was interrupted while streaming (plugin reload or process exit)" };
				}
				store.insertRecords(file.sessionId, file.records);
				const entry = store.sessions.get(file.sessionId);
				if (entry) {
					const intern = (entry.intern ??= new Map());
					for (const record of file.records) for (const m of record.request?.messages ?? []) if (m?.cvKey && !intern.has(m.cvKey)) intern.set(m.cvKey, m);
				}
			}
			if (files.length > 0) log("info", `restored ${files.length} captured session(s)`);
		}, (error) => log("warn", "restore failed", error));
	}

	// ── backfill: rebuild pre-capture steps from the session log ──
	if (config.backfill) {
		ctx.inject(["sessionQuery"], (inner) => {
			store.backfiller = async (sessionId) => {
				const snapshot = await inner.sessionQuery.readSession(sessionId);
				const events = snapshot?.events ?? [];
				const records = reconstructSteps(sessionId, events, config, store.liveLoopKeys(sessionId));
				store.replaceReconstructed(sessionId, records);
				store.backfillMeta.set(sessionId, { at: Date.now(), steps: records.length, events: events.length, inherited: snapshot?.inheritedEventCount ?? 0 });
			};
			return () => { store.backfiller = null; };
		});
	}

	/** sessionId → { turn, step } set by agent/request just before each loop call */
	const pendingTurnStep = new Map();

	// ① per-step turn/step correlation from the agent loop's frozen call config
	ctx.on("agent/request", async (payload, next) => {
		try {
			const sessionId = payload?.agent?.session?.id ?? payload?.agent?.sessionId;
			if (typeof sessionId === "string") pendingTurnStep.set(sessionId, { turn: payload.turn, step: payload.step });
		} catch { /* correlation is best-effort */ }
		return await next();
	});

	// ② the model call itself: this is the assembled context, byte-for-byte
	ctx.on("llm/stream", function (options, next) {
		// next() exactly once: adapters are lazy, so wrapping the returned
		// iterable still captures the full stream.
		const upstream = next();
		try {
			const sessionId = typeof options?.sessionId === "string" ? options.sessionId : undefined;
			const marked = pendingTurnStep.get(sessionId ?? "");
			const pending = options?.purpose === undefined ? marked : undefined;
			if (sessionId !== undefined && marked !== undefined && options?.purpose === undefined) pendingTurnStep.delete(sessionId);
			const record = store.beginStep({
				sessionId,
				origin: sessionId !== undefined && options?.purpose === undefined ? "loop" : "direct",
				purpose: options?.purpose,
				turn: pending?.turn,
				step: pending?.step,
				provider: options?.provider,
				model: options?.model,
				messages: clampStrings(jsonClone(options?.messages ?? []) ?? [], config.maxCharsPerText, config.maxCharsPerToolResult, config.redactSecrets, false),
				system: typeof options?.system === "string" ? truncate(options.system, config.maxCharsPerText) : undefined,
				tools: jsonClone(options?.tools ?? []) ?? [],
				temperature: options?.temperature,
				maxTokens: options?.maxTokens,
				stop: options?.stop,
			});
			return makeCollector(record, () => store.changed(record.sessionId))(upstream);
		} catch (error) {
			log("warn", "failed to begin capture for a model call", error);
			return upstream;
		}
	});

	// ③ tool dispatch start (for durations)
	const startedAtByCall = new Map();
	ctx.on("tools/execute", async (exec, next) => {
		try {
			if (exec?.callId !== undefined) startedAtByCall.set(String(exec.callId), Date.now());
		} catch { /* best effort */ }
		return await next();
	});

	// ④ tool outcome: the frozen final result, correlated to its step
	ctx.on("tools/result", (exec, result) => {
		try {
			const callId = String(exec?.callId ?? "");
			const sessionId = exec?.agent?.session?.id ?? exec?.agent?.sessionId;
			const content = clampStrings(jsonClone(result?.content ?? []) ?? [], 4000, config.maxCharsPerToolResult, config.redactSecrets, true);
			store.addToolRun(sessionId, {
				callId,
				rootCallId: exec?.rootCallId !== undefined ? String(exec.rootCallId) : callId,
				nested: exec?.rootCallId !== undefined && String(exec.rootCallId) !== callId,
				name: exec?.name ?? "(unknown)",
				arguments: clampStrings(jsonClone({ v: exec?.arguments ?? null }) ?? { v: null }, 4000, config.maxCharsPerToolResult, config.redactSecrets, false).v,
				startedAt: startedAtByCall.get(callId) ?? null,
				endedAt: Date.now(),
				durationMs: startedAtByCall.has(callId) ? Date.now() - startedAtByCall.get(callId) : null,
				isError: result?.isError === true,
				content,
				meta: jsonClone(result?.meta) ?? undefined,
			});
			startedAtByCall.delete(callId);
		} catch (error) {
			log("warn", "failed to record tool run", error);
		}
	});

	// ⑤ step-level errors (request failure after retries etc.)
	ctx.on("agent/error", (payload) => {
		try {
			const sessionId = payload?.agent?.session?.id ?? payload?.agent?.sessionId;
			const entry = sessionId !== undefined ? store.sessions.get(sessionId) : undefined;
			const lastId = entry?.order.at(-1);
			const record = lastId !== undefined ? entry.steps.get(lastId) : undefined;
			if (record) {
				record.status = "error";
				record.error = { message: String(payload?.error?.message ?? payload?.error), turn: payload.turn, step: payload.step };
				store.changed(record.sessionId);
			}
		} catch { /* best effort */ }
	});

	// Inspect provider: lets any agent (and this very session) read captures via
	// cordis_inspect_query — the built-in self-verification path.
	ctx.inject(["cordisInspect"], (inner) => {
		inner.effect(() => inner.cordisInspect.register({
			manifest: {
				id: "CtxVisualizer",
				description: "Captured model-call contexts (system vs user content, tools, tool runs) per session.",
				methods: [{
					name: "listRecent",
					description: "List captured sessions, or one session's step summaries with { session }.",
					inputSchema: {
						type: "object",
						properties: { session: { type: "string", description: "Session id to list step summaries for. Omit to list sessions." } },
						additionalProperties: false,
					},
					outputSchema: { description: "JSON data owned by this inspect provider." },
				}],
			},
			async query(method, input, context) {
				if (method !== "listRecent") throw new Error(`unknown CtxVisualizer inspect method "${method}"`);
				if (input && typeof input.session === "string") {
					if (config.backfill) await store.ensureBackfilled(input.session, config.backfillIntervalMs);
					return { ...store.listSteps(input.session), backfill: store.backfillMeta.get(input.session) ?? null };
				}
				// Directory view: make sure the asking agent's own session is backfilled.
				const ownRaw = context?.agent?.session?.id ?? context?.agent?.sessionId ?? context?.agent?.id;
				const own = typeof ownRaw === "string" ? ownRaw : undefined;
				if (config.backfill) {
					const targets = new Set(typeof own === "string" ? [own] : []);
					for (const id of [...store.sessionOrder].reverse().slice(0, 3)) targets.add(id);
					await Promise.all([...targets].map((id) => store.ensureBackfilled(id, config.backfillIntervalMs)));
				}
				const listing = store.listSessions();
				return {
					diagnostics: { backfillEnabled: config.backfill, backfillReady: store.backfiller !== null, askingSession: typeof own === "string" ? own : null, persistDir: config.persist ? config.persistDir : null },
					sessions: listing.sessions.map((s) => {
						const records = store.sessions.get(s.sessionId);
						const reconstructed = records ? records.order.filter((id) => records.steps.get(id)?.origin === "reconstructed").length : 0;
						return { ...s, reconstructed, live: s.steps - reconstructed, backfill: store.backfillMeta.get(s.sessionId) ?? null };
					}),
				};
			},
		}), "ctx-visualizer: inspect provider");
	});
}
