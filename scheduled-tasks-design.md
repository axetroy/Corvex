# 计划任务（scheduled tasks）调研与设计方案

本文调研主流编码 Agent 的"定时/自然语言计划任务"，并给出 Corvex 的落地方案。当前状态：**P0/P1/P2 已实现**（见 `ROADMAP.md`）。已实现：数据表与 cron 解析、Server 到期循环与原子领取、模型侧创建/列出/取消工具、`/api/ops/me` 接口与管理页、30 天过期、按 ID 确定性 jitter、IANA 用户时区、暂停/恢复与手动触发、运行历史气泡。Webhook 事件触发与"每次新建独立对话执行"仍延期（见 `ROADMAP.md` 的 Webhook 事件章节）.计划任务复用对话轮次（`ConversationRunner`）与按用户 OAuth 令牌的授权边界，不引入新的执行器。

## 1. 主流实现调研（2026-11）

### 1.1 Claude Code：三种调度形态

Claude Code 官方文档把调度分成三层，边界清晰：

| 形态 | 运行位置 | 是否需会话 | 是否持久 | 访问本地文件 | 最小间隔 |
|---|---|---|---|---|---|
| **Cloud / Routines** | Anthropic 云 | 否 | 是 | 否（fresh clone） | 1 小时 |
| **Desktop 计划任务** | 本机 | 否 | 是 | 是 | 1 分钟（表单 1 小时） |
| **`/loop` + Cron 工具** | 本机当前会话 | 是 | `--resume` 恢复（有例外） | 是 | 1 分钟 |

关键机制（值得借鉴）：

- **自然语言入口**：用户说"45 分钟后检查集成测试"、"remind me at 3pm…"，模型把它转成 5 段 cron 表达式并**确认触发时间**；`/loop 5m check the deploy` 里模型把 `5m` 转成 cron，回报 job ID 与下次运行时间。
- **底层只有三个工具**：`CronCreate`（5 段 cron + prompt + 是否循环）、`CronList`（列出 ID/计划/下次运行/prompt）、`CronDelete`（按 ID 取消）。任务 ID 8 字符；单会话最多 50 个。
- **模型自定节奏**：只给 prompt 不给间隔时，模型每轮结束自己选 1–60 分钟的下次唤醒（忙碌时短、空闲时长），并在输出里打印所选延迟与原因。
- **执行语义**：调度器每秒检查到期任务，以**低优先级入队**；任务在**两轮之间**触发，模型正在回复时等当前轮结束；**不补跑**错过的触发（忙过后只跑一次）。
- **Jitter 防惊群**：循环任务普遍延迟（最多半小时或到下次间隔的一半），整点/半点的一次性任务提前最多 90 秒；每 5 分钟的任务提前 15 秒（贴合 prompt cache TTL）。
- **过期保护**：循环任务创建 30 天后自动过期（最后跑一次后自删），防止被遗忘的 loop 永久运行。
- **内置维护 prompt**：裸 `/loop` 用一段固定 prompt（继续未完成工作 → 照看 PR/CI → 空闲时做清理），可用项目/用户的 `loop.md` 覆盖。
- **停止语义**：固定间隔循环必须显式取消；自定节奏可在空闲时 `Esc`/`Ctrl+C` 停；模型也能用 `ScheduleWakeup(stop:true)` 自己收尾。

### 1.2 Codex / ChatGPT Automations

- **Automations** 在后台周期性运行 prompt，可查看 active / paused / completed 与近期运行记录；支持从 GitHub/Gmail/Slack 等事件触发（不只时钟）。
- 社区需求（issue #25466）提出与 Claude 同构的会话内工具：`CronCreate` / `CronList` / `CronDelete` + `ScheduleWakeup`，用于"把 prompt 排到未来并自动唤醒继续长任务"。
- 非交互场景用 `codex exec` 跑一次性任务，配合外部 cron；默认只读沙箱，需要写时显式放开。

### 1.3 Cursor / OpenCode

- Cursor 的 subagent 与 Background Agent 更像"事件/并行"而非 cron；定时能力主要靠外部调度 + CLI。
- OpenCode 以 subagent/后台任务为主，文档未见一等公民 cron。

