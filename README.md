# dsh-ctx-visualizer

English | [简体中文](README.zh-CN.md)

> See exactly what context [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) assembles for every model call — system vs user content, tool schemas, parsed tool calls, tool executions and the follow-up calls — as a per-turn timeline and a dynamic architecture view.

A community plugin for DeepSeek Harness (tagged `dsh-plugin`), not an official package. It is for anyone who wants to study the agent loop in detail: inside one multi-turn exchange — *call the model → parse tool calls → execute tools → feed results back → call the model again* — what exactly was sent to the model at each step, what was added compared with the previous step, and which part is growing.

## Features

After installing, the conversation header gains a **Context Lens** tab:

- **Left · turns**: one card per turn (user question, call count, tool-run count, context tokens, elapsed time, most-used tools). The column is a fixed-height window you can scroll to reach earlier turns.
- **Top · horizontal timeline**: every step inside the selected turn — `Step 1 · model call → runs bash / results fed back → Step 2 …`. Click any node to switch.
- **Right · detail** for the selected step:
  - **Architecture** (default): generated dynamically from the actual content — the system prompt is split into sections by its own headings, tools are grouped by origin (MCP server / built-in), and the conversation history is drawn as `user → model call → tool result` chains per user input, with messages new to this step highlighted and compaction summaries called out. On the right, this step's flow: request → model → each tool call's outcome/duration/result size → fed back into the next request.
  - **Request context**: shows only the messages *new in this step* by default; system content and the tool list collapse automatically when unchanged; a stacked bar of the context composition (system / user input / tool results / plugin injections / assistant history / tool schemas); input/output tokens and cache-hit rate.
  - **Response** and **Tool runs**.
  - **Raw JSON**: the full record plus sub-blocks for system content, user content (user input, tool results, injections) and the model response — all collapsed by default and individually copyable.
- **Persistence**: live captures are written to `~/.dsh/ctx-visualizer/captures/` and restored after a plugin reload or a Harness restart.
- **Backfill**: steps from before the plugin was enabled are rebuilt by replaying the session log's context changes (including compaction) and marked as *rebuilt*.
- **Redaction**: secrets shaped like `Bearer …`, `sk-…`, `tos_…`, `ghp_…`, `xoxb-…` are masked before storage.
- **Language**: follows the Harness locale automatically (Chinese/English), with a manual switcher in the toolbar; the choice is remembered.

## Compatibility

| Item | Version |
| --- | --- |
| Developed and verified on | DeepSeek Harness Desktop `0.2.0-rc.2`, `@deepseek-ai/dsh-*` `0.2.2-rc.1` (Web GUI) |
| Node.js (to run the tests) | ≥ 20 |

DeepSeek Harness is still in Developer Preview, so the events and interfaces this plugin relies on may change incompatibly. If something breaks, check the version first and [open an issue](https://github.com/cenbonew/dsh-ctx-visualizer/issues).

## Install

The plugin has no npm dependencies, so cloning is enough:

```bash
git clone https://github.com/cenbonew/dsh-ctx-visualizer.git
```

Then install that local bundle in DeepSeek Harness, either way:

- **Ask the agent**: say “install the local bundle at `/absolute/path/dsh-ctx-visualizer` with the Plugin Manager”.
- **Settings page**: Settings › Plugins (if your build supports installing a bundle from a local path).

`dsh.bundle.patch` in `package.json` is what makes it installable as a bundle; the frontend half is declared by `dsh.client` and joins the Web GUI automatically.

After installing, **refresh the page** and switch to “Context Lens” at the top of any conversation. Model calls made after the plugin was enabled are captured live; earlier steps are backfilled from the session log automatically.

To update: `git pull`, then toggle the bundle off and on in the Plugin Manager (or restart Harness) and refresh the page.

## How it works

Read-only observation built on first-class Harness events; the agent loop is never modified:

| Event / service | Purpose |
| --- | --- |
| `llm/stream` (waterfall) | Receives the full `GenerateOptions` of every model request (`messages`, `tools`, model, …) and collects text, reasoning, tool calls and usage while passing the response stream through unchanged |
| `agent/request` | Associates turn / step numbers |
| `tools/execute`, `tools/result` | Tool arguments, results, duration and outcome, correlated back to their step by `callId` |
| `agent/error` | Records failed steps |
| `sessionQuery.readSession` | Backfill: replays the `surfaceOp` (append / replace over a seq range) of `system/message`, `user/message`, `assistant/message` and `tool/result` to reconstruct the context each call received |

The frontend is a `conversation.view` slot plugin that reads the host-side `ctxVisualizer` service over typert Remote. An Inspect Provider named `CtxVisualizer` is also registered so an agent can query capture status with `cordis_inspect_query`.

Every listener is wrapped in try/catch, so a capture failure never affects the agent itself.

## Configuration

There is no settings form yet. Pass config to the `ctx-visualizer` row in the profile's `cordis.patch.yml`, or edit `DEFAULTS` at the top of `lib/index.js`:

| Key | Default | Meaning |
| --- | --- | --- |
| `capture` | `true` | Master switch |
| `persist` | `true` | Write captures to disk |
| `persistDir` | `~/.dsh/ctx-visualizer/captures` | Capture directory (0700, files 0600) |
| `backfill` | `true` | Rebuild earlier steps from the session log |
| `backfillIntervalMs` | `30000` | Minimum gap between two backfills of one session |
| `maxStepsPerSession` | `80` | Live steps kept per session (rebuilt steps do not count) |
| `maxSessions` | `40` | Sessions kept |
| `maxCharsPerText` / `maxCharsPerToolResult` | `400000` / `120000` | Truncation bound per stored text block |
| `redactSecrets` | `true` | Redact before storage |

## Privacy and security

- Captures are the **full model context** and may contain code, file contents and business data returned by tools. Everything stays on this machine; nothing is uploaded.
- The default redaction only recognises well-known secret prefixes and **cannot** mask every sensitive value. Check before sharing a screenshot or a copied JSON block.
- Model replies and reasoning text are not redacted yet.
- “Clear captures” in the toolbar also deletes the files on disk.

## Limitations

- Auxiliary calls such as session-title generation and context compaction are not part of the session log, so they cannot be backfilled (tick “Show aux calls” to see them when captured live).
- File attachments are projected to text in the actual request, so a rebuilt step shows the original attachment blocks.
- Character counts are estimates; for exact token counts, trust the usage reported by the provider.

## Development

```bash
npm test   # self-contained; needs no Harness install and never writes to ~/.dsh
```

- `lib/index.js` — host half (zero npm dependencies, Node built-ins only)
- `lib/client.js` — frontend, hand-written in Harness's `ModuleLoader` format; no build step
- `cordis.patch.yml` — bundle patch that inserts the `ctx-visualizer` row

## License

[MIT](LICENSE)
