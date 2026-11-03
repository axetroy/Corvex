# 架构与工作流程

## 组件

Corvex 将请求接入与模型、仓库处理分离：

1. **Server** 提供 HTTP Webhook 和运维接口，验证 Note Hook 请求、执行白名单检查、将事件和任务写入 SQLite，并回复 GitLab 评论。
2. **SQLite** 是持久化队列和状态存储，记录任务、Webhook 幂等/投递状态、执行尝试、审计事件、模型调用指标以及可选的每日 Token 预留。
3. **Worker** 轮询数据库，领取任务并续租，同时记录供运维监控使用的心跳，然后获取合并请求快照和仓库并执行请求的工作流。启动 Worker 必须设置 `agent.enabled: true`。
4. **GitLab API** 提供项目/MR 元信息、分页 Diff，并接收评论和行级讨论。
5. **OpenAI 兼容模型 API** 仅由 Worker 调用，用于审查、合并请求聊天、解释、修复提案或 Issue 实现任务。

GitLab GET 请求遇到瞬时网络错误或 HTTP 408、425、429、500、502、503、504 时，最多尝试三次并使用有界退避。POST 写请求不会自动重试，因为远端副作用可能无法确认。

Worker 还会对发布前的瞬时 HTTP/网络故障和任务超时执行持久化重试。等待时间从 2 秒开始，每次尝试翻倍，最多 30 秒；任务总尝试次数仍不超过三次。鉴权、校验、取消、快照过期和 publishing 阶段错误不会自动重试。

没有 Worker 时 Server 仍会接收并保存命令，但模型任务会保持排队状态。拆分部署时，Server 和 Worker 必须共享同一个 SQLite 数据库和持久化 Git 存储根目录。

## 请求与入队流程

1. GitLab 将 `Note Hook` 请求发送到 `POST /webhooks/gitlab`。
2. Server 使用恒定时间比较验证 `X-Gitlab-Token` 与配置密钥，接受合并请求和 Issue 评论，限制请求体为 1 MiB，并忽略系统评论。
3. Server 检查项目 ID 白名单，并拒绝 `gitlab.blocked_user_ids` 中的用户。其他评论者都可以通过 @ `gitlab.bot_username` 使用 slash 指令或直接发送普通文本。
4. 解析支持的命令，并在 SQLite 事务中记录事件、响应投递状态、审计事件及（异步任务）任务。重复 Webhook 投递具有幂等性。
5. Server 使用 GitLab 写令牌发布即时确认或校验结果。Webhook 请求处理期间不会执行模型推理。
6. Worker 按创建顺序领取排队的审查、解释、聊天、修复或实现任务，并在 30 秒可续期租约内更新任务状态和尝试记录；空闲轮询及执行期间也会更新 Worker 心跳。

MR 支持 `/review`、`/explain <path>`、`/fix [request]`、`/status` 和 `/cancel`；机器人提及后的普通文本会基于当前 MR 发起聊天。Issue 中的普通提及会进入助手任务，模型可基于 Issue 和近期非系统评论进行回复、追问或提出实现。代码写入由默认关闭的 `issue.implement_enabled` 单独控制；`/implement [request]` 仍可显式请求实现。用法请参阅[快速开始](./guide)。

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

**Fix** 默认关闭，并与其他指令采用相同的项目白名单和可选 `gitlab.blocked_user_ids` 黑名单。Worker 将受限 Diff 和可选请求发送给模型，只接受结构化 unified diff，并将修改限制在 MR Diff 中已有且可审查的文件。补丁会在隔离 worktree 中应用，并通过 `git apply --check` 和 `git diff --check`。再次确认 MR 快照未变化后，Worker 将补丁作为提案发布，供人工检查和应用。

Fix 模式不会执行测试、脚本、Hook 或其他仓库代码；不会创建提交或推送到 GitLab。发布的补丁只是提案，并不代表已验证。

**Issue 助手**遵循项目白名单和可选用户黑名单。任何普通机器人提及都会排队；模型会收到 Issue 及最多 `issue.history_comments` 条近期非系统评论（默认 20，范围 0–50，另有分页和字节上限），可直接回复或请求澄清而不发布代码。`issue.implement_enabled` 是独立且默认关闭的写入开关：启用后，明确的实现请求才可生成有界 unified diff。目标分支默认为项目默认分支；只有当前请求明确命名另一个已存在分支时才会改投该分支，评论不能授权分支选择。Worker 固定目标基线 SHA，校验补丁（仅普通文本文件；拒绝路径穿越、Git 元数据路径、符号链接父目录、二进制、重命名和模式变更），并在推送前再次验证 Issue 与目标 SHA。随后创建新的 `corvex/issue-*` 分支和 Draft MR。不会运行项目脚本/测试、自动合并或关闭 Issue。远端结果不确定时不会自动重试。

## 任务状态、租约、重试和取消

主要状态流程：

```text
queued -> preparing -> analyzing -> publishing -> completed
                              \-> fixing -> verifying -/
```

任务也可能以 `failed`、`stale` 或 `cancelled` 结束。Worker 按 `worker.poll_interval` 轮询，并受 `worker.job_timeout` 限制。

任务租约固定为 30 秒，Worker 执行期间会续租。若进程在发布前中断，租约过期后任务可重新排队；中断恢复最多尝试三次。已分类的瞬时故障和任务超时也会带持久化退避重新入队。其他处理错误会将任务记为 failed。若任务在 publishing 阶段失败或租约过期，评论结果可能不确定，因此 Corvex 不会自动重试，以免重复评论。

`@<gitlab.bot_username> /status` 显示该 MR 的最近任务。`@<gitlab.bot_username> /cancel` 会立即取消排队任务，或请求 Worker 停止正在执行的任务。只有任务发起者可以取消。任务进入 publishing 阶段后无法取消，因为 GitLab 可能已经接收评论。

## 持久化和数据保留

SQLite 使用 WAL 模式、单一打开连接和 5 秒忙碌超时。数据库必须放在持久且可写的存储中。Server 每天清理超过 `storage.retention_days` 的终态任务、执行尝试、Webhook 事件和每日 Token 用量；审计记录按 `storage.audit_retention_days` 清理。排队和运行中的任务会保留。Git 镜像及 worktree 位于 `storage.root` 下，不由数据库清理逻辑管理，需要单独监控容量。

## 安全边界和限制

- Webhook Secret 用于验证 GitLab 投递；项目白名单和可选用户黑名单限制可发起任务的来源。
- 使用只读令牌读取 API 和仓库，并使用独立写令牌发布 MR 评论。不要把注册 Webhook 时使用的管理员令牌提供给运行中的服务。
- 仓库内容、评论、文件名和 Fix 指令都是不可信模型输入。模型输出会经过校验，但校验不能替代人工审阅。
- 模型提示内容可能包含源代码和 MR 文本。启用模型前，应审查服务商的数据处理方式及组织政策。
- Worker 不运行不可信仓库代码。没有测试执行器，也不会自动将补丁应用到目标分支。
- HTTP 服务支持 GitLab 合并请求 Note Hook，不支持 Push Hook 或合并请求生命周期事件。