### 1.4 共识与可借鉴点

1. **自然语言 → cron，且要回显确认**：不要让用户输入 cron；把"每周一 9 点"解析成 `0 9 * * 1`，显示可读的下次运行时间再落地。
2. **最小化原语**：只需 create/list/delete（外加 pause/enable），不需要复杂 UI 表达式编辑器。
3. **执行不是新会话而是同一 Agent 机制**：定时任务就是"到点把一段 prompt 作为一轮对话跑"，复用会话上下文与权限。
4. **串行与低优先级**：到期任务入队，不在模型说话中间插入；错过不补跑。
5. **生命周期约束**：循环任务要过期时间（30 天）、取消入口、运行历史；一次性任务跑完自删。
6. **Jitter/错峰**：大量任务时避免整点惊群。

## 2. Corvex 现状与约束

- **单进程 Server** 内联执行轮次；没有独立 CLI daemon，也没有 cron 库（`package.json` 无 cron 依赖）。
- **已有调度范例**：`src/app/server.ts:384-426` 的 `runRetention()` 用 `setTimeout(24h)` + `AbortSignal` 循环执行每日清理，进程关闭时 abort 并 `await` 收紧——计划任务的 ticker 可照此模式，不引入新依赖。
- **轮次执行链**：HTTP 侧 `POST /api/ops/conversations/:id/messages`（`src/app/http/ops/conversations.ts:120-164`）→ `AppStore.addConversationMessage/createConversation` → `ConversationRunner.runTurn(turnId, signal, gitlab, responseLanguage)`。
- **无 HTTP 请求的现成范例**：`ConversationRunner.drainFollowUps(conversationId, gitlab?, responseLanguage?, clientForUser?)`（`src/app/conversation-runner.ts:729-778`）在启动恢复时按 `ownerUserId` 通过 `clientForUser` 回调拿当前用户 token，再 `getBranch` 取 SHA、`addConversationMessage`、`runTurn`。**这正是计划任务的执行模板**。
- **按用户令牌**：`server.ts` 的 `resumeFollowUps` 回调（`oauth.refresh(saved)` → `new GitLabClient(...)`）是 userId→client 的标准实现；`authResolveUser` 钩子（`server.ts:78-90`）会拒绝禁用用户。
- **数据层惯例**：`src/store.ts` 有 `conversation_followups`、`storage_cleanup_log` 等表；迁移用 `PRAGMA table_info` + `ALTER TABLE`，建表在 `migrate()` 的 `db.exec` 块里。类型在 `src/model.ts`。
- **API/UI 惯例**：`/api/ops/me/...` 是当前用户个人 API（`user-models.ts`）；运维台页面在 `src/app/ui/pages/`、组件在 `components/`、纯工具在 `lib/`；i18n 在 `lib/i18n.ts`（en/zhCN 双语言，`ui-i18n-usage.test.ts` 禁止未使用 key）。
- **测试**：Vitest 限定 `test/**`，要求 hermetic（临时目录、无外网、清理）；`server.test.ts`/`conversation-followups.test.ts`/`auth-refresh.test.ts` 是相关范例。

## 3. 方案设计

### 3.0 代码落点（与现有基础设施对齐）

| 层 | 落点 | 复用范式 |
|---|---|---|
| 领域类型 | `src/model.ts` 新增 `ScheduledTask` / `ScheduledTaskRun` | `ConversationFollowUp`、`StorageCleanupRecord` |
| 数据层 | `src/store.ts` 的 `migrate()` 建表块加两张表与索引；新增 CRUD 与 `claimDueTasks` | `conversation_followups`、`takeNextFollowUp`（原子取出/放回）、`storage_cleanup_log` |
| 触发层 | 新建 `src/app/scheduled-tasks.ts`（到期循环），由 `CorvexServer.run()` 仿 `runRetention` 接线 | `server.ts:384-426` 的 `sleep + AbortSignal` 循环，不引 cron 依赖 |
| 执行层 | 复用 `ConversationRunner.runTurn`；把 `server.ts:212-221` 的匿名 userId→client 回调抽成 `clientForUser(userId)` 共用 | `drainFollowUps` 的 owner→client→getBranch→addConversationMessage→runTurn 链路 |
| API | 新建 `src/app/http/ops/scheduled-tasks.ts`，前缀 `/api/ops/me`，注册在兜底路由之前 | `user-models.ts` 的个人命名空间 + owner 校验 |
| UI | `src/app/ui/pages/ScheduledTasksPage.tsx` + `lib/i18n.ts` 双语 | `SkillManager` / `StorageCleanupPanel` 的列表与运行历史 |

