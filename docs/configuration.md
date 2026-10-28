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
| `gitlab.allowed_user_ids` | `[1001]` | Must not be empty | GitLab numeric user IDs allowed to invoke Corvex. |
| `gitlab.bot_username` | `corvex-bot` | Optional | Notes from this username are ignored to prevent bot feedback loops. |

Credentials are mandatory environment variables:

| Variable | Use |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | Required. GitLab API reads and authenticated Git repository fetches. |
| `CORVEX_GITLAB_TOKEN` | Required. Posts MR notes and inline discussions. Use a separate write token. |
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
| `agent.base_url` | `https://api.openai.com/v1` | Required when enabled; HTTP(S) URL without credentials/query/fragment | OpenAI-compatible API root. Corvex appends `/chat/completions`. `CORVEX_MODEL_BASE_URL` overrides it. |
| `agent.model` | `your-model-name` | Required when enabled | Provider model name. `CORVEX_MODEL_NAME` overrides it. |
| `agent.request_timeout` | `120s` | Positive duration when enabled | Maximum time for one model request. |
| `agent.max_output_tokens` | `4096` | 1–8192 when enabled | Maximum requested model output tokens. |
| `agent.daily_token_budget` | `0` | 0–1,000,000,000 | UTC-day token budget; `0` disables budget enforcement. |
| `agent.mcp_enabled` | `false` | Boolean | Enables Pi's MCP extension. MCP servers use the worker process's OS permissions and are not sandboxed. |
| `agent.skill_paths` | `[]` | Array of paths | Additional trusted Pi Skill directories. These paths are also permitted roots for the bounded read-only `read_file` tool. |

`CORVEX_MODEL_API_KEY` is required when the agent is enabled. The budget conservatively reserves prompt bytes plus the configured maximum output tokens, then settles against provider usage. If a request result is uncertain, the reservation is retained. It is a token limit, not a price-based spending cap.

Pi sessions do not expose built-in shell, edit, or write tools. The custom `read_file` tool only reads UTF-8 text files inside the fixed-SHA worktree or configured Skill roots and rejects files larger than 64 KiB. When MCP is enabled, Pi reads its MCP configuration from the service's agent directory under `storage.root` (`pi-agent/mcp.json`); only administrator-controlled configurations should be used.

## Review limits

| YAML key | Example/default | Accepted range | Description |
|---|---:|---:|---|
| `review.max_files` | `100` | 1–1000 | Maximum changed files considered by one review. |
| `review.max_findings` | `30` | 1–100 | Maximum accepted findings in a model response. |
| `review.max_context_bytes` | `2097152` (2 MiB) | 1 byte–8 MiB | Maximum serialized review/explain/fix context. |

Files or findings outside limits can be omitted or rejected; they are not silently treated as reviewed.

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
| `fix.allowed_user_ids` | `[]` | Non-empty when enabled | Additional numeric GitLab user allowlist for fix requests. |
| `fix.max_patch_bytes` | `131072` (128 KiB) | 1 byte–256 KiB | Maximum model-proposed patch size. |

Fix requesters must be present in both `gitlab.allowed_user_ids` and `fix.allowed_user_ids`.

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
