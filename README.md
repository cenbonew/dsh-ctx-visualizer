# dsh-ctx-visualizer

> 看清 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 每一次调用模型时，上下文里到底组装了什么。
>
> See exactly what context DeepSeek Harness assembles for every model call — system vs user content, tool schemas, parsed tool calls, tool executions and the follow-up calls — as a per-turn timeline and a dynamic architecture view.

这是一个 DeepSeek Harness 社区插件（`dsh-plugin`），不是官方包。适合想研究 Agent 循环细节的人：
一次「调模型 → 解析工具调用 → 执行工具 → 结果回填 → 再调模型」的多轮交互里，每一步发给模型的
内容是什么、比上一步多了什么、哪一块在膨胀。

## 功能

安装后，会话视图顶部多出一个「**上下文透视**」标签页：

- **左侧 · 轮次**：每轮一张卡片（用户问题、调用次数、工具执行次数、上下文 token、耗时、常用工具），固定窗口可滚动查看较早轮次。
- **顶部 · 横向时间线**：选中轮次内的所有步骤 `第 1 步 · 调模型 → 执行 bash / 结果回填 → 第 2 步 …`，点任意节点切换。
- **右侧 · 明细**（按选中的一步）：
  - **架构**（默认）：根据实际内容动态生成——System 按标题自动拆章节、Tools 按来源（MCP server / 内置）分组、对话历史按用户输入分段画成「用户 → 模型调用 → 工具结果」链条，本步新增高亮，压缩摘要单独标出；右侧是本步流转：请求 → 模型 → 每个工具调用的成败/耗时/结果大小 → 回填下一步。
  - **请求上下文**：默认只看「本步新增」的消息；System / 工具清单未变时自动折叠；上下文构成堆叠条（System / 用户输入 / 工具结果 / 插件注入 / Assistant 历史 / 工具 schema）；输入/输出 token 与缓存命中率。
  - **模型响应**、**工具执行**。
  - **原始 JSON**：完整记录，以及 System content / User content（用户输入、工具结果、注入）/ 模型返回等子模块，全部默认折叠，可单独复制。
- **持久化**：实时捕获写入 `~/.dsh/ctx-visualizer/captures/`，插件重载或 Harness 重启后自动恢复。
- **补录历史**：插件启用之前的步骤，按会话日志重放上下文变化还原（包括上下文压缩），标「重建」。
- **脱敏**：入库前掩去 `Bearer …`、`sk-…`、`tos_…`、`ghp_…`、`xoxb-…` 形态的密钥。

## 兼容性

| 项目 | 版本 |
| --- | --- |
| 开发与验证环境 | DeepSeek Harness Desktop `0.2.0-rc.2`，`@deepseek-ai/dsh-*` `0.2.2-rc.1`（Web GUI） |
| Node.js（运行测试） | ≥ 20 |

DeepSeek Harness 仍处于 Developer Preview，插件依赖的事件与接口可能发生不兼容变更。遇到问题请先确认版本，并[提 issue](https://github.com/cenbonew/dsh-ctx-visualizer/issues)。

## 安装

插件没有任何 npm 依赖，克隆下来即可安装：

```bash
git clone https://github.com/cenbonew/dsh-ctx-visualizer.git
```

然后在 DeepSeek Harness 里安装这个本地 bundle，任选一种方式：

- **让 Agent 安装**：在对话里说「用 Plugin Manager 安装本地 bundle `/绝对路径/dsh-ctx-visualizer`」。
- **设置页**：设置 › 插件（如果你的版本支持从本地路径安装 bundle）。

`package.json` 里的 `dsh.bundle.patch` 让它可以作为 bundle 安装；前端部分由 `dsh.client` 声明，安装后自动接入 Web GUI。

安装后**刷新页面**，在任意会话顶部切到「上下文透视」。插件启用之后的模型调用会被实时捕获，之前的步骤会自动从会话日志补录。

更新：`git pull` 后在 Plugin Manager 里把 bundle 关闭再打开（或重启 Harness），再刷新页面。

## 原理

只读观察，挂在 Harness 的一等事件上，不修改 Agent 循环：

| 事件 / 服务 | 用途 |
| --- | --- |
| `llm/stream`（waterfall） | 拿到每次模型请求完整的 `GenerateOptions`（`messages`、`tools`、model 等），并在原样透传响应流的同时收集文本、推理、工具调用、usage |
| `agent/request` | 关联轮次 / 步骤编号 |
| `tools/execute`、`tools/result` | 工具执行的入参、结果、耗时、成败，按 `callId` 关联回所在步骤 |
| `agent/error` | 记录失败步骤 |
| `sessionQuery.readSession` | 补录：重放 `system/message`、`user/message`、`assistant/message`、`tool/result` 的 `surfaceOp`（append / 按 seq 区间 replace），还原每次调用前的上下文 |

前端是一个 `conversation.view` 槽位插件，通过 typert Remote 读取宿主侧的 `ctxVisualizer` 服务。
另提供 Inspect Provider `CtxVisualizer`，Agent 可以用 `cordis_inspect_query` 查询捕获概况。

所有监听器都包在 try/catch 里，捕获出错不会影响 Agent 本身。

## 配置

暂无配置表单。可以在 profile 的 `cordis.patch.yml` 中给 `ctx-visualizer` 这一行传配置，或直接修改 `lib/index.js` 顶部的 `DEFAULTS`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `capture` | `true` | 总开关 |
| `persist` | `true` | 是否写盘 |
| `persistDir` | `~/.dsh/ctx-visualizer/captures` | 持久化目录（0700，文件 0600） |
| `backfill` | `true` | 是否从会话日志补录 |
| `backfillIntervalMs` | `30000` | 同一会话两次补录的最小间隔 |
| `maxStepsPerSession` | `80` | 每会话保留的实时步数（补录步骤不计） |
| `maxSessions` | `40` | 保留的会话数 |
| `maxCharsPerText` / `maxCharsPerToolResult` | `400000` / `120000` | 单段文本入库截断上限 |
| `redactSecrets` | `true` | 入库前脱敏 |

## 隐私与安全

- 捕获内容是**完整的模型上下文**，可能包含代码、文件内容和工具返回的业务数据。数据只保存在本机，不会上传。
- 默认脱敏只识别常见前缀的密钥，**不能保证**掩去所有敏感信息。分享截图或复制 JSON 前请自行检查。
- 模型回复和推理文本暂未脱敏。
- 工具栏「清空捕获」会同时删除磁盘文件。

## 局限

- 标题生成、上下文压缩等辅助调用不写入会话日志，无法补录（实时捕获时可勾选「显示辅助调用」查看）。
- 文件附件在实际请求中会被投影成文本，补录时显示的是原始附件块。
- 字符数是估算，准确的 token 以 provider 返回的 usage 为准。

## 开发

```bash
npm test   # 自包含测试，不需要安装 Harness，不会写 ~/.dsh
```

- `lib/index.js`：宿主侧（零 npm 依赖，只用 Node 内置模块）
- `lib/client.js`：前端，直接以 Harness 的 `ModuleLoader` 格式手写，无需构建
- `cordis.patch.yml`：bundle patch，插入一行 `ctx-visualizer`

## License

[MIT](LICENSE)
