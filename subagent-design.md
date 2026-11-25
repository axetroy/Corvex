# 子代理（sub-agent）调研与设计方案

本文调研主流编码 Agent 的子代理实现，并给出 Corvex 的落地方案。当前状态：**规划中，未实现**（见 `ROADMAP.md`）。执行环境（`execution-design.md`）是可读终端与命令执行的前置能力，子代理会复用它的授权边界。

## 1. 主流实现调研（2026-11）

| 产品 | 入口工具 | 上下文传递 | 工具/权限 | 前台/后台 | 并行与隔离 | 结果回传 |
|---|---|---|---|---|---|---|
| **Claude Code** | `AgentTool`（旧名 `Task`），参数 `description` / `prompt` / `subagent_type` / `model` / `run_in_background` | 默认全新上下文，只有委派 prompt；`fork` 模式继承父上下文 | 内置 Explore（只读）、Plan、General-purpose、Verification；定义于 `.claude/agents/*.md`，frontmatter 可配 `tools`/`disallowedTools`/`model`/`permissionMode`/`maxTurns`/`isolation` | 前台同步；后台任务完成后经 task-notification 在**后续轮次**注入 | 并发来自通用工具编排：`isConcurrencySafe()=true` → 同一消息里的多个 `Agent` 调用并行；`isolation: worktree` 给子代理独立副本 | **只回传最终文本 + 元信息**，完整 sidechain 轨迹写独立 JSONL，不进父上下文 |
| **OpenCode** | `subagent` 工具（参数 `agent`/`description`/`prompt`/`model`/`sessionID`） | 全新 child session，不拷贝父消息；子 prompt 前缀 "You are a subagent spawned by another session." | agent 定义含 `mode: primary/subagent/all`、`step`、权限规则；父的 `subagent` 权限决定可启动哪些；子默认禁用 `task` 与 `todowrite` | **永远后台**：返回 `sessionID` + `status: running`，子空闲时经合成 user 消息唤醒父 | 深度限制 `experimental.subagent_depth` 默认 1；同 `sessionID` 可续跑/切换 agent/model；结果注入带 `steer` delivery | 最终一条 assistant 文本包进 `<task_result>`；错误转成父会话可读的工具错误 |
| **Cursor** | `Task` 工具 | 全新上下文，父需在 prompt 里写全所需信息 | 自定义 agent 支持 `readonly`、`model`、`is_background`；内置 Explore（快模型、只读）与 Browser（过滤 DOM 噪声） | 前台阻塞或后台立即返回 | 一条消息多个 `Task` 调用即并行；可要求每个子代理独立 worktree/云 VM 分支 | 最终消息回传；后台运行期间把输出写到 `~/.cursor/subagents/` 供父读取 |
| **Codex CLI / ChatGPT Work** | `spawn_agent` + `wait_agent` / 完成通知 | 默认全新；`fork_context: true` 可完整拷贝（0.162 起只有全量/无两档） | 子代理继承父 sandbox/权限；agent 文件可收紧为 `read-only`；`agents.max_concurrent_threads_per_session` 默认 6 | 立即返回 thread ID，父用 `wait_agent` 收集（默认 30s，最长 1h）；无真正脱离式后台 | 后台线程可 `/subagents` 查看/切换/停止；`close_agent` 关闭后释放并发额度 | 只回传状态与最终消息，不含日志与工具输出 |
| **Pi SDK 自带示例** | `subagent` 扩展 | 每个子代理起一个**独立 `pi` 进程**，`--mode json -p --no-session` | agent 定义来自用户/项目目录，frontmatter `name`/`description`/`tools`/`model` | 支持 single / parallel / chain 三种模式 | `MAX_PARALLEL_TASKS=8`、`MAX_CONCURRENCY=4`，每任务输出上限 50 KiB | JSON 模式取最终输出；`onUpdate` 期间把部分结果推给父展示 |

### 共识与分歧

**共识**（几乎所有实现都这么做）：

1. **上下文隔离是核心价值**：子代理自己消耗探查/日志/大段文件内容的 token，父只收摘要，避免 context pollution / context rot。
2. **默认全新上下文**：父必须写一份自包含的任务 prompt；只有显式 fork 才继承父历史。
3. **只回传最终结果**：完整子轨迹保留在别处，不进父会话历史。
4. **工具集按定义收窄**：Explore 类只读；写权限和嵌套启动默认禁止或受限。
5. **并发来自工具编排或显式并行调用**，不是单独的调度器；同时限制并发/深度。
6. **可续跑**：返回 agent/thread/session ID，后续可带着已有上下文继续。

**分歧**：前台 vs 后台（Claude 两者都有、OpenCode 强制后台、Codex 折中）；隔离级别（上下文隔离 / worktree 隔离 / 云 VM）；是否允许嵌套（OpenCode 默认深度 1）。

## 2. Corvex 的约束

这些约束决定了不能照搬任何一家：

- **单进程 + SQLite**：Server 内联执行轮次，没有 CLI 子进程可复用（Pi SDK 示例的 `pi` 进程方案不适用）；
- **一切授权在 Corvex 代码里**：子代理不能绕过 worktree 路径守卫、Git/命令工具的绑定、按用户 OAuth 令牌的网络调用；
- **不可信仓库内容**：项目里的 agent 定义文件是仓库数据，只能**收窄**工具，绝不能扩大权限或覆盖系统提示；
- **已有基础设施可复用**：`PiAgent` / `runSession`、`SessionManager.inMemory`、按轮克隆的配置与用户模型选择、`conversation_trace`、`redact`、`AbortSignal` 取消链、`execOutput` 回放；
- **并发安全**：同一对话的轮次已经串行；子代理共享同一 worktree，默认只允许只读探查，写操作需要显式隔离。

