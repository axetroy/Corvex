# 架构与工作流程

## 组件

Corvex 将请求接入与模型、仓库处理分离：

1. **Server** 提供 GitLab Note Hook 和经过认证的 Agent 接口，验证 Webhook Secret、执行可选用户阻止列表检查、将事件写入 SQLite，并回复 GitLab。Agent 控制台通过配置的 GitLab 只读 Token 发现项目和分支。
2. **SQLite** 是持久化队列和状态存储，记录事件、Webhook 幂等/投递状态、执行尝试、审计事件、对话及其消息/轮次、模型调用指标以及可选的每日 Token 预留。
3. **Worker** 轮询数据库，领取事件并续租，同时记录供 Agent 控制台监控使用的心跳，然后获取合并请求或 Issue 快照及仓库并执行工作流。启动 Worker 必须设置 `agent.enabled: true`。对话轮次不是事件，改由 Server 内联执行。
4. **GitLab API** 提供项目/MR 元信息、分页 Diff，并接收评论和行级讨论。
5. **OpenAI 兼容模型 API** 由 Worker 调用，用于审查、合并请求聊天、解释、修复提案或 Issue 实现，也由 Server 为内联对话轮次调用。

GitLab GET 请求遇到瞬时网络错误或 HTTP 408、425、429、500、502、503、504 时，最多尝试三次并使用有界退避。POST 写请求不会自动重试，因为远端副作用可能无法确认。

Worker 还会对发布前的瞬时 HTTP/网络故障和事件超时执行持久化重试。等待时间从 2 秒开始，每次尝试翻倍，最多 30 秒；单个事件的总尝试次数仍不超过三次。鉴权、校验、取消、快照过期和 publishing 阶段错误不会自动重试。

没有 Worker 时 Server 仍会接收并保存命令，但模型事件会保持排队状态。拆分部署时，Server 和 Worker 必须共享同一个 SQLite 数据库和持久化 Git 存储根目录。

## 请求与入队流程

1. GitLab 将 `Note Hook` 请求发送到 `POST /webhooks/gitlab`。
2. Server 使用恒定时间比较验证 `X-Gitlab-Token` 与配置密钥，接受合并请求和 Issue 评论，限制请求体为 1 MiB，并忽略系统评论。
3. Server 拒绝 `gitlab.blocked_user_ids` 中的用户。配置了共享 Webhook Secret 的项目中的其他评论者都可以通过 @ `gitlab.bot_username` 使用 slash 指令或直接发送普通文本；部署者应仅在需要接受指令的项目中注册 Webhook。
4. 解析支持的命令，并在 SQLite 事务中记录事件、响应投递状态、审计事件及（异步工作对应的）事件本身。重复 Webhook 投递具有幂等性。
5. Server 使用 GitLab 写令牌发布即时确认或校验结果。Webhook 请求处理期间不会执行模型推理。
6. Worker 按创建顺序领取排队的审查、解释、聊天、修复或实现事件，并在 30 秒可续期租约内更新事件状态和尝试记录；空闲轮询及执行期间也会更新 Worker 心跳。

MR 支持 `/review`、`/explain <path>`、`/fix [request]`、`/status` 和 `/cancel`；机器人提及后的普通文本会基于当前 MR 发起聊天。Issue 中的普通提及会进入助手任务，模型可基于 Issue 和近期非系统评论进行回复、追问或提出实现。代码写入由默认关闭的 `issue.implement_enabled` 单独控制；`/implement [request]` 仍可显式请求实现。用法请参阅[快速开始](./guide)。

## 持久对话

