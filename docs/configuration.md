# Configuration reference

Corvex reads YAML from `configs/config.yaml` by default. Override the path with `--config`. Start with [`configs/config.example.yaml`](https://github.com/axetroy/Corvex/blob/main/configs/config.example.yaml). Secrets are read from environment variables, not YAML. Environment overrides listed below take precedence over YAML.

In the tables, sample URLs and paths come from the example YAML; they are not all runtime defaults. Runtime defaults are called out explicitly. In particular, `gitlab.base_url`, `storage.root`, and `storage.database` must be configured.

Duration values use a number followed by `ns`, `us`, `µs`, `ms`, `s`, `m`, or `h`, such as `5s`, `30s`, or `2m`. Paths are resolved relative to the process working directory when relative.

## Server

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `server.listen` | `0.0.0.0:8080` | Non-empty | TCP address for the HTTP server. `CORVEX_LISTEN` overrides it. |
| `server.read_timeout` | `5s` | Positive duration | HTTP header-read timeout. |
| `server.shutdown_timeout` | `30s` | Positive duration | Graceful HTTP shutdown limit. |

The optional operations console uses HTTP Basic Auth credentials supplied only through environment variables. Set both variables to enable it; leave both unset to keep the console disabled. Use a strong, unique password and access the console only over HTTPS.

| Variable | Use |
|---|---|
| `CORVEX_OPS_USERNAME` | Optional operator username for `/ops` and `/api/ops/*`. |
| `CORVEX_OPS_PASSWORD` | Optional operator password; set together with `CORVEX_OPS_USERNAME`. |

## GitLab

| YAML key | Example | Required / limits | Description |
|---|---|---|---|
| `gitlab.base_url` | `https://gitlab.example.com` | Valid HTTP(S) URL | GitLab instance root, without credentials, query, or fragment. `CORVEX_GITLAB_BASE_URL` overrides it. |
| `gitlab.allowed_project_ids` | `[101]` | Must not be empty | GitLab numeric project IDs allowed to invoke Corvex. |
| `gitlab.blocked_user_ids` | `[]` | Optional | GitLab numeric user IDs that cannot invoke commands. By default, any commenter in an allowed project may invoke them. |
| `gitlab.bot_username` | `corvex-bot` | Optional | Username to mention when invoking commands (for example, `@corvex-bot /review`). |

Credentials are mandatory environment variables:

| Variable | Use |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | Required. GitLab API reads and authenticated Git repository fetches. |
| `CORVEX_GITLAB_TOKEN` | Required. Posts MR notes and inline discussions; when Chat writes are enabled, also commits and pushes to same-project MR source branches. Use a separate write token with only the required permissions. |
| `CORVEX_WEBHOOK_SECRET` | Required. Must match the project webhook's secret token. |

## Storage

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `storage.root` | `./data/corvex` | Non-empty | Root for project mirrors and temporary worktrees. `CORVEX_STORAGE_ROOT` overrides it. |
| `storage.database` | `./data/state/corvex.db` | Non-empty | SQLite database path. `CORVEX_DATABASE` overrides it. |
| `storage.retention_days` | `90` | 1–36500 | Retention for terminal jobs, attempts, webhook records, and daily token usage. |
| `storage.audit_retention_days` | `365` | 1–36500 | Retention for audit records. |

Corvex creates the database parent directory, mirror directory, and workspace directory at startup. The process must have write access. Back up the database and Git storage separately.

## Agent and model

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `agent.enabled` | `false` | Boolean | Must be `true` to start a worker. |
| `agent.response_language` | `en` | `en` or `zh-CN` | Language for model-generated summaries, findings, fixes, and explanations. JSON keys, code, paths, and quoted evidence remain unchanged. |
| `agent.base_url` | `https://api.openai.com/v1` | Required when enabled; HTTP(S) URL without credentials/query/fragment | OpenAI-compatible API root. Corvex appends `/chat/completions`. `CORVEX_MODEL_BASE_URL` overrides it. |
| `agent.model` | `your-model-name` | Required when enabled | Provider model name. `CORVEX_MODEL_NAME` overrides it. |
| `agent.request_timeout` | `120s` | Positive duration when enabled | Maximum time for one model request, including SDK retries. |
| `agent.session_timeout` | `30m` | Positive duration when enabled | Maximum time for one complete Pi agent session. |
| `agent.max_output_tokens` | `4096` | 1–8192 when enabled | Maximum requested model output tokens. |
| `agent.daily_token_budget` | `0` | 0–1,000,000,000 | UTC-day token budget; `0` disables budget enforcement. |
| `agent.mcp_enabled` | `false` | Boolean | Enables Pi's MCP extension for review tasks only. MCP servers use the worker process's OS permissions and are not sandboxed. |
| `agent.web_enabled` | `true` | Boolean | Enables the read-only `web_fetch` tool for review and explain tasks. Set to `false` to disable. |
| `agent.web_blocked_hosts` | `[]` | Array of DNS hostnames | Optional exact hostnames to block, including their subdomains. Private, reserved, and special-use IP ranges/hostnames are always blocked. |
| `agent.skill_paths` | `[]` | Array of paths | Additional trusted Pi Skill directories. These paths are also permitted roots for the bounded read-only `read_file` tool. |

`CORVEX_MODEL_API_KEY` is required when the agent is enabled. The budget conservatively reserves prompt bytes plus the configured maximum output tokens, then settles against provider usage. If a request result is uncertain, the reservation is retained. It is a token limit, not a price-based spending cap.

Pi sessions do not expose built-in shell, edit, or write tools. The custom `read_file` tool only reads UTF-8 text files inside the fixed-SHA worktree or configured Skill roots and rejects files larger than 64 KiB. Sequential line-range reads reuse an internal session cursor. `git_grep` searches tracked files at the exact pinned workspace HEAD with a 10-second timeout, 256 KiB output cap, and 50-result limit. Chat additionally exposes `git_log` (up to 50 commits) and `git_show` (full SHA only); both are read-only, scoped to commits reachable from the pinned MR HEAD, and cap output. Chat also provides `update_mr_metadata`, which can change only explicitly requested title/description fields on the current MR. The literal `search_text` tool skips common dependency/generated directories and is limited to 1,000 files, 16 MiB, 256 KiB per file, and 50 matches per call. When enabled, `web_fetch` is available only to review and explain tasks; it can request HTTPS pages from any public DNS host on its default port, revalidates redirects, rejects private/reserved IPs and configured blocked hosts, rejects non-HTML/plain-text content, caps each response at 1 MiB, returns at most 40,000 text characters and 20 same-host links, and allows at most 10 pages per session. Web content is untrusted model input. When MCP is enabled, Pi loads MCP tools only for review tasks from the service's agent directory under `storage.root` (`pi-agent/mcp.json`); only administrator-controlled configurations should be used.

## Chat context

| YAML key | Example/default | Accepted range | Description |
|---|---:|---:|---|
| `chat.history_comments` | `20` | 0–50 | Number of most recent non-system MR comments included in initial chat context. `0` disables automatic inclusion; chat can still use `read_mr_comments` to retrieve comments on demand. |

## Review limits

| YAML key | Example/default | Accepted range | Description |
|---|---:|---:|---|
| `review.max_files` | `100` | 1–1000 | Maximum changed files considered by one review; selected files are sent in batches of at most 10, further limited by context size. |
| `review.max_findings` | `30` | 1–100 | Maximum unique accepted findings across all batches in one review. |
| `review.max_context_bytes` | `2097152` (2 MiB) | 1 byte–8 MiB | Maximum serialized review/explain/fix context. |
| `review.batch_concurrency` | `2` | 1–4 | Maximum number of independent review batches processed simultaneously. |

`review.max_files` is a total per-review ceiling, not the batch size. Files or findings outside configured or safety limits can be omitted or rejected; omitted files are reported as partial coverage and are not silently treated as reviewed.

## Worker

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `worker.poll_interval` | `2s` | Positive duration | Delay between polls when no task is available. |
| `worker.job_timeout` | `30m` | Positive duration | Overall execution timeout for a claimed job. |

The job lease is currently fixed at 30 seconds and renewed during execution; it is not a YAML option.

## Fix proposals

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `fix.enabled` | `false` | Boolean | Enables fix task processing; requires `agent.enabled: true`. |
| `fix.max_patch_bytes` | `131072` (128 KiB) | 1 byte–256 KiB | Maximum model-proposed patch size. |

Fix requests follow the same project allowlist and optional user blocklist as other commands.

## All environment variables

| Variable | YAML setting or purpose |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | GitLab read token; required in worker mode |
| `CORVEX_GITLAB_TOKEN` | GitLab write token; required in server and worker modes |
| `CORVEX_WEBHOOK_SECRET` | Webhook secret; required in server mode |
| `CORVEX_OPS_USERNAME` | Optional operator username; set together with `CORVEX_OPS_PASSWORD` |
| `CORVEX_OPS_PASSWORD` | Optional operations console password; set together with `CORVEX_OPS_USERNAME` |
| `CORVEX_MODEL_API_KEY` | Model API key; required in worker mode when the agent is enabled |
| `CORVEX_MODEL_BASE_URL` | Overrides `agent.base_url` |
| `CORVEX_MODEL_NAME` | Overrides `agent.model` |
| `CORVEX_GITLAB_BASE_URL` | Overrides `gitlab.base_url` |
| `CORVEX_DATABASE` | Overrides `storage.database` |
| `CORVEX_STORAGE_ROOT` | Overrides `storage.root` |
| `CORVEX_LISTEN` | Overrides `server.listen` |

Compose also reads deployment-only variables such as `CORVEX_IMAGE_TAG`, `CORVEX_MEM_LIMIT`, and `CORVEX_CPUS`; see [Runtime and operations](./operations).