### 3.1 核心原则

- **不新增执行器**：计划任务到点就是把 prompt 作为一条普通消息进入既有对话轮次，走 `runTurn`；因此天然获得工具边界、轨迹、取消、GitLab 写入前复核等全部安全不变量。
- **授权绑定用户**：任务属于 `ownerUserId`；执行时按该用户解析 token（复用 `resumeFollowUps` 的回调），拿不到就跳过本次并记录失败，**绝不回退到全局凭据**。用户被禁用/令牌失效时任务不执行。
- **自然语言解析由模型做**：后端只接收"结构化结果"，不让后端写 NLP。用户在对话里说"每周一 9 点检查 CI"，由模型通过新增工具把它转成 cron 并回显确认。

### 3.2 数据模型（新表 `scheduled_tasks`）

| 列 | 说明 |
|---|---|
| `id` | 8 字符随机 ID（对齐主流，便于口播/取消） |
| `owner_user_id` | 所属用户；执行时按其令牌 |
| `conversation_id` | 绑定的对话（在哪个对话里跑；首版必须绑定现有对话，不自动建新对话） |
| `prompt` | 到点送给模型的自然语言指令（≤ 8000 字符） |
| `cron` | 5 段 cron 表达式（标准 vixie-cron 语义，`minute hour dom month dow`） |
| `recurring` | 1=循环，0=一次性（跑完删除） |
| `timezone` | IANA 时区（如 `Asia/Shanghai`）；首版可用 UTC 偏移或服务器本地时区，见 3.6 |
| `enabled` | 1/0，暂停而非删除 |
| `next_run_at` | 下次触发时间（ISO/ms），由 ticker 每次运行后重算 |
| `created_at` / `updated_at` | 时间戳 |
| `expires_at` | 循环任务过期时间（默认创建后 30 天） |
| `last_run_at` / `last_status` / `last_error` | 最近一次运行状态摘要，供 UI 展示 |

配套一张 `scheduled_task_runs` 运行记录表（id、task_id、started_at、finished_at、status、turn_id、error），便于"最近运行"面板；首版也可只存 `last_*` 字段、运行历史后补。

### 3.3 触发层（Server）

- 新增 `runScheduledTasks(signal)`，仿 `runRetention`：用短 `setTimeout`（如 1s 或 30s）tick，检查 `store.dueScheduledTasks(now)`。
- 到期处理：
  1. **原子领取**：`claimDueTask` 用单条 `UPDATE ... SET next_run_at=?, last_run_at=? WHERE id=? AND status='active' AND next_run_at<=?` 并检查 `changes`，**先推进 `next_run_at` 再执行**，避免同一次到期被重复触发；内存再用 `inFlight: Set<taskId>` 防重入。
  2. 按 `ownerUserId` 解析 OAuth 用户并 `oauth.refresh`（禁用/失败 → 记录 skip，不执行）；**绝不回退全局/宿主 token**（`conversation-runner.ts:752-753`、`server.ts:88-93` 是硬红线）。
  3. 若该 `conversation_id` 已有 queued/running 轮次（DB `addConversationMessage` 会抛 `already has an active turn`）→ **跳过本次，不补跑**（对齐 Claude Code 语义）；不要用 `conversation_followups` 当调度队列（无消费者会永久挂起）。
  4. 用 `clientForUser` 构造 `GitLabClient`，**到点重新 `getBranch` 取 SHA**（不能用创建任务时的快照，否则会 `stale`），`addConversationMessage` 插入一条用户消息，`runTurn(turnId, signal, client, language, false)` 执行——第五参传 `false` 避免定时轮次抢先消费用户手动排队的消息。
  5. 一次性任务跑完删除；循环任务重算 `next_run_at`（加 jitter：循环延迟 0–到下次间隔的一半、最多 30 分钟；一次性整点任务提前 ≤90s），并检查 `expires_at`（默认 30 天，最后跑一次后删除）。
  6. 写 `scheduled_task_runs` 记录（error 走 `src/redact.ts` 脱敏与限长）。