经过认证的 Agent 控制台使用 GitLab 只读 Token 搜索其可见的全部项目及分支。对话是绑定到单个仓库分支的通用聊天；服务端在消息入队时解析并固定分支头 SHA，每轮消息保存在 SQLite，并按对话串行执行。对话使用独立表（`conversations`、`conversation_messages`、`conversation_turns`），不进入事件队列：每轮由 Server 通过 `ConversationRunner` 内联执行，因此对话轮次不是事件，也不会出现在事件列表里。每轮仍各自拥有独立的轨迹与执行记录，按 `turn_id` 存储；控制台通过 `GET /api/ops/conversations/<id>/turns` 读取整段对话（把各轮轨迹与执行记录合并成一条时间线），或通过 `GET /api/ops/conversations/<id>/turns/<turnId>` 按轮读取并校验该轮确属该对话，同时通过 `GET /api/ops/conversations/<id>/stats` 汇总用量与耗时；详情响应（`GET /api/ops/conversations/<id>`）还会派生并返回该对话的系统提示词，供控制台展示。对话是控制台的一等对象：页面铺满视口，左侧为对话列表，右侧工作区的 **对话**、**调用记录**、**轨迹**、**统计** 四个标签页分别呈现消息记录（含每条助手回复的工具调用，并在记录上方展示该对话的系统提示词）、各轮的执行记录、整段对话合并后的轨迹（可切换到单轮）与整段对话的汇总。首轮完成后，Corvex 会依据开场提问让模型生成一个简短标题并写入对话，左侧列表即按该标题展示（标题生成前回退为项目名）；标题生成是尽力而为，失败不会让轮次失败。每个对话都带一个显式模式（`ConversationMode`），当前只有 `read_only` 一种，并在左侧列表与仓库头部以标签展示。内联执行由该模式派生仓库能力：`read_only` 只提供只读仓库工具，不会向 GitLab 发布内容。每个对话常驻一个只读 worktree 并跨轮次复用（同一固定快照的追问只重新校验 HEAD，不再重新 checkout 工作树），空闲工作区按 TTL 与缓存上限淘汰，并在 Server 关闭时删除。目前运行在 Server 进程内，后续可迁移到容器而无需改动该契约。若分支在入队消息开始执行前发生移动，该轮会以 `stale` 结束，而不会基于不一致的快照作答。

### 上下文预算

Corvex 让对话始终落在模型上下文窗口之内，而不是等服务商拒绝请求。请求离开进程前，`src/agent/budget.ts` 用保守估算（取 chars/4 与 UTF-8 字节数/3 的较大值，避免中文与压缩代码被低估），`trimHistory` 只保留符合 `agent.history_token_budget` 且不超过 `agent.max_input_tokens` 剩余额度的最近历史；被裁掉的历史压缩成持久化的滚动摘要（`conversations.summary`）供后续轮次复用，摘要按预算分块进行，长对话不会因一次摘要请求超窗而丢失早期上下文。请求本身也以结构化多消息构建，而不是拼成一个大字符串。

单轮内，工具结果在进入会话历史前被确定性截断：`src/agent/tool-budget.ts` 为 128K 窗口限制单次约 32 KiB、每个助手轮次约 64 KiB，并在截断处留下标记，提示模型改用更精确的路径或行范围继续读取。这个硬上限是必要的：SDK 以最后一次服务商真实用量为锚点，只能估算此后新增的内容，无界的大工具结果可能在下次压缩检查之前就越过窗口。`agent.turn_tool_result_bytes` 仍是软检查点，提示模型记录进展并改用聚焦读取；运行时会把它收敛到四个单轮工具预算，确保在压缩之前触发。上下文的增长由 SDK 压缩吸收（Pi Session 通过内存中的设置管理器获得相同的 `agent.context_window` 与压缩阈值），压缩预留会自动上调，以覆盖单轮工具输出的最坏 Token 增量加 `max_output_tokens`。若服务商仍报超窗（`context length exceeded` 等），`isContextOverflowError` 会识别出来，并再去掉全部历史激进重试一次。这些键可在控制台设置页面运行时调整；Server 落库前会用与配置文件相同的定义校验它们。

## 审查流程

