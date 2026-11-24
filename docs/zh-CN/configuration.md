# 配置参考

Corvex 默认读取 `configs/config.yaml`。可通过 `--config` 指定其他路径。请以[`configs/config.example.yaml`](https://github.com/axetroy/Corvex/blob/main/configs/config.example.yaml)为模板。密钥从环境变量读取，不放入 YAML。下方列出的环境变量优先于 YAML 配置。

可通过 `--env <路径>` 从 dotenv 格式文件加载环境变量，例如：`pnpm start -- --env .env --config configs/config.yaml server`。相对路径以当前工作目录为基准。进程中已设置的环境变量优先于文件中的值。

表格中的示例 URL 和路径来自示例 YAML，并非都属于程序运行时默认值；运行时默认值会明确标注。特别是 `storage.root` 和 `storage.database` 必须配置。GitLab 地址、OAuth 凭据和令牌都在安装页或运维台设置页写入 SQLite，配置文件只提供启动兜底。

时长格式为数字加 `ns`、`us`、`µs`、`ms`、`s`、`m` 或 `h`，例如 `5s`、`30s` 或 `2m`。相对路径以进程的当前工作目录为基准。

## Server

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `server.listen` | `0.0.0.0:8080` | 非空 | HTTP Server 监听地址。`CORVEX_LISTEN` 可覆盖。 |
| `server.read_timeout` | `5s` | 正时长 | HTTP 请求头读取超时。 |
| `server.shutdown_timeout` | `30s` | 正时长 | HTTP 优雅关闭等待时限。 |

运维台 `/ops` 使用 GitLab OAuth2 登录：每个用户用自己的 GitLab 账号登录，Corvex 用该用户的令牌执行控制台 API 与对话。安装向导写入的 OAuth 凭据保存在 SQLite 的 GitLab 运行时设置中，不从 YAML 读取。

Webhook 驱动的 GitLab 事件当前已延期（见 [ROADMAP.zh_CN.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.zh_CN.md)），因此不再有 Webhook 密钥、机器人用户名或用户黑名单等配置项。

## GitLab

| YAML 键 | 示例 | 必填 / 限制 | 说明 |
|---|---|---|---|
| `gitlab.base_url` | — | 可选启动兜底 | GitLab 实例根地址，在安装页/设置页维护。控制台无保存值时可由 `CORVEX_GITLAB_BASE_URL` 提供启动兜底。 |

OAuth Application 的三个字段由安装页写入 SQLite，必须与客户端 ID、Secret 和回调地址同时配置；它们不在 YAML 中读取：

| 字段 | 说明 |
|---|---|
| `gitlab.oauth_client_id` | GitLab OAuth Application 的 Application ID。 |
| `gitlab.oauth_client_secret` | 对应的 Secret；接口不回显，留空表示保留已保存值。 |
| `gitlab.oauth_redirect_uri` | 回调地址，例如 `https://corvex.example.com/auth/gitlab/callback`，须与 GitLab 应用登记一致。 |

不再提供共享的 GitLab 读/写 Token：所有 GitLab API 请求与 Git 网络操作都使用当前登录用户的 OAuth 令牌。OAuth 凭据在设置页保存；密钥字段不会通过接口回显，留空表示保留已保存值。

## 按用户 GitLab 登录

控制台通过 GitLab OAuth2 授权码流程认证每个使用者。首次访问时未登录请求会跳转到 `/setup`，在那里填写 GitLab 实例地址以及 OAuth Application 的 ID、Secret 与回调地址；这些值保存在 SQLite，之后可在「设置 → GitLab 配置」中修改，不需要任何环境变量。用户令牌的加密密钥在首次启动时生成并保存在 SQLite。

每个用户的 access token 加密保存在 SQLite，仅用于该用户的控制台 API 与对话；运维台可见的项目范围就是该令牌可见的项目，没有静态项目白名单。系统级的读/写令牌只作为连接兜底，不由 Webhook 事件使用。

## 存储

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `storage.root` | `./data/corvex` | 非空 | 项目镜像和对话 worktree 根目录。`CORVEX_STORAGE_ROOT` 可覆盖。 |
| `storage.database` | `./data/state/corvex.db` | 非空 | SQLite 数据库路径。`CORVEX_DATABASE` 可覆盖。 |
| `storage.retention_days` | `90` | 1–36500 | 已结束的对话轮次、执行记录、轨迹与每日 Token 用量的保留天数。 |
| `storage.audit_retention_days` | `365` | 1–36500 | 审计记录的保留天数。 |
| `storage.conversation_workspace_ttl_minutes` | `60` | 1–14400 | 空闲对话 worktree 的存活时间（分钟）。 |
| `storage.conversation_workspace_max` | `8` | 1–200 | 同时缓存的对话 worktree 数量上限（按最近使用淘汰）。 |

启动时 Corvex 会创建数据库父目录、镜像目录和工作区目录；运行进程必须拥有写权限。每个对话常驻一个 worktree 并跨轮复用，空闲后按 TTL 与数量上限淘汰；文件改动另持久化到项目镜像的 `refs/conversations/<id>`，因此 worktree 被清理后重建仍会恢复。淘汰与清理不会触碰仍有排队或运行中轮次的对话。数据库和 Git 存储需要分别备份。

## Agent 与模型

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `agent.response_language` | `en` | `en` 或 `zh-CN` | 模型生成内容所用语言。JSON 键名、代码、路径和引用证据保持原样。可在控制台运行时修改。 |
| `agent.base_url` | `https://api.openai.com/v1` | 有效 HTTP(S) URL，不含凭据/查询/片段 | OpenAI 兼容 API 根地址。Corvex 会追加 `/chat/completions`。`CORVEX_MODEL_BASE_URL` 可覆盖。通常按供应商在控制台配置；这里是没有激活模型时的回退值。 |
| `agent.model` | `your-model-name` | — | 服务商模型名称。`CORVEX_MODEL_NAME` 可覆盖。通常按模型在控制台配置；这里是回退值。 |
| `agent.auto_context_tune` | `true` | 布尔值 | 服务商报超窗时，只在本次会话的重试中下调有效上下文窗口；不会修改保存的模型配置。 |
| `agent.request_timeout` | `120s` | 正时长 | 单次模型请求（包括 SDK 重试）的最大等待时间。 |
| `agent.session_timeout` | `30m` | 正时长 | 单个 Pi Agent Session 的总运行时限。 |
| `agent.response_stall_timeout` | `180s` | 0 或正时长 | 模型在等待响应头、正文、思考或工具调用期间持续无输出超过该时长时中止本轮；等待期间控制台会显示进度提示。`0` 关闭看门狗。模型请求改用同配置的 undici dispatcher，使 `request_timeout` 也覆盖响应头等待。 |
| `agent.max_output_tokens` | `4096` | 1–8192 | 请求模型生成的最大输出 Token 数。每个模型各自保存；这里是回退值。 |
| `agent.daily_token_budget` | `0` | 0–1,000,000,000 | UTC 每日 Token 预算；`0` 表示不限制预算。 |
| `agent.web_enabled` | `true` | 布尔值 | 启用只读 `web_fetch` 工具；设为 `false` 可关闭。 |
| `agent.web_search_enabled` | `true` | 布尔值 | 启用 Tavily 免费免 key 模式的 `web_search`；无需 API key，但查询会发送给 Tavily。 |
| `agent.web_search_max_queries` | `5` | 数字 | 每轮最多调用 `web_search` 的次数（1–50）。 |
| `agent.git_tool_call_limit` | `40` | 0–200 | 每轮最多调用 Git 工具的次数（失败也计入）。用尽后 Agent 停止 Git 操作并汇报进展；`0` 表示不限制。 |
| `agent.auto_create_merge_request` | `true` | 布尔值 | 首次成功发布到功能分支后，用当前登录用户令牌复用已打开的 MR 或自动创建：源分支为发布的分支，目标分支为本对话的分支。 |
| `agent.reasoning_enabled` | `true` | 布尔值 | 让模型在工具调用之间进行推理思考；仅在模型不支持推理时关闭。 |
| `agent.web_blocked_hosts` | `[]` | DNS 主机名数组（最多 100 个） | 可选的精确主机名黑名单，同时拦截其子域名。私网、保留用途 IP 段和特殊用途主机名始终被拦截。 |
| `agent.skill_paths` | `[]` | 路径数组 | 额外的可信 Pi Skill 目录；这些路径也可作为只读文件工具的允许根目录。 |
| `agent.context_window` | `131072` | 1,024–10,000,000 | 模型的总 Token 窗口。决定提示词预算与 SDK 压缩阈值，必须与服务商实际能力一致。每个模型各自保存；这里是回退值。 |
| `agent.max_input_tokens` | `0` | 0 ≤ 值 < `context_window` | 单次请求输入 Token 的硬上限。`0` 表示由 `context_window` 减去 `max_output_tokens` 与固定框架开销推导。运行时先扣除系统提示与当前请求，再用剩余额度限制历史注入量。 |
| `agent.history_token_budget` | `24000` | 0–`context_window` | 对话请求中重新注入历史轮次的 Token 预算；超出后裁剪较早历史，`summary_enabled` 开启时改为压缩成摘要。裁剪使用保守估算（取 chars/4 与 UTF-8 字节数/3 的较大值），避免中文和压缩代码被低估。 |
| `agent.turn_tool_result_bytes` | `262144` | 0–67,108,864 | 单轮内累计工具输出达到该值时，提示模型先记录已确认的结论并改用更聚焦的读取。它是软检查点而非硬上限，运行时会收敛到四个工具输出轮次（128K 窗口约 256 KiB），确保提醒在压缩之前到达。`0` 表示关闭提醒；单轮工具输出仍会被截断。 |
| `agent.compaction_reserve_tokens` | `0` | 0 ≤ 值 < `context_window` | 从 `context_window` 中预留的 Token 数，确保 SDK 压缩输出仍能落在窗口内。`0` 表示完全由工具输出预算、`max_output_tokens` 与固定余量推导；显式值会提升到安全下限，并受窗口 25% 上限约束，避免小上下文在 50% 就压缩。 |
| `agent.compaction_keep_recent_tokens` | `20000` | 0–`context_window` | SDK 压缩时原样保留的最近 Token 数。若与预留相加超出窗口，运行时会下调。 |
| `agent.compaction_trigger_percent` | `85` | 50–95 | 回合结束后触发主动压缩的窗口占比；实际阈值还会为回答输出预留空间。 |
| `agent.compaction_dynamic_threshold` | `true` | 布尔 | 按每轮 token 增长调整触发点：增长快则下调阈值提前压缩，增长慢则上调延后。调整幅度限制为窗口的 10%（下调）/ 5%（上调），并用最近四轮增长做平滑；关闭后固定使用上面的静态百分比。 |
| `agent.summary_enabled` | `true` | 布尔值 | 把被裁剪的对话历史压缩成持久化滚动摘要，供后续轮次复用。 |
| `agent.project_agents_md` | `true` | 布尔值 | 每轮从固定版本 worktree 根目录读取 AGENTS.md（或 AGENTS.override.md）并作为项目指导注入。它被视为不可信的仓库数据，不能覆盖系统提示词或当前请求。 |
| `agent.project_agents_md_max_bytes` | `32768` | 1024–262144 | 每轮注入的项目指导最大字节数，超出部分会被截断。 |

这些上下文预算键是应对服务商「context length exceeded」错误的主要手段：Corvex 在请求离开进程前裁剪历史并限制工具输出，若服务商仍报超窗，会在 `auto_context_tune` 开启时按更小的有效窗口、并再去掉历史重试一次（不写回模型配置）。工具结果在进入会话历史前按助手轮次硬性截断（128K 窗口下单次约 32 KiB、单轮约 64 KiB），因为 SDK 只能估算「最后一条回复之后新增的」内容；压缩预留也由同一个上界推导。它们也可以在运维台设置页面运行时调整。

调用需要鉴权的服务商时，请在控制台的模型配置中保存 API Key。预算会保守地预留提示词字节数加配置的最大输出 Token 数，再根据服务商用量结算；请求结果不确定时会保留预留量。它是 Token 上限，不是根据价格计算的费用上限。

轮次排队时抓取的分支快照只用于判断是否过期；未发布改动的基线单独维护，只在成功发布到会话目标分支后前进，因此发布后「更改」列表会清空，同一轮可继续修改并再次发布而无需 rebase。Pi Session 不开放内建 shell、编辑或写入工具。`read_file` 只读取固定 SHA worktree 或可信 Skill 根目录中的 UTF-8 文本文件，每次最多返回 256 KiB，单行超过 4 KiB 时会截断标记；`tree` 给出有界目录骨架（最多 4 层 / 300 节点 / 24 KiB，不跟随符号链接，跳过依赖与生成目录）；`glob` 按有界文件名模式查找文件（只返回路径）；`search_text` 默认字面量匹配，可显式开启有界的 `regex` 模式；`git_grep` 在固定 HEAD 的已跟踪文件中做有界字面量搜索。字面量工具 `search_text` 跳过常见依赖/生成目录，并限制文件数、总字节与匹配数。仓库文件工具拒绝仓库文件的绝对路径，只有可信 Skill 根目录允许绝对路径。GitLab 与 Git 的写工具都绑定到当前对话，`git_rebase` / `git_cherry_pick` 需要干净工作区且冲突会自动中止（`git_commit` / `git_push` 保存后会 detached 到保存的提交，工作区立即变干净，变基/合并结果在轮末同步回会话 ref；推送非快进时按 `git_sync` → `git_pull` → `git_rebase` 恢复）：Git 写操作只能影响本地 worktree 与镜像，`git_push` 只写 `refs/conversations/<id>`；用户明确要求时，`git_publish` 会一步保存改动并把提交快进推到 GitLab 具名分支（仅快进、不强制、无需传递 SHA），`git_push_branch` 则是已知完整 SHA 时的底层变体；GitLab 写操作固定项目并要求用户明确意图。启用后，`web_fetch` 可通过 HTTPS 访问公网 DNS 主机及默认端口，支持 HTML、JSON（含 `+json` 供应商类型）、纯文本与 XML；会重新校验重定向，拒绝私网/保留地址与黑名单主机，对 JSON 先校验再美化输出，并限制单页字节数、文本字符数与每 Session 抓取页数；响应内容是不可信模型输入。`web_download` 由同一开关控制，可把不超过 16 MiB 的 HTTPS 二进制/大文件写入 worktree 的 `.corvex/downloads/`，复用同样的 SSRF 防护与 DNS 固定，拒绝可执行/安装器扩展名，不覆盖仓库文件，下载内容按不可信数据处理。`web_search` 默认同样启用，用 `X-Tavily-Access-Mode: keyless` 请求 Tavily，无需 key；返回限长的标题/链接/摘要，结果链接经过同样的 URL 校验，429 会转成可读提示，每轮调用次数可配置。免 key 额度有速率限制且查询会离开本机，不允许时可在运维台关闭。当前不提供 MCP 扩展，也没有事件/审查/修复任务专属的工具集。

## 运行时设置

上表中的可调项在运维台「设置」页维护，保存在 SQLite 的 `runtime_settings` 表（含 `updated_at` 与 `updated_by`）；配置文件只提供初始值。控制台保存时提交全部可编辑项，此后数据库就是唯一来源，也不再提供「恢复为配置文件值」。Server 立即把修改作用于后续轮次，并写入 `audit_events`（`update_settings`，操作者为控制台用户名）；启动时也会重新应用已保存的设置。每个字段显示运行时推导出的生效值：例如 `max_input_tokens` 由窗口推导、工具结果检查点收敛到四个工具输出轮次、压缩预留提升到安全下限，因此填写值可能与进程实际使用值不同。

「设置 → 模型」管理模型供应商：每个供应商保存名称、Base URL 与 API Key，并在其下维护各自的模型（上下文窗口与最大输出 Token）。全局只有一个模型处于使用状态：第一个新增的模型自动激活，切换后无需重启即作用于下一轮；每条助手回复也会记录生成它的模型。当前模型覆盖 `agent.model`、`agent.base_url`、`agent.api_key`、`agent.context_window` 与 `agent.max_output_tokens`；目录为空时才使用 YAML 或环境变量回退值。API Key 不会通过接口返回，也不会写入审计日志；密码框留空表示沿用已保存值。请保护数据库文件及其备份。从旧版本升级时，已保存的 `model` / `model_base_url` / `model_api_key` 运行时覆盖会自动迁移成供应商。每个用户还可以在自己的 `#/settings` 页面添加私有供应商与模型，激活时只修改该用户的选择，不影响系统级模型。设置页分为「基础 / 模型 / GitLab / 存储 / 高级」几个分页，连接测试不会回显密钥。

实际可编辑的运行时设置键（来自 `src/config/settings.ts` 的 `runtimeSettingDefinitions`）：

`response_language`、`auto_context_tune`、`max_input_tokens`、`history_token_budget`、`turn_tool_result_bytes`、`compaction_reserve_tokens`、`compaction_keep_recent_tokens`、`compaction_trigger_percent`、`compaction_dynamic_threshold`、`daily_token_budget`、`summary_enabled`、`project_agents_md`、`project_agents_md_max_bytes`、`web_enabled`、`web_blocked_hosts`、`web_search_enabled`、`web_search_max_queries`、`git_tool_call_limit`、`auto_create_merge_request`、`reasoning_enabled`、`agent_request_timeout`、`agent_session_timeout`、`agent_response_stall_timeout`、`skill_paths`、`gitlab_base_url`、`gitlab_oauth_client_id`、`gitlab_oauth_client_secret`、`gitlab_oauth_redirect_uri`、`storage_retention_days`、`storage_audit_retention_days`、`conversation_workspace_ttl_minutes`、`conversation_workspace_max`。

时间参数在界面以秒填写、以毫秒保存。模型名、Base URL、API Key、上下文窗口与输出上限的旧键（`model`、`model_base_url`、`model_api_key`、`context_window`、`max_output_tokens`）仅为升级兼容而保留，已由模型目录接管，不再在界面展示。响应语言与模型在每次请求和轮次读取，修改后无需重启即可作用于下一次。没有事件、审查、修复或 Issue 相关的运行时设置键。

只有启动必需项仍只来自配置文件或环境变量：`server.listen` / `read_timeout` / `shutdown_timeout`、`storage.root` / `storage.database`，以及模型目录为空时兜底的连接参数。

## 完整环境变量列表

| 变量 | 对应配置或用途 |
|---|---|
| `CORVEX_GITLAB_BASE_URL` | 覆盖 `gitlab.base_url` |
| `CORVEX_MODEL_BASE_URL` | 覆盖 `agent.base_url` |
| `CORVEX_MODEL_NAME` | 覆盖 `agent.model` |
| `CORVEX_DATABASE` | 覆盖 `storage.database` |
| `CORVEX_STORAGE_ROOT` | 覆盖 `storage.root` |
| `CORVEX_LISTEN` | 覆盖 `server.listen` |

Compose 还读取 `CORVEX_IMAGE_TAG`、`CORVEX_MEM_LIMIT`、`CORVEX_CPUS`、`CORVEX_PIDS_LIMIT` 等仅用于部署的变量，详见[运行环境与运维](./operations)。GitLab OAuth 凭据由安装页写入 SQLite，不使用环境变量。