- **启动恢复不补跑**：进程重启时把过期 `next_run_at` 直接推进到未来（仿 `resumeFollowUps` 的"消费一次"），不批量补触发，避免打爆 GitLab/模型配额。
- **创建任务时校验模型**：`ensureModelSelected`（`conversations.ts:42-50`）应在创建任务时执行，避免到点才发现无模型。
- ticker 必须在 `server.run()` 的 abort 链里注册并 `await`，与 retention 一样，保证关服不遗留。

### 3.4 自然语言 → cron（模型侧工具）

在对话轮次里注册三个工具（仅 `taskType === "conversation"` 且用户已登录）：

| 工具 | 作用 |
|---|---|
| `schedule_task` | 参数 `{ prompt, schedule, recurring?, conversationId? }`；`schedule` 是模型从自然语言解析出的 5 段 cron（可附可读说明字段），后端校验 Cron 合法性后落库，返回任务 ID、下次运行时间（回显确认） |
| `list_scheduled_tasks` | 列出当前用户/当前对话的任务（ID、cron、prompt 摘要、下次运行、启用态、最近状态） |
| `cancel_scheduled_task` | 按 ID 暂停/删除 |

提示词补一段"能力说明"：告诉模型如何把中文时间表达映射到 5 段 cron、必须回显确认；并沿用既有规则——只有 `<available_tools>` 列出这些工具才能用。

**cron 校验不引第三方库**：后端写一个严格的 5 段解析器（范围、step、list、`*/n`、`a-b`，拒绝 `L`/`W`/`?`/名称别名），并用 `nextRunAt` 计算下一次时间——这正是 Claude Code 文档里的子集，可用一个纯函数模块放 `src/app/` 或 `src/lib/`，配单测。

### 3.5 API 与 UI

- API：新增 `/api/ops/scheduled-tasks`（GET 列表、POST 创建、DELETE/PATCH 取消/启停），挂在现有路由注册模块（放 `ops/` 新文件或并入 `conversations.ts`），走既有登录鉴权；任务按 `ownerUserId` 过滤，管理员也不跨用户。
- UI：运维台新增"计划任务"页（`src/app/ui/pages/ScheduledTasksPage.tsx`），列表展示 prompt、cron/可读计划、下次运行、状态、最近运行；提供删除/暂停。新建主入口仍是在对话里用自然语言创建（模型调 `schedule_task`），UI 只做管理与可见性。任务页用卡片网格 + 常驻「怎么玩」引导与示例语句，空态可一键跳回对话。
- **对话内结构化卡片**：三个工具的 `execute` 在 `details` 里返回由落库结果生成的结构化载荷（type 为 `scheduled_task_card`），`pi.ts` 在 `tool_execution_end` 逐字段校验后经 `onScheduleCard` → SSE `scheduled_task_card` 推送；Runner 把它写入过程快照（`kind: "scheduleCard"`），`store.readConversationProcess` 读取时同样校验，刷新后卡片不丢。`ScheduledTaskCardView` 在助手正文附近常驻渲染创建/列表/取消卡片，并带「查看计划任务」跳转。数据来自服务端而非模型自由文本，避免幻觉 ID/时间，也不依赖模型是否回显。
- **任务卡片上下文与跳转**：列表接口给每条任务附带所在对话的仓库、分支与标题；卡片展示「仓库 / 分支」，并提供「查看对话」跳到该任务的绑定对话。最近运行只在有多条记录时才可点击展开历史，避免无动作的手势提示。
- **一次性任务生命周期**：执行成功或失败后不删除任务，而是写运行记录并把状态置为 `done`、清掉下次触发时间，这样失败原因、运行历史和对话入口都能查看；启动时发现错过的触发也按 `missed` 记录并置为完成，不补跑。旧库里卡在 `active` + `9999` 哨兵时间的数据由迁移统一收敛为 `done`。状态文案统一为「启用 / 已停用 / 已完成」，停用即原 `paused`。
- **编辑**：`PUT /api/ops/me/scheduled-tasks/:id` 可改任务内容与计划（cron 或相对时间）、时区与循环类型，重新计算下次触发时间；不改动当前启用状态，已完成的任务不可编辑。运维台卡片提供「编辑」弹窗（antd Form + `Modal.useModal()`，符合 CSP）。
- i18n：en/zhCN 同步加 `scheduledTask*` 文案。

