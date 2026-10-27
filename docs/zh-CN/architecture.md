# 架构与工作流程

## 组件

Corvex 将请求接入与模型、仓库处理分离：

1. **Server** 提供 HTTP Webhook 和运维接口，验证 Note Hook 请求、执行白名单检查、将事件和任务写入 SQLite，并回复 GitLab 评论。
2. **SQLite** 是持久化队列和状态存储，记录任务、Webhook 幂等/投递状态、执行尝试、审计事件、模型调用指标以及可选的每日 Token 预留。
3. **Worker** 轮询数据库，领取任务并续租，获取合并请求快照和仓库后执行请求的工作流。启动 Worker 必须设置 `agent.enabled: true`。
4. **GitLab API** 提供项目/MR 元信息、分页 Diff，并接收评论和行级讨论。
5. **OpenAI 兼容模型 API** 仅由 Worker 调用，用于审查、解释或修复提案任务。

没有 Worker 时 Server 仍会接收并保存命令，但模型任务会保持排队状态。拆分部署时，Server 和 Worker 必须共享同一个 SQLite 数据库和持久化 Git 存储根目录。

## 请求与入队流程

1. GitLab 将 `Note Hook` 请求发送到 `POST /webhooks/gitlab`。
2. Server 使用恒定时间比较验证 `X-Gitlab-Token` 与配置密钥，仅接受合并请求评论，限制请求体为 1 MiB，并忽略系统评论及由配置机器人用户名发布的评论。
3. Server 检查项目 ID 和用户 ID 白名单。不以 `@corvex` 开头的评论会被确认接收，但不会创建任务。
4. 解析支持的命令，并在 SQLite 事务中记录事件、响应投递状态、审计事件及（异步任务）任务。重复 Webhook 投递具有幂等性。
5. Server 使用 GitLab 写令牌发布即时确认或校验结果。Webhook 请求处理期间不会执行模型推理。
6. Worker 按创建顺序领取排队的审查、解释或修复任务，并在 30 秒可续期租约内更新任务状态和尝试记录。

支持的命令：`review`、`explain <path>`、`fix [request]`、`status` 和 `cancel`。用法请参阅[快速开始](./guide)。

## 审查流程

1. 获取 MR，确认其仍处于打开状态，并且 Head SHA 与任务入队时记录的 SHA 一致。若 MR 已关闭或提交变化，则将任务标记为 stale，不会对移动中的版本进行审查。
2. 更新或创建项目 Git 镜像，并在固定 Head SHA 上创建隔离的 detached worktree。Worker 获取相对于 MR Base SHA 的 Diff，并遵守文件数和字节数上限。
3. 将受限的 MR 元信息和 Diff 上下文发送到配置的模型接口。Corvex 期望模型返回单个结构化 JSON 对象。
4. 发布前验证模型结果：问题必须指向精确变更路径和新增行，证据必须是该行上的字面文本，严重程度必须受支持，并通过大小限制和重复指纹检查。不合格问题会被丢弃。
5. 再次获取 MR。如果模型处理期间 MR 状态或相关 Diff SHA 发生变化，则标记为 stale，不发布该结果。
6. 将有效问题发布为行级讨论。如果 GitLab 拒绝某个行级位置，则将该问题放入摘要评论作为回退。完成后清理 worktree。

模型不会被告知测试已执行；Corvex 不会运行项目测试或仓库脚本。

## Explain 与 Fix 流程

**Explain** 从固定 MR Head SHA 的 worktree 中读取指定文件，而不是读取服务器上的任意路径。系统会限制文件路径在工作区内，并遵守配置的上下文大小限制。文件内容和 MR 元信息会发送给模型；只有 MR 快照仍有效时，解释结果才会作为 MR 评论发布。

**Fix** 默认关闭，并有独立的 `fix.allowed_user_ids` 白名单。发起者也必须属于 GitLab 通用用户白名单。Worker 将受限 Diff 和可选请求发送给模型，只接受结构化 unified diff，并将修改限制在 MR Diff 中已有且可审查的文件。补丁会在隔离 worktree 中应用，并通过 `git apply --check` 和 `git diff --check`。再次确认 MR 快照未变化后，Worker 将补丁作为提案发布，供人工检查和应用。

Fix 模式不会执行测试、脚本、Hook 或其他仓库代码；不会创建提交或推送到 GitLab。发布的补丁只是提案，并不代表已验证。

## 任务状态、租约、重试和取消

主要状态流程：

```text
queued -> preparing -> analyzing -> publishing -> completed
                              \-> fixing -> verifying -/
```

任务也可能以 `failed`、`stale` 或 `cancelled` 结束。Worker 按 `worker.poll_interval` 轮询，并受 `worker.job_timeout` 限制。

任务租约固定为 30 秒，Worker 执行期间会续租。若进程在发布前中断，租约过期后任务可重新排队；中断恢复最多尝试三次。普通处理错误会将任务记为 failed。若租约在 publishing 阶段过期，评论结果可能不确定，因此 Corvex 会将任务标记为失败，不自动重试以避免重复评论。

`@corvex status` 显示该 MR 的最近任务。`@corvex cancel` 会立即取消排队任务，或请求 Worker 停止正在执行的任务。只有任务发起者可以取消。任务进入 publishing 阶段后无法取消，因为 GitLab 可能已经接收评论。

## 持久化和数据保留

SQLite 使用 WAL 模式、单一打开连接和 5 秒忙碌超时。数据库必须放在持久且可写的存储中。Server 每天清理超过 `storage.retention_days` 的终态任务、执行尝试、Webhook 事件和每日 Token 用量；审计记录按 `storage.audit_retention_days` 清理。排队和运行中的任务会保留。Git 镜像及 worktree 位于 `storage.root` 下，不由数据库清理逻辑管理，需要单独监控容量。

## 安全边界和限制

- Webhook Secret 用于验证 GitLab 投递；项目和用户白名单限制可发起任务的来源。
- 使用只读令牌读取 API 和仓库，并使用独立写令牌发布 MR 评论。不要把注册 Webhook 时使用的管理员令牌提供给运行中的服务。
- 仓库内容、评论、文件名和 Fix 指令都是不可信模型输入。模型输出会经过校验，但校验不能替代人工审阅。
- 模型提示内容可能包含源代码和 MR 文本。启用模型前，应审查服务商的数据处理方式及组织政策。
- Worker 不运行不可信仓库代码。没有测试执行器，也不会自动将补丁应用到目标分支。
- HTTP 服务支持 GitLab 合并请求 Note Hook，不支持 Push Hook 或合并请求生命周期事件。
