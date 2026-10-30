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

可选运维控制台仅通过环境变量配置 HTTP Basic Auth。设置两个变量后启用；两个都不设置则禁用控制台。请使用强且唯一的密码，并且仅通过 HTTPS 访问。

| 变量 | 用途 |
|---|---|
| `CORVEX_OPS_USERNAME` | `/ops` 和 `/api/ops/*` 的可选运维用户名。 |
| `CORVEX_OPS_PASSWORD` | 可选运维密码；须与 `CORVEX_OPS_USERNAME` 同时设置。 |

## GitLab

| YAML 键 | 示例 | 必填 / 限制 | 说明 |
|---|---|---|---|
| `gitlab.base_url` | `https://gitlab.example.com` | 有效 HTTP(S) URL | GitLab 实例根地址，不含凭据、查询参数或片段。`CORVEX_GITLAB_BASE_URL` 可覆盖。 |
| `gitlab.allowed_project_ids` | `[101]` | 不能为空 | 允许使用 Corvex 的 GitLab 数字项目 ID。 |
| `gitlab.allowed_user_ids` | `[1001]` | 不能为空 | 允许使用 Corvex 的 GitLab 数字用户 ID。 |
| `gitlab.bot_username` | `corvex-bot` | 可选 | 忽略此用户名发出的评论，防止机器人反馈循环。 |

以下凭据为必填环境变量：

| 变量 | 用途 |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | 必填。读取 GitLab API 及通过 Git 抓取仓库。 |
| `CORVEX_GITLAB_TOKEN` | 必填。发布 MR 评论和行级讨论；应使用独立写令牌。 |
| `CORVEX_WEBHOOK_SECRET` | 必填。必须与项目 Webhook 的 Secret Token 一致。 |
| `CORVEX_OPS_USERNAME` | 可选运维用户名；须与 `CORVEX_OPS_PASSWORD` 同时设置 |
| `CORVEX_OPS_PASSWORD` | 可选运维控制台密码；须与 `CORVEX_OPS_USERNAME` 同时设置 |

## 存储

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `storage.root` | `./data/corvex` | 非空 | 项目镜像和临时 worktree 根目录。`CORVEX_STORAGE_ROOT` 可覆盖。 |
| `storage.database` | `./data/state/corvex.db` | 非空 | SQLite 数据库路径。`CORVEX_DATABASE` 可覆盖。 |
| `storage.retention_days` | `90` | 1–36500 | 终态任务、尝试、Webhook 记录和每日 Token 用量的保留天数。 |
| `storage.audit_retention_days` | `365` | 1–36500 | 审计记录的保留天数。 |

启动时 Corvex 会创建数据库父目录、镜像目录和工作区目录；运行进程必须拥有写权限。数据库和 Git 存储需要分别备份。

## Agent 与模型

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `agent.enabled` | `false` | 布尔值 | 启动 Worker 时必须设为 `true`。 |
| `agent.response_language` | `en` | `en` 或 `zh-CN` | 模型生成的摘要、审查发现、修复说明和文件解释所用语言。JSON 键名、代码、路径和引用证据保持原样。 |
| `agent.base_url` | `https://api.openai.com/v1` | 启用时必填；有效 HTTP(S) URL，不含凭据/查询/片段 | OpenAI 兼容 API 根地址。Corvex 会追加 `/chat/completions`。`CORVEX_MODEL_BASE_URL` 可覆盖。 |
| `agent.model` | `your-model-name` | 启用时必填 | 服务商模型名称。`CORVEX_MODEL_NAME` 可覆盖。 |
| `agent.request_timeout` | `120s` | 启用时必须为正时长 | 单次模型请求（包括 SDK 重试）的最大等待时间。 |
| `agent.session_timeout` | `30m` | 启用时必须为正时长 | 单个 Pi Agent Session 的总运行时限。 |
| `agent.max_output_tokens` | `4096` | 启用时为 1–8192 | 请求模型生成的最大输出 Token 数。 |
| `agent.daily_token_budget` | `0` | 0–1,000,000,000 | UTC 每日 Token 预算；`0` 表示不限制预算。 |
| `agent.web_enabled` | `true` | 布尔值 | 启用只读 `web_fetch` 工具，默认允许访问所有公网 HTTPS 主机；设为 `false` 可关闭。 |
| `agent.web_blocked_hosts` | `[]` | DNS 主机名数组 | 可选的精确主机名黑名单，同时拦截其子域名。私网、保留用途 IP 段和特殊用途主机名始终被拦截。 |

启用 Agent 后必须提供 `CORVEX_MODEL_API_KEY`。预算会保守地预留提示词字节数加配置的最大输出 Token 数，再根据服务商用量结算。请求结果不确定时会保留预留量。它是 Token 上限，不是根据价格计算的费用上限。

Pi Session 不开放内建 shell、编辑或写入工具。自定义 `read_file` 只读取固定 SHA worktree 或配置的 Skill 根目录中的 UTF-8 文本文件，单文件上限为 64 KiB。启用后，`web_fetch` 可通过 HTTPS 访问任意公网 DNS 主机及默认端口，会重新校验重定向，拒绝私网/保留地址和配置的黑名单主机；拒绝 HTML/纯文本之外的响应。单页响应体上限为 1 MiB，最多返回 40,000 个文本字符和 20 个同主机链接，每个 Session 最多抓取 10 页。网页内容是不可信模型输入。启用 MCP 时，Pi 会从 `storage.root` 下服务的 Agent 目录（`pi-agent/mcp.json`）读取 MCP 配置；只能使用管理员控制的配置。

## 审查限制

| YAML 键 | 示例/默认值 | 可接受范围 | 说明 |
|---|---:|---:|---|
| `review.max_files` | `100` | 1–1000 | 单次审查最多考虑的变更文件数。 |
| `review.max_findings` | `30` | 1–100 | 单次模型回复最多接受的问题数。 |
| `review.max_context_bytes` | `2097152`（2 MiB） | 1 字节–8 MiB | 序列化后的审查/解释/Fix 上下文大小上限。 |

超过限制的文件或问题可能会被忽略或拒绝；不能因此认为这些内容已经过审查。

## Worker

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `worker.poll_interval` | `2s` | 正时长 | 无任务时两次轮询之间的等待时间。 |
| `worker.job_timeout` | `30m` | 正时长 | 单个已领取任务的总执行超时。 |

任务租约固定为 30 秒，执行期间会续租；当前不是 YAML 配置项。

## 修复提案

| YAML 键 | 示例/默认值 | 必填 / 限制 | 说明 |
|---|---:|---|---|
| `fix.enabled` | `false` | 布尔值 | 启用 Fix 任务；同时要求 `agent.enabled: true`。 |
| `fix.allowed_user_ids` | `[]` | 启用时不能为空 | Fix 请求的额外 GitLab 数字用户白名单。 |
| `fix.max_patch_bytes` | `131072`（128 KiB） | 1 字节–256 KiB | 模型补丁大小上限。 |

Fix 发起者必须同时属于 `gitlab.allowed_user_ids` 和 `fix.allowed_user_ids`。

## 完整环境变量列表

| 变量 | 对应配置或用途 |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | GitLab 读取令牌，Worker 模式必填 |
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