### 3.6 待定问题（实现前需确认）

1. **时区**：cron 按服务器本地时、用户时区、还是 UTC？主流按本地时区。首版建议存 IANA 时区字段、用 `Intl`/轻量实现计算，或先固定 UTC 并在 UI 明示。
2. **绑定对话 vs 新建对话**：首版绑定现有对话最安全（权限、分支、worktree 都现成）；"每天新建对话跑一个独立任务"留到 P2。
3. **Jitter 强度**：自托管单实例惊群风险低，可先用较小 jitter（或不加），避免用户困惑"为什么不是准点"。
4. **过期策略**：循环任务 30 天过期（对齐主流），到点最后跑一次后删除；一次性任务跑完即删。
5. **失败重试**：首版不自动重试（对齐"失败不自动重试"的既有不变量），记录失败下次照常触发。

## 4. 分阶段落地

| 阶段 | 内容 |
|---|---|
| P0 | 数据层 `scheduled_tasks` + cron 解析/下次时间纯函数与测试；Server ticker + 按用户令牌执行一轮；一次性任务 + 取消 |
| P1 | 模型侧 `schedule_task` / `list_scheduled_tasks` / `cancel_scheduled_task` 工具与提示词；运维台计划任务页；循环任务 + 30 天过期 + jitter |
| P2 | 运行历史页、暂停/恢复、用户时区、事件触发（webhook/GitLab）、新建独立对话执行 |

## 4.1 生命周期联动

- 删除对话（`conversationDelete` hook，`hooks.ts:103,110-120`）时同步删除或禁用绑定该对话的任务；FK `ON DELETE CASCADE` 会让任务无声消失，应显式处理并记录。
- 保留裁剪（`storageCleanup`）、禁用用户（`setUserDisabled` 只清 token/session）都要决定任务状态：禁用用户的任务跳过执行，不删除（用户恢复后可继续）。
- `runTurn` 的 `finally` 默认会 `drainFollowUps`；定时轮次传 `false`，不消费用户手动排队消息。
- 无人工触发者的轮次 `actorId: 0`（与 `drainFollowUps:760` 一致）；运行记录里带 taskId（注意脱敏）。

## 5. 测试策略

- cron 解析/下次时间：纯函数单测（合法/非法表达式、跨天/跨月、闰年、dow/dom 语义）。
- 数据层：任务 CRUD、due 查询、一次性/循环状态流转、过期。
- 触发层：用 fake timer / 短间隔 + mock `clientForUser` 验证到点执行、缺令牌跳过、忙碌不补跑、关服停止 ticker。
- API：按用户隔离（viewer 看不到别人任务）、非法 cron 400、取消后不再触发。
- UI：i18n 键使用测试、页面纯逻辑（状态/时间格式化）单测。

## 6. 安全与边界

- 任务内容（prompt、cron）由模型生成但按不可信输入处理：长度上限、cron 严格校验、不执行 prompt 里的"指令注入"以外的东西（它本来就只是下一轮的用户消息）。
- 执行凭证始终来自任务 owner 的 OAuth token；被禁用/失效则不执行；无全局回退。
- 不绕过轮次状态机、GitLab 写前复核、轨迹脱敏与大小上限。
- 到期任务在低优先级入队，不打断正在进行的回复；不补跑错过的触发。
