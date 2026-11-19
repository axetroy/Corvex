# 配置参考

Corvex 默认读取 `configs/config.yaml`。可通过 `--config` 指定其他路径。请以[`configs/config.example.yaml`](https://github.com/axetroy/Corvex/blob/main/configs/config.example.yaml)为模板。密钥从环境变量读取，不放入 YAML。下方列出的环境变量优先于 YAML 配置。

表格中的示例 URL 和路径来自示例 YAML，并非都属于程序运行时默认值；运行时默认值会明确标注。特别是 `gitlab.base_url`、`storage.root` 和 `storage.database` 必须配置。

时长格式为数字加 `ns`、`us`、`µs`、`ms`、`s`、`m` 或 `h`，例如 `5s`、`30s` 或 `2m`。相对路径以进程的当前工作目录为基准。

## Server

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `server.listen` | `0.0.0.0:8080` | 非空 | HTTP Server 监听地址。`CORVEX_LISTEN` 可覆盖。 |
| `server.read_timeout` | `5s` | 正时长 | HTTP 请求头读取超时。 |
| `server.shutdown_timeout` | `30s` | 正时长 | HTTP 优雅关闭等待时限。 |

可选 Agent 控制台仅通过环境变量配置 HTTP Basic Auth。设置两个变量后启用；两个都不设置则禁用控制台。请使用强且唯一的密码，并且仅通过 HTTPS 访问。

| 变量 | 用途 |
|---|---|
| `CORVEX_OPS_USERNAME` | `/ops` 和 `/api/ops/*` 的可选运维用户名。 |
| `CORVEX_OPS_PASSWORD` | 可选运维密码；须与 `CORVEX_OPS_USERNAME` 同时设置。 |

## GitLab

| YAML 键 | 示例 | 必填 / 限制 | 说明 |
|---|---|---|---|
| `gitlab.base_url` | `https://gitlab.example.com` | 有效 HTTP(S) URL | GitLab 实例根地址，不含凭据、查询参数或片段。`CORVEX_GITLAB_BASE_URL` 可覆盖。 |
| `gitlab.blocked_user_ids` | `[]` | 可选 | 不允许调用指令的 GitLab 数字用户 ID。配置了 Webhook 密钥的项目中的评论者均可调用，阻止列表中的用户除外。 |
| `gitlab.bot_username` | `corvex-bot` | 可选 | 调用指令时需要 @ 的账号名（例如 `@corvex-bot /review`）。 |

以下凭据为必填环境变量：

| 变量 | 用途 |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | Worker 模式必填；Server 模式启用 Agent 控制台时必填。用于读取 GitLab API、发现项目/目标及通过 Git 抓取仓库。 |
| `CORVEX_GITLAB_TOKEN` | GitLab 写操作必填。发布评论和行级讨论；Chat 可提交/推送同项目 MR 分支；启用 Issue 实现后会推送新分支并创建 Draft MR。应使用权限最小化的独立写令牌。 |
| `CORVEX_WEBHOOK_SECRET` | 必填。必须与项目 Webhook 的 Secret Token 一致。 |
| `CORVEX_OPS_USERNAME` | 可选运维用户名；须与 `CORVEX_OPS_PASSWORD` 同时设置 |
| `CORVEX_OPS_PASSWORD` | 可选 Agent 控制台密码；须与 `CORVEX_OPS_USERNAME` 同时设置 |

## 存储

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `storage.root` | `./data/corvex` | 非空 | 项目镜像和临时 worktree 根目录。`CORVEX_STORAGE_ROOT` 可覆盖。 |
| `storage.database` | `./data/state/corvex.db` | 非空 | SQLite 数据库路径。`CORVEX_DATABASE` 可覆盖。 |
| `storage.retention_days` | `90` | 1–36500 | 终态事件、尝试、Webhook 记录和每日 Token 用量的保留天数。 |
| `storage.audit_retention_days` | `365` | 1–36500 | 审计记录的保留天数。 |

启动时 Corvex 会创建数据库父目录、镜像目录和工作区目录；运行进程必须拥有写权限。数据库和 Git 存储需要分别备份。

## Agent 与模型

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `agent.enabled` | `false` | 布尔值 | 启动 Worker 时必须设为 `true`。 |
| `agent.response_language` | `en` | `en` 或 `zh-CN` | 模型生成的摘要、审查发现、修复说明、文件解释以及 Issue 回复或实现摘要所用语言。JSON 键名、代码、路径和引用证据保持原样。可在控制台运行时修改。 |
| `agent.base_url` | `https://api.openai.com/v1` | 有效 HTTP(S) URL，不含凭据/查询/片段 | OpenAI 兼容 API 根地址。Corvex 会追加 `/chat/completions`。`CORVEX_MODEL_BASE_URL` 可覆盖。通常按模型在控制台配置；这里是没有模型配置时的回退值。 |
| `agent.model` | `your-model-name` | — | 服务商模型名称。`CORVEX_MODEL_NAME` 可覆盖。通常按模型在控制台配置；这里是没有模型配置时的回退值。 |
| `agent.request_timeout` | `120s` | 启用时必须为正时长 | 单次模型请求（包括 SDK 重试）的最大等待时间。 |
| `agent.session_timeout` | `30m` | 启用时必须为正时长 | 单个 Pi Agent Session 的总运行时限。 |
| `agent.max_output_tokens` | `4096` | 启用时为 1–8192 | 请求模型生成的最大输出 Token 数。每条模型配置各自保存；这里是回退值。 |
| `agent.daily_token_budget` | `0` | 0–1,000,000,000 | UTC 每日 Token 预算；`0` 表示不限制预算。 |
| `agent.mcp_enabled` | `false` | 布尔值 | 仅为 review 任务启用 Pi MCP 扩展。MCP 服务使用 Worker 进程的操作系统权限，且不受沙箱隔离。 |
| `agent.web_enabled` | `true` | 布尔值 | 为 review 和 explain 任务启用只读 `web_fetch` 工具；设为 `false` 可关闭。 |
| `agent.web_blocked_hosts` | `[]` | DNS 主机名数组 | 可选的精确主机名黑名单，同时拦截其子域名。私网、保留用途 IP 段和特殊用途主机名始终被拦截。 |
| `agent.skill_paths` | `[]` | 路径数组 | 额外的可信 Pi Skill 目录；这些路径也可作为有界只读 `read_file` 工具的允许根目录。 |
| `agent.context_window` | `131072` | 1,024–10,000,000 | 模型的总 Token 窗口。它决定提示词预算与 SDK 压缩阈值，必须与服务商实际能力一致。每条模型配置各自保存；这里是回退值。 |
| `agent.max_input_tokens` | `0` | 0 ≤ 值 < `context_window` | 单次对话请求输入 Token 的硬上限。`0` 表示由 `context_window` 减去 `max_output_tokens` 与固定框架开销推导。运行时先扣除系统提示与当前请求，再用剩余额度限制历史注入量。 |
| `agent.history_token_budget` | `24000` | 0–`context_window` | 对话请求中重新注入历史轮次的 Token 预算；超出后裁剪较早历史，`summary_enabled` 开启时改为压缩成摘要。裁剪使用保守估算（取 chars/4 与 UTF-8 字节数/3 的较大值），避免中文和压缩代码被低估。 |
| `agent.turn_tool_result_bytes` | `262144` | 0–67,108,864 | 单轮内累计工具输出达到该值时，提示模型先记录已确认的结论并改用更聚焦的读取。它是软检查点而非硬上限，运行时还会把阈值收敛到单轮工具预算的 4 倍（128K 窗口约 256 KiB），确保提醒在压缩之前到达。`0` 表示关闭提醒；单轮工具输出仍会被截断。 |
| `agent.compaction_reserve_tokens` | `16384` | 0 ≤ 值 < `context_window` | 从 `context_window` 中预留的 Token 数，确保 SDK 压缩输出仍能落在窗口内。运行时会把过小的值提升到安全下限：单轮工具输出最坏 Token 增量 + `max_output_tokens` + 余量（128K 窗口、8K 输出时约 45,056）。 |
| `agent.compaction_keep_recent_tokens` | `20000` | 0–`context_window` | SDK 压缩时原样保留的最近 Token 数。若与预留相加超出窗口，运行时会下调。 |
| `agent.summary_enabled` | `true` | 布尔值 | 把被裁剪的对话历史压缩成持久化滚动摘要，供后续轮次复用。 |

这些上下文预算键是应对服务商「context length exceeded」错误的主要手段：Corvex 在请求离开进程前裁剪历史并限制工具输出，若服务商仍报超窗，会再去掉历史激进重试一次。工具结果在进入会话历史前按助手轮次硬性截断（128K 窗口下单次 32 KiB、单轮 64 KiB），因为 SDK 只能估算「最后一条回复之后新增的」内容；压缩预留也由同一个上界推导。它们也可以在 Agent 控制台设置页面上运行时调整，无需修改配置文件。

启用 Agent 后，调用需要鉴权的服务商前必须提供 `CORVEX_MODEL_API_KEY`，也可以在控制台的模型配置里保存。预算会保守地预留提示词字节数加配置的最大输出 Token 数，再根据服务商用量结算。请求结果不确定时会保留预留量。它是 Token 上限，不是根据价格计算的费用上限。

Pi Session 不开放内建 shell、编辑或写入工具。自定义 `read_file` 只读取固定 SHA worktree 或配置的 Skill 根目录中的 UTF-8 文本文件。每次最多返回 256 KiB，单行超过 4 KiB 时会截断并标记（压缩/混淆文件常见）；更大的文件需按行范围读取，连续读取行范围时会复用 Session 内游标。`git_grep` 仅搜索固定 workspace HEAD 的已跟踪文件，单次超时 10 秒、输出上限 256 KiB、最多返回 50 条。Chat 还提供 `git_log`（最多 50 个提交）和 `git_show`（仅接受完整 SHA）；两者均为只读，只能读取固定 MR HEAD 可达的提交，并限制输出大小。Chat 也提供 `update_mr_metadata`，仅可按用户明确要求修改当前 MR 标题和/或描述。字面量搜索工具 `search_text` 跳过常见依赖/生成目录，每次最多扫描 1,000 个文件和 16 MiB，每个文件最多 256 KiB，最多返回 50 条匹配。启用后，`web_fetch` 仅对 review 和 explain 任务开放，可通过 HTTPS 访问公网 DNS 主机及默认端口，会重新校验重定向，拒绝私网/保留地址和配置的黑名单主机；拒绝 HTML/纯文本之外的响应。单页响应体上限为 1 MiB，最多返回 40,000 个文本字符和 20 个同主机链接，每个 Session 最多抓取 10 页。网页内容是不可信模型输入。启用 MCP 时，Pi 仅为 review 任务从 `storage.root` 下服务的 Agent 目录（`pi-agent/mcp.json`）加载 MCP 工具；只能使用管理员控制的配置。

## 运行时设置

上表中的一部分设置可以在 Agent 控制台的**设置**页面修改，无需编辑配置文件或重启。Server 只把被覆盖的键写入 SQLite 的 `runtime_settings` 表（含 `updated_at` 与 `updated_by`），立即作用于后续轮次，并把每次修改记入 `audit_events`（`update_settings`，操作者取控制台用户名）。Worker 在每次轮询时重新读取该表，排队中的事件会在下一次领取时生效，并重建那些在构造函数里读取审查与修复上限的组件。Server 启动时也会重新应用已存储的覆盖项，因此重启不会悄悄退回界面显示之外的值。

可调的 Agent 设置都在运维台「设置」页维护，保存在 SQLite 的 `runtime_settings` 表（含 `updated_at` 与 `updated_by`）；配置文件只提供初始值。控制台保存时会提交全部可编辑项，此后数据库就是唯一来源，也不再提供「恢复为配置文件值」。Server 立即把修改作用于后续轮次，并写入 `audit_events`（`update_settings`，操作者为控制台用户名）。Worker 每次轮询重新读取该表，排队中的事件在下一次领取时生效，并按构造期参数重建审查与修复组件。Server 启动时会重新应用已保存的设置，重启不会悄悄退回界面显示之外的值。

「设置 → 模型」管理模型供应商：每个供应商保存名称、Base URL 与 API Key，并在其下维护各自的模型（上下文窗口与最大输出 Token）。全局只有一个模型处于使用中：第一个新增的模型自动激活，切换后无需重启即作用于 Server 与 Worker，每条助手回复也会记录生成它的模型。当前模型会覆盖 `agent.model`、`agent.base_url`、`agent.api_key`、`agent.context_window` 与 `agent.max_output_tokens`；目录为空时才使用这些 YAML 值或环境变量。API Key 不会通过接口返回，也不会写入审计日志；密码框留空表示沿用已保存的值。由于密钥保存在本地 SQLite 中，请保护数据库文件及其备份。从旧版本升级时，已保存的 `model` / `model_base_url` / `model_api_key` 运行时覆盖会自动迁移成供应商，旧版单表模型列表也会拆分为供应商与模型。

可编辑的键：`agent.response_language`、`agent.max_input_tokens`、`agent.history_token_budget`、`agent.turn_tool_result_bytes`、`agent.compaction_reserve_tokens`、`agent.compaction_keep_recent_tokens`、`agent.daily_token_budget`、`agent.summary_enabled`、`agent.web_enabled`、`agent.mcp_enabled`、`agent.web_blocked_hosts`、`agent.skill_paths`、`agent.request_timeout`、`agent.session_timeout`、`review.max_files`、`review.max_findings`、`review.max_context_bytes`、`review.batch_concurrency`、`chat.history_comments`、`issue.history_comments`、`fix.enabled`、`fix.max_patch_bytes`、`issue.implement_enabled`、`worker.poll_interval`、`worker.event_timeout`、`gitlab.bot_username`、`gitlab.blocked_user_ids`、`storage.retention_days`、`storage.audit_retention_days`、`storage.conversation_workspace_ttl_minutes` 与 `storage.conversation_workspace_max`。时间参数在界面以秒填写、以毫秒保存。回复语言与模型在每次请求和轮次读取，修改后无需重启即可作用于下一次。

只有启动必需项仍只来自配置文件或环境变量：`server.listen`/`read_timeout`/`shutdown_timeout`、控制台凭据、GitLab 令牌与 Webhook 密钥、`gitlab.base_url`、`storage.root`、`storage.database`、`agent.enabled`，以及模型目录为空时兜底的连接参数。运行时调整过的字段会展示实际生效值：运行时自动推导 `max_input_tokens`、把工具结果检查点收敛到四个工具输出轮次，并把压缩预留提升到安全下限，因此填写的值可能与进程实际使用的值不同。

## Chat 上下文

| YAML 键 | 示例/默认值 | 可接受范围 | 说明 |
|---|---:|---:|---|
| `chat.history_comments` | `20` | 0–50 | 初始聊天上下文中包含的最近非系统 MR 评论数。`0` 表示关闭自动注入；Chat 仍可按需通过 `read_mr_comments` 读取评论。 |

## 审查限制

| YAML 键 | 示例/默认值 | 可接受范围 | 说明 |
|---|---:|---:|---|
| `review.max_files` | `100` | 1–1000 | 单次审查最多考虑的变更文件数；每批最多 10 个文件，并会按上下文大小进一步缩小。 |
| `review.max_findings` | `30` | 1–100 | 单次审查所有批次合计最多接受的唯一问题数。 |
| `review.max_context_bytes` | `2097152`（2 MiB） | 1 字节–8 MiB | 配置的序列化上下文上限。Worker 还会将单次 user prompt 限制为 80 KiB、system 与 user prompt 合计限制为 96 KiB，为 128K token 模型窗口中的输出和工具调用预留空间；这是保守字节上限，并非 tokenizer 的精确计数。 |
| `review.batch_concurrency` | `2` | 1–4 | 同时处理的独立审查批次数上限。 |

`review.max_files` 是单次审查的总文件上限，不是批次大小。超过配置或安全限制的文件和问题可能被忽略或拒绝；被省略文件会标记为部分覆盖，不能因此认为这些内容已经过审查。

## Worker

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `worker.poll_interval` | `2s` | 正时长 | 无任务时两次轮询之间的等待时间。 |
| `worker.event_timeout` | `30m` | 正时长 | 单个已领取事件的总执行超时。 |

事件租约固定为 30 秒，执行期间会续租；当前不是 YAML 配置项。

## 修复提案

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `fix.enabled` | `false` | 布尔值 | 启用 Fix 任务；同时要求 `agent.enabled: true`。 |
| `fix.max_patch_bytes` | `131072`（128 KiB） | 1 字节–256 KiB | Fix 或 Issue 实现模型补丁大小上限。 |

Fix 请求与其他指令采用相同的可选用户黑名单规则。仅在需要接受 Corvex 指令的项目中注册 Webhook；Agent 控制台可以发现只读令牌可访问的全部项目。

## Issue 实现

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `issue.implement_enabled` | `false` | 布尔值；要求 `agent.enabled: true` | 启用 Issue 任务的代码写入。关闭时，普通 `@<bot> <request>` 仍可获得分析或回复；启用后，Agent 可为实现请求创建新的 `corvex/issue-*` 分支并打开 Draft MR。不执行仓库代码，也不会自动合并。 |
| `issue.history_comments` | `20` | 0–50 | 初始助手上下文中包含的最近非系统 Issue 评论数。`0` 表示不包含评论历史；分页和总字节限制会进一步限制上下文大小。 |

Issue 任务默认使用项目默认分支；只有当前请求明确命名另一个已存在分支时才会选择该分支，评论不能授权分支选择。实现需要 `CORVEX_GITLAB_TOKEN` 具有推送分支和创建合并请求的权限。生成的补丁仅允许普通文本文件变更，并会校验路径。发布失败或结果不确定时不会自动重试；重试前请检查 Issue 任务事件及项目分支。

## 完整环境变量列表

| 变量 | 对应配置或用途 |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | GitLab 读取令牌，Worker 模式及启用 Agent 控制台的 Server 模式必填 |
| `CORVEX_GITLAB_TOKEN` | GitLab 写入令牌，Server 和 Worker 模式必填 |
| `CORVEX_WEBHOOK_SECRET` | Webhook Secret，Server 模式必填 |
| `CORVEX_MODEL_API_KEY` | Agent API 密钥，Worker 模式启用 Agent 时必填 |
| `CORVEX_MODEL_BASE_URL` | 覆盖 `agent.base_url` |
| `CORVEX_MODEL_NAME` | 覆盖 `agent.model` |
| `CORVEX_GITLAB_BASE_URL` | 覆盖 `gitlab.base_url` |
| `CORVEX_DATABASE` | 覆盖 `storage.database` |
| `CORVEX_STORAGE_ROOT` | 覆盖 `storage.root` |
| `CORVEX_LISTEN` | 覆盖 `server.listen` |

Compose 还读取 `CORVEX_IMAGE_TAG`、`CORVEX_MEM_LIMIT`、`CORVEX_CPUS` 等仅用于部署的变量，详见[运行环境与运维](./operations)。
