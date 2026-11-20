# Configuration reference

Corvex reads YAML from `configs/config.yaml` by default. Override the path with `--config`. Start with [`configs/config.example.yaml`](https://github.com/axetroy/Corvex/blob/main/configs/config.example.yaml). Secrets are read from environment variables, not YAML. Environment overrides listed below take precedence over YAML.

Load environment variables from a dotenv-style file with `--env <path>`, for example `pnpm start -- --env .env --config configs/config.yaml server`. Relative paths are resolved from the current working directory. Variables already set in the process environment take precedence over values in the file.

In the tables, sample URLs and paths come from the example YAML; they are not all runtime defaults. Runtime defaults are called out explicitly. In particular, `storage.root` and `storage.database` must be configured. `gitlab.base_url` is managed in the console Settings page.

Duration values use a number followed by `ns`, `us`, `µs`, `ms`, `s`, `m`, or `h`, such as `5s`, `30s`, or `2m`. Paths are resolved relative to the process working directory when relative.

## Server

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `server.listen` | `0.0.0.0:8080` | Non-empty | TCP address for the HTTP server. `CORVEX_LISTEN` overrides it. |
| `server.read_timeout` | `5s` | Positive duration | HTTP header-read timeout. |
| `server.shutdown_timeout` | `30s` | Positive duration | Graceful HTTP shutdown limit. |

The agent console at `/ops` uses GitLab OAuth2 login. Every user signs in with their own GitLab account and Corvex uses that user's token for console API calls and conversations.

## GitLab

| YAML key | Example | Required / limits | Description |
|---|---|---|---|
| `gitlab.base_url` | — | Optional bootstrap fallback | GitLab instance root, managed in the console Settings page. `CORVEX_GITLAB_BASE_URL` provides a startup fallback when the console has no saved value. |
| `gitlab.blocked_user_ids` | `[]` | Optional | GitLab numeric user IDs that cannot invoke commands. Any commenter whose webhook has the configured secret may invoke commands unless their ID is blocked. |
| `gitlab.bot_username` | `corvex-bot` | Optional | Username to mention when invoking commands (for example, `@corvex-bot /review`). |

Credentials are optional startup fallbacks; the console Settings page stores them in SQLite. Secret fields are never returned by the API, and a blank field keeps the saved value.

| Variable | Use |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | Optional startup fallback. GitLab API reads, project/target discovery, authenticated Git fetches and inline events use the value saved in the console Settings page. |
| `CORVEX_GITLAB_TOKEN` | Optional startup fallback. Used for GitLab writes; posts notes and inline discussions, and enables same-project MR Git writes and Issue implementation when configured in the console. |
| `CORVEX_WEBHOOK_SECRET` | Optional startup fallback. Must match the secret saved in the console; webhooks are rejected until a secret is configured. |

## Per-user GitLab login

The console authenticates each operator through GitLab OAuth2 authorization code flow. On first visit, unauthenticated requests are redirected to `/setup`, where you enter the GitLab instance URL plus the OAuth Application ID, secret and callback URL; these values are stored in SQLite and can later be edited under **Settings → GitLab configuration**. No environment variables are needed. The encryption key for stored user tokens is generated on first start and kept in SQLite.

Each user's access token is encrypted in SQLite and used for that user's console API calls and conversations. Webhook-triggered events still use the site-level GitLab tokens above.

## Storage

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `storage.root` | `./data/corvex` | Non-empty | Root for project mirrors and temporary worktrees. `CORVEX_STORAGE_ROOT` overrides it. |
| `storage.database` | `./data/state/corvex.db` | Non-empty | SQLite database path. `CORVEX_DATABASE` overrides it. |
| `storage.retention_days` | `90` | 1–36500 | Retention for terminal events, attempts, webhook records, and daily token usage. |
| `storage.audit_retention_days` | `365` | 1–36500 | Retention for audit records. |

Corvex creates the database parent directory, mirror directory, and workspace directory at startup. The process must have write access. Back up the database and Git storage separately.

## Agent and model

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `agent.response_language` | `en` | `en` or `zh-CN` | Language for model-generated summaries, findings, fixes, explanations, and Issue replies or implementation summaries. JSON keys, code, paths, and quoted evidence remain unchanged. Editable at runtime from the console. |
| `agent.base_url` | `https://api.openai.com/v1` | HTTP(S) URL without credentials/query/fragment | OpenAI-compatible API root. Corvex appends `/chat/completions`. `CORVEX_MODEL_BASE_URL` overrides it. Normally managed per provider in the console; this value is the fallback when no model is active. |
| `agent.model` | `your-model-name` | — | Provider model name. `CORVEX_MODEL_NAME` overrides it. Normally managed per provider in the console; this value is the fallback when no model is active. |
| `agent.request_timeout` | `120s` | Positive duration when enabled | Maximum time for one model request, including SDK retries. |
| `agent.session_timeout` | `30m` | Positive duration when enabled | Maximum time for one complete Pi agent session. |
| `agent.max_output_tokens` | `4096` | 1–8192 when enabled | Maximum requested model output tokens. Each model stores its own value; this is the fallback. |
| `agent.daily_token_budget` | `0` | 0–1,000,000,000 | UTC-day token budget; `0` disables budget enforcement. |
| `agent.mcp_enabled` | `false` | Boolean | Enables Pi's MCP extension for review tasks only. MCP servers use the Server process's OS permissions and are not sandboxed. |
| `agent.web_enabled` | `true` | Boolean | Enables the read-only `web_fetch` tool for review and explain tasks. Set to `false` to disable. |
| `agent.web_blocked_hosts` | `[]` | Array of DNS hostnames | Optional exact hostnames to block, including their subdomains. Private, reserved, and special-use IP ranges/hostnames are always blocked. |
| `agent.skill_paths` | `[]` | Array of paths | Additional trusted Pi Skill directories. These paths are also permitted roots for the bounded read-only `read_file` tool. |
| `agent.context_window` | `131072` | 1,024–10,000,000 | Total token window of the model. It drives prompt budgets and the SDK compaction threshold; it must match what the provider serves. Each model stores its own window; this is the fallback when no model is active. |
| `agent.max_input_tokens` | `0` | 0 ≤ value < `context_window` | Hard cap on the input of one conversation request. `0` derives it from `context_window` minus `max_output_tokens` and a fixed framing overhead. The runtime reserves the system prompt and current request, then bounds history with the remainder. |
| `agent.history_token_budget` | `24000` | 0–`context_window` | Token budget for re-injecting earlier turns into a conversation request. Older history beyond it is trimmed, or summarized when `summary_enabled` is on. Trimming uses a conservative estimate (the larger of chars/4 and UTF-8 bytes/3), so CJK and dense code are not undercounted. |
| `agent.turn_tool_result_bytes` | `262144` | 0–67,108,864 | Cumulative tool-output bytes within one turn before the model is told to record what it has confirmed and continue with more targeted reads. It is a soft checkpoint, not a hard cap, and the runtime caps it at four tool-output rounds (about 256 KiB for a 128K window) so the reminder arrives before compaction. `0` disables the reminder; tool output is still truncated per round. |
| `agent.compaction_reserve_tokens` | `16384` | 0 ≤ value < `context_window` | Tokens held back from `context_window` so SDK compaction output still fits. The runtime raises it to a safe floor: the worst-case token growth of one tool-output round plus `max_output_tokens` and a margin (about 45,056 for a 128K window with 8K output). |
| `agent.compaction_keep_recent_tokens` | `20000` | 0–`context_window` | Recent tokens the SDK keeps verbatim when it compacts. The runtime lowers it when it would not fit next to the reserve. |
| `agent.summary_enabled` | `true` | Boolean | Compress trimmed conversation history into a stored rolling summary that later turns reuse. |

These context-budget keys are the primary defence against provider `context length exceeded` errors: Corvex trims history and caps tool output before a request leaves the process, and makes one more aggressive retry without history if the provider still reports an overflow. Tool results are hard-truncated per assistant round (32 KiB per call and 64 KiB per round for a 128K window) before they enter session history, because the SDK can only estimate what was added since the last response; the compaction reserve is derived from that same bound. They can also be tuned at runtime from the agent console Settings page without editing the config file.

Store the API key on the provider in the console before the agent calls a provider that needs authentication. The budget conservatively reserves prompt bytes plus the configured maximum output tokens, then settles against provider usage. If a request result is uncertain, the reservation is retained. It is a token limit, not a price-based spending cap.

Pi sessions do not expose built-in shell, edit, or write tools. The custom `read_file` tool only reads UTF-8 text files inside the fixed-SHA worktree or configured Skill roots. Each call returns at most 256 KiB, and lines longer than 4 KiB are truncated with a marker (common in minified bundles); larger files must be read in line ranges, and sequential line-range reads reuse an internal session cursor. `git_grep` searches tracked files at the exact pinned workspace HEAD with a 10-second timeout, 256 KiB output cap, and 50-result limit. Chat additionally exposes `git_log` (up to 50 commits) and `git_show` (full SHA only); both are read-only, scoped to commits reachable from the pinned MR HEAD, and cap output. Chat also provides `update_mr_metadata`, which can change only explicitly requested title/description fields on the current MR. The literal `search_text` tool skips common dependency/generated directories and is limited to 1,000 files, 16 MiB, 256 KiB per file, and 50 matches per call. When enabled, `web_fetch` is available only to review and explain tasks; it can request HTTPS pages from any public DNS host on its default port, revalidates redirects, rejects private/reserved IPs and configured blocked hosts, rejects non-HTML/plain-text content, caps each response at 1 MiB, returns at most 40,000 text characters and 20 same-host links, and allows at most 10 pages per session. Web content is untrusted model input. When MCP is enabled, Pi loads MCP tools only for review tasks from the service's agent directory under `storage.root` (`pi-agent/mcp.json`); only administrator-controlled configurations should be used.

## Runtime settings

Tunable agent settings are edited in the console **Settings** page and stored in the SQLite `runtime_settings` table (with `updated_at` and `updated_by`); the config file only supplies their initial values. The console submits the complete editable set on save, so the database is the source of truth afterwards and there is no "restore to config file" action. The Server applies a change to new turns immediately and records it in `audit_events` (`update_settings`, actor = console username). The inline event runner is woken when a setting is saved, so a queued event picks up the change immediately, and it rebuilds the components that read review and repair limits in their constructor. The Server reapplies stored settings at startup, so a restart never silently reverts the values shown in the console.

**Settings → Model** manages model providers: each provider stores a name, Base URL and API key, and lists its own models with a context window and max output tokens. Exactly one model is active globally: the first model added is activated automatically, and choosing another applies it to the Server and the inline event runner without a restart. Every assistant reply records the model that produced it. The active model overrides `agent.model`, `agent.base_url`, `agent.api_key`, `agent.context_window` and `agent.max_output_tokens`; those YAML values and environment variables are the fallback while the catalog is empty. The API key is never returned by the API or written to audit logs; leaving its password field empty keeps the saved value. Protect the SQLite file and its backups because they contain the key. Upgrading from an older version migrates stored `model` / `model_base_url` / `model_api_key` runtime overrides into a provider automatically, and splits the previous single-table model list into providers and models.

Editable keys: `agent.response_language`, `agent.max_input_tokens`, `agent.history_token_budget`, `agent.turn_tool_result_bytes`, `agent.compaction_reserve_tokens`, `agent.compaction_keep_recent_tokens`, `agent.daily_token_budget`, `agent.summary_enabled`, `agent.web_enabled`, `agent.mcp_enabled`, `agent.web_blocked_hosts`, `agent.skill_paths`, `agent.request_timeout`, `agent.session_timeout`, `review.max_files`, `review.max_findings`, `review.max_context_bytes`, `review.batch_concurrency`, `chat.history_comments`, `issue.history_comments`, `fix.enabled`, `fix.max_patch_bytes`, `issue.implement_enabled`, `events.poll_interval`, `events.event_timeout`, `gitlab.bot_username`, `gitlab.blocked_user_ids`, `storage.retention_days`, `storage.audit_retention_days`, `storage.conversation_workspace_ttl_minutes` and `storage.conversation_workspace_max`. Time values are entered in seconds and stored in milliseconds. The response language and model are read on every request and turn, so a change takes effect on the next one without a restart.

Only bootstrap settings remain file/environment-only: `server.listen`/`read_timeout`/`shutdown_timeout`, `storage.root`, `storage.database` and the fallback model connection values. Each field shows its effective value when the runtime adjusted it: the runtime derives `max_input_tokens`, clamps the tool-result checkpoint to four tool-output rounds, and raises the compaction reserve to its safe floor, so an entered value may intentionally differ from what the process uses.

## Chat context

| YAML key | Example/default | Accepted range | Description |
|---|---:|---:|---|
| `chat.history_comments` | `20` | 0–50 | Number of most recent non-system MR comments included in initial chat context. `0` disables automatic inclusion; chat can still use `read_mr_comments` to retrieve comments on demand. |

## Review limits

| YAML key | Example/default | Accepted range | Description |
|---|---:|---:|---|
| `review.max_files` | `100` | 1–1000 | Maximum changed files considered by one review; selected files are sent in batches of at most 10, further limited by context size. |
| `review.max_findings` | `30` | 1–100 | Maximum unique accepted findings across all batches in one review. |
| `review.max_context_bytes` | `2097152` (2 MiB) | 1 byte–8 MiB | Configured serialized-context ceiling. The event runner additionally caps each user prompt at 80 KiB and system-plus-user prompt at 96 KiB to fit the 128K-token model window with output and tool reserves; these byte limits are conservative bounds, not tokenizer counts. |
| `review.batch_concurrency` | `2` | 1–4 | Maximum number of independent review batches processed simultaneously. |

`review.max_files` is a total per-review ceiling, not the batch size. Files or findings outside configured or safety limits can be omitted or rejected; omitted files are reported as partial coverage and are not silently treated as reviewed.

## Event execution

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `events.poll_interval` | `2s` | Positive duration | Fallback delay between polls when no task is available; newly queued events are woken immediately. |
| `events.event_timeout` | `30m` | Positive duration | Overall execution timeout for a claimed event. |

The event lease is currently fixed at 30 seconds and renewed during execution; it is not a YAML option. Upgrading from an older version automatically migrates saved `worker_poll_interval` / `worker_event_timeout` overrides to `events_poll_interval` / `events_timeout`, and a YAML `worker:` section is still read as a fallback for `events:`.

## Fix proposals

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `fix.enabled` | `false` | Boolean | Enables fix task processing. |
| `fix.max_patch_bytes` | `131072` (128 KiB) | 1 byte–256 KiB | Maximum model-proposed Fix or Issue implementation patch size. |

Fix requests follow the same optional user blocklist as other commands. Register webhooks only on projects where Corvex should accept commands; the agent console can discover every project visible to its read token.

## Issue implementation

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `issue.implement_enabled` | `false` | Boolean | Enables code writes for Issue tasks. Ordinary `@<bot> <request>` mentions can still receive analysis/replies while this is false. When enabled, the event runner may create a new `corvex/issue-*` branch and Draft MR for an implementation request. It does not execute repository code or merge automatically. |
| `issue.history_comments` | `20` | 0–50 | Number of most recent non-system Issue comments included in the initial assistant context. `0` disables comment history. Pagination and aggregate byte limits cap the context. |

Issue tasks use the project default branch unless the current request explicitly names another existing branch; comments do not authorize branch selection. Implementation needs `CORVEX_GITLAB_TOKEN` with permission to push branches and create merge requests. Generated patches are restricted to ordinary text-file changes and validated paths. A failed/uncertain publish is not automatically retried; inspect the Issue task events and project branches before retrying.

## All environment variables

| Variable | YAML setting or purpose |
|---|---|
| `CORVEX_GITLAB_READ_TOKEN` | GitLab read token; optional startup fallback, normally saved in console Settings |
| `CORVEX_GITLAB_TOKEN` | GitLab write token; optional startup fallback, normally saved in console Settings |
| `CORVEX_WEBHOOK_SECRET` | Webhook secret; optional startup fallback, normally saved in console Settings |
| `CORVEX_MODEL_BASE_URL` | Overrides `agent.base_url` |
| `CORVEX_MODEL_NAME` | Overrides `agent.model` |
| `CORVEX_GITLAB_BASE_URL` | Overrides `gitlab.base_url` |
| `CORVEX_DATABASE` | Overrides `storage.database` |
| `CORVEX_STORAGE_ROOT` | Overrides `storage.root` |
| `CORVEX_LISTEN` | Overrides `server.listen` |

Compose also reads deployment-only variables such as `CORVEX_IMAGE_TAG`, `CORVEX_MEM_LIMIT`, and `CORVEX_CPUS`; see [Runtime and operations](./operations).