## 3. 建议方案

### 3.1 入口与形态

新增工具 `spawn_subagent`（内部名，模型可见），参数：

```
{ agent: string; task: string; model?: string; resume?: string }
```

- `agent`：子代理定义名；`task`：自包含任务描述（**必填且要求写全路径与背景**）；
- `model`：可选，不指定则继承当前轮的用户模型（与 OpenCode / Pi 一致）；
- `resume`：子代理运行 ID，续跑已有子会话。

**先做前台同步**（父等待结果再继续），不做后台通知通道——它要新增一套"把子结果作为后续轮次注入"的机制，复杂度高且当前 UI 没有对应的通知位。后台留到 P2。

### 3.2 子代理定义

- 管理员在运维台维护（存 SQLite `subagent_definitions`，与技能同风格），字段：`name` / `description` / `systemPrompt` / `tools`（允许列表）/ `readonly` / `maxRounds` / `maxOutputTokens`；
- 同时支持从固定 SHA 的 worktree 读取 `.corvex/agents/*.md`（frontmatter 同 Pi 示例），**但仓库定义只能缩小工具集**，不能引入父会话没有的工具，也不能覆盖系统提示；
- 内置两个：`explore`（只读 fs + `tree`/`glob`/`search_text`/`git_grep`/只读 Git）、`reviewer`（只读 + `git_diff`）；默认都不给 `run_command` 和写工具。

### 3.3 执行链路

1. `ConversationRunner` 把 `spawn_subagent` 注册进本轮的 Pi 工具集（仅当 `agent.subagentsEnabled` 开启）；
2. 工具 `execute` 里为本次调用创建独立的 `SessionManager.inMemory()`，复用 `PiAgent` 的 `runSession`，构造一个 `ModelRequest`：
   - `taskType: "subagent"`，`conversationId` / `turnId` 指向父轮（用于审计关联）；
   - `systemPrompt` = 子代理定义 prompt + 精简的 Corvex 能力说明（不含父轮 currentRequest）；
   - `userPrompt` = 模型写的 `task`（自包含）；
   - `history` 为空（全新上下文）；
   - 工具集 = 父工具集 ∩ 定义允许列表，并且**强制去掉** `spawn_subagent`（默认深度 1）、写工具与 GitLab 写工具（除非定义显式允许且非只读）；
   - `signal` = 父轮 signal（整轮取消时子代理一起取消），并给每个子代理独立 controller 以支持单子代理停止；
3. 子代理的完整轨迹写 `conversation_trace`，`name` 前缀 `subagent:<name>`、携带 `subAgentRunId`，与父轨迹同库但可过滤；不写 `conversation_messages`；
4. 只把子代理**最终 assistant 文本**作为工具结果回传父模型（截断到 `maxOutputTokens`），前者的中间思考与工具输出不进父上下文；
5. `conversation_subagent_runs` 记录运行 ID、父轮、定义名、模型、状态、起止时间、token 用量、结果摘要，供 Trace 标签与审计展示。

### 3.4 安全与边界（不可协商）

- 子代理工具集是父工具集的**子集**；`allowed-tools` 只做减法；
- 只读定义下禁止一切写工具（fs 写、Git 写、GitLab 写、`run_command`）；
- 子代理与父共享 worktree，但路径守卫仍是 `resolveWorktreePath`，不允许绝对路径或越界；
- 网络工具沿用同一套 SSRF 守卫与按用户令牌；
- 深度默认 1，并发默认 2（可配 `agent.subagentMaxConcurrent` / `subagentDepth`），超限直接报错而不是排队失控；
- 子代理输出按不可信数据处理：脱敏、限长，且不能把"我做过 X"当证据（沿用 `claim-verification` 的读回要求）；
- 取消：父轮取消 → 所有子代理 abort；单子代理停止只 abort 它自己。

### 3.5 分阶段

| 阶段 | 内容 |
|---|---|
| P0 | `spawn_subagent` 工具 + SQLite 定义（内置 explore/reviewer）+ 前台同步执行 + 全新上下文 + 只读工具集 + 深度 1 + trace/运行记录 |
| P1 | 运维台定义管理 UI、Trace 子代理轨道与运行详情、`resume` 续跑、并发上限与 token 预算 |
| P2 | 后台子代理（完成通知注入后续轮次）、worktree 隔离（写型子代理）、可选的 chain/parallel 编排 |

## 4. 测试策略

- 子代理工具集 ⊆ 父工具集；只读定义强行剥离写工具与 `run_command`；仓库定义无法扩权；
- 父上下文不被子会话历史污染（子轨迹只在 `conversation_trace`，且带 `subAgentRunId`）；
- 父轮取消连带 abort 子代理；单个子代理停止不影响其它；
- 子代理输出脱敏与限长；无结果时父模型收到明确错误而不是空文本；
- 深度/并发超限时报错并可配置。

## 5. 与现有能力的关系

- **技能**（SKILL.md）是注入当前上下文的指令；子代理是独立会话，**不要把技能当子代理用**。若要让子代理使用技能，在定义里显式列出并在子 prompt 中注入；
- **执行环境**给子代理提供 `run_command` 的可能性，但默认关闭；Verification 型子代理可在定义中显式开启；
- **可读终端**的 `exec` 事件属于父轮 SSE；子代理的命令输出只进子轨迹，不污染父终端。