1. 获取 MR，确认其仍处于打开状态，并且 Head SHA 与任务入队时记录的 SHA 一致。若 MR 已关闭或提交变化，则将任务标记为 stale，不会对移动中的版本进行审查。
2. 更新或创建项目 Git 镜像，并在固定 Head SHA 上创建隔离的 detached worktree。Worker 获取相对于 MR Base SHA 的 Diff，并遵守文件数和字节数上限。`review.max_files` 范围内的文件每批最多审查 10 个；必要时还会按 `review.max_context_bytes` 进一步缩小批次。
3. 将受限的 MR 元信息和每批 Diff 上下文发送到配置的模型接口。Corvex 期望每批返回一个结构化 JSON 对象，并在整次审查中汇总用量和问题。
4. 发布前逐批验证模型结果：问题必须指向精确变更路径和新增行，证据必须是该行上的字面文本，严重程度必须受支持，并通过大小限制和重复指纹检查。所有批次会全局去重，并受 `review.max_findings` 总数限制。Corvex 会检查每批成功的文件读取记录，包括已有问题发现的批次，并对未读完的文件进行一次定向追问。若追问后仍有文件未读完，有效问题会连同部分覆盖警告一起发布；若没有问题发现，则任务失败，不会声称审查完整。受配置限制而省略的文件也会标记为部分覆盖。
5. 再次获取 MR。如果模型处理期间 MR 状态或相关 Diff SHA 发生变化，则标记为 stale，不发布该结果。
6. 将有效问题发布为行级讨论。如果 GitLab 拒绝某个行级位置，则将该问题放入摘要评论作为回退。完成后清理 worktree。

模型不会被告知测试已执行；Corvex 不会运行项目测试或仓库脚本。

## Chat、Explain 与 Fix 流程

**Chat** 会将受限 Diff、固定 MR 元信息、配置数量的最近非系统 MR 评论和调用者的自然语言请求一起发送给模型。`read_mr_comments` 工具只能读取当前 MR 的更多评论。Chat 还可通过 `git_log` 和 `git_show` 读取固定 MR HEAD 可达的提交；读取详情必须提供完整 SHA。用户明确要求时，`update_mr_metadata` 可修改当前 MR 标题和/或描述；执行记录只保存目标及字段长度，不保存正文。配置写令牌且 MR 源项目与目标项目相同时，Chat 还会获得有界的 `git_status`、`git_apply_patch`、`git_commit`、`git_push` 和 `git_revert` 工具。它们固定绑定到任务隔离 worktree 和 MR 源分支，不开放 shell 或任意命令；补丁只能修改已跟踪的普通文件，提交只接受已跟踪文件的未暂存修改，推送要求远端分支仍等于 pinned SHA 或本任务上次推送 SHA，并且只执行普通快进更新；回滚会为最近的 Corvex 提交新增 revert commit。代码修改请求会先完成所有修改和可用验证，再创建最终提交，并在回复前把推送作为最后一次仓库操作；不会推送中间状态，也不会在推送后继续修改文件。Fork MR 不开放 Git 写工具，永远不能强制推送。执行记录不会保存补丁正文或凭据。Git 输出和评论均为不可信输入；达到上下文字节上限时会优先省略较旧评论。推送后，Worker 会验证 MR 当前 Head 与刚推送的 SHA 完全一致，再将回复作为普通 MR 评论发布。Chat 不创建行级讨论。

**Explain** 从固定 MR Head SHA 的 worktree 中读取指定文件，而不是读取服务器上的任意路径。系统会限制文件路径在工作区内，并遵守配置的上下文大小限制。文件内容和 MR 元信息会发送给模型；只有 MR 快照仍有效时，解释结果才会作为 MR 评论发布。

**Fix** 默认关闭，并遵循其他指令的可选 `gitlab.blocked_user_ids` 黑名单。Worker 将受限 Diff 和可选请求发送给模型，只接受结构化 unified diff，并将修改限制在 MR Diff 中已有且可审查的文件。补丁会在隔离 worktree 中应用，并通过 `git apply --check` 和 `git diff --check`。再次确认 MR 快照未变化后，Worker 将补丁作为提案发布，供人工检查和应用。

Fix 模式不会执行测试、脚本、Hook 或其他仓库代码；不会创建提交或推送到 GitLab。发布的补丁只是提案，并不代表已验证。

**Issue 助手**遵循可选用户黑名单。配置了共享 Webhook Secret 的项目中，任何普通机器人提及都会排队；模型会收到 Issue 及最多 `issue.history_comments` 条近期非系统评论（默认 20，范围 0–50，另有分页和字节上限），可直接回复或请求澄清而不发布代码。`issue.implement_enabled` 是独立且默认关闭的写入开关：启用后，明确的实现请求才可生成有界 unified diff。目标分支默认为项目默认分支；只有当前请求明确命名另一个已存在分支时才会改投该分支，评论不能授权分支选择。Worker 固定目标基线 SHA，校验补丁（仅普通文本文件；拒绝路径穿越、Git 元数据路径、符号链接父目录、二进制、重命名和模式变更），并在推送前再次验证 Issue 与目标 SHA。随后创建新的 `corvex/issue-*` 分支和 Draft MR。不会运行项目脚本/测试、自动合并或关闭 Issue。远端结果不确定时不会自动重试。

## 事件状态、租约、重试和取消

主要状态流程：

```text
queued -> preparing -> analyzing -> publishing -> completed
 \-> fixing -> verifying -/
```

事件也可能以 `failed`、`stale` 或 `cancelled` 结束。Worker 按 `worker.poll_interval` 轮询，并受 `worker.event_timeout` 限制。

任务租约固定为 30 秒，Worker 执行期间会续租。若进程在发布前中断，租约过期后事件可重新排队；中断恢复最多尝试三次。已分类的瞬时故障和事件超时也会带持久化退避重新入队。其他处理错误会将事件记为 failed。若事件在 publishing 阶段失败或租约过期，评论结果可能不确定，因此 Corvex 不会自动重试，以免重复评论。

`@<gitlab.bot_username> /status` 显示该 MR 的最近事件。`@<gitlab.bot_username> /cancel` 会立即取消排队事件，或请求 Worker 停止正在执行的事件。只有发起者可以取消。事件进入 publishing 阶段后无法取消，因为 GitLab 可能已经接收评论。

## 持久化和数据保留

SQLite 使用 WAL 模式、单一打开连接和 5 秒忙碌超时。数据库必须放在持久且可写的存储中。Server 每天清理超过 `storage.retention_days` 的终态事件、执行尝试、Webhook 事件和每日 Token 用量；审计记录按 `storage.audit_retention_days` 清理。排队和运行中的事件会保留。Git 镜像及 worktree 位于 `storage.root` 下，不由数据库清理逻辑管理，需要单独监控容量。

## 安全边界和限制

- Webhook Secret 用于验证 GitLab 投递；仅在需要接受指令的项目中注册 Webhook，并可通过用户黑名单限制发起任务的用户。
- Agent 控制台可发现只读 GitLab Token 有权访问的所有项目，不受静态项目白名单控制。
- 使用只读令牌读取 API 和仓库，并使用独立写令牌发布 MR 评论。不要把注册 Webhook 时使用的管理员令牌提供给运行中的服务。
- 仓库内容、评论、文件名和 Fix 指令都是不可信模型输入。模型输出会经过校验，但校验不能替代人工审阅。
- 模型提示内容可能包含源代码和 MR 文本。启用模型前，应审查服务商的数据处理方式及组织政策。
- Worker 不运行不可信仓库代码。没有测试执行器，也不会自动将补丁应用到目标分支。
- HTTP 服务支持 GitLab 合并请求 Note Hook，不支持 Push Hook 或合并请求生命周期事件。
