# Configuration reference

Corvex reads YAML from `configs/config.yaml` by default. Override the path with `--config`. Start with [`configs/config.example.yaml`](https://github.com/axetroy/Corvex/blob/main/configs/config.example.yaml). Secrets and runtime-tunable values are managed in the console and stored in SQLite; environment overrides listed below take precedence over YAML.

Load environment variables from a dotenv-style file with `--env <path>`, for example `pnpm start -- --env .env --config configs/config.yaml server`. Relative paths are resolved from the current working directory. Variables already set in the process environment take precedence over values in the file.

In the tables, sample URLs and paths come from the example YAML or the built-in defaults; they are not all required settings. In particular, `storage.root` and `storage.database` must be configured. GitLab connection values, model providers, budgets, tool switches and retention days are edited in the console and persisted in SQLite, which becomes the source of truth after the first save.

Duration values use a number followed by `ns`, `us`, `µs`, `ms`, `s`, `m`, or `h`, such as `5s`, `30s`, or `2m`. Paths are resolved relative to the process working directory when relative.

The YAML schema has four active sections — `server`, `gitlab`, `storage` and `agent` — plus a legacy `operations` mapping kept for compatibility. Authentication uses GitLab OAuth2, so no console password is configured there.

## Server

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `server.listen` | `0.0.0.0:8080` | Non-empty | TCP address for the HTTP server. `CORVEX_LISTEN` overrides it. |
| `server.read_timeout` | `5s` | Positive duration | HTTP header-read timeout. |
| `server.shutdown_timeout` | `30s` | Positive duration | Graceful HTTP shutdown limit. |

The agent console at `/ops` uses GitLab OAuth2 login. Every user signs in with their own GitLab account and Corvex uses that user's token for console API calls and conversations.

## Operations

The `operations` section is retained only for backward compatibility. Console authentication is GitLab OAuth2; there is no static operator password to configure. The legacy `operations.username` value may be used as the actor name in audit rows when no console user is available, but it is not required.

## GitLab

| YAML key | Example | Required / limits | Description |
|---|---|---|---|
| `gitlab.base_url` | — | Optional bootstrap fallback | GitLab instance root. `CORVEX_GITLAB_BASE_URL` provides a startup fallback; the value shown in the console Settings page is the effective one after the first save. |
| `gitlab.oauth_client_id` | — | Optional | OAuth application client ID, entered on the first-run `/setup` page. |
| `gitlab.oauth_client_secret` | — | Optional | OAuth application client secret, entered on `/setup` and stored encrypted in SQLite. |
| `gitlab.oauth_redirect_uri` | — | Optional | OAuth callback URL, entered on `/setup`; must point back to the console (for example `https://corvex.example.com/auth/gitlab/callback`). |

Credentials are optional startup fallbacks; the console Settings page stores them in SQLite. Secret fields are never returned by the API, and a blank field keeps the saved value. GitLab OAuth requires the client ID, client secret and redirect URI to be set together.

Clone and web URLs are derived from `gitlab.base_url` plus each project's `path_with_namespace`; GitLab's own `http_url_to_repo` and `web_url` values are ignored because they follow the instance `external_url` and may point at an address Corvex cannot reach. The Git manager still requires the resulting URL to match the configured scheme and host.

## Per-user GitLab login

The console authenticates each operator through the GitLab OAuth2 authorization code flow. On first visit, unauthenticated requests are redirected to `/setup`, where you enter the GitLab instance URL plus the OAuth application's client ID, secret and callback URL; these values are stored in SQLite and can later be edited under **Settings → GitLab configuration**. No environment variables are needed for OAuth.

Each user's access token is encrypted in SQLite and used for that user's console API calls and conversations. Project search is limited to projects visible to that token, so there is no static allowlist to maintain. Users can also keep personal model providers under `#/settings`; these never affect other users.

## Storage

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `storage.root` | `./data/corvex` | Non-empty | Root for project mirrors and conversation worktrees. `CORVEX_STORAGE_ROOT` overrides it. |
| `storage.database` | `./data/state/corvex.db` | Non-empty | SQLite database path. `CORVEX_DATABASE` overrides it. |
| `storage.retention_days` | `90` | 1–36500 | Retention for terminal conversation turns, their trace and execution records, cleanup logs and daily token usage. |
| `storage.audit_retention_days` | `365` | 1–36500 | Retention for audit records. |
| `storage.conversation_workspace_ttl_minutes` | `60` | 1–14400 | Idle time after which a conversation worktree may be released. |
| `storage.conversation_workspace_max` | `8` | 1–200 | Maximum number of cached conversation worktrees (least-recently-used first). |

Corvex creates the database parent directory, mirror directory, and workspace directory at startup. The process must have write access. Back up the database and Git storage separately. Worktree eviction never touches a conversation with a queued or running turn; an evicted idle worktree is rebuilt on the next turn.

## Agent and model

| YAML key | Example/default | Required / limits | Description |
|---|---:|---|---|
| `agent.response_language` | `en` | `en` or `zh-CN` | Language for model-generated replies. JSON keys, code, paths, and quoted evidence remain unchanged. Editable at runtime from the console. |
| `agent.base_url` | `https://api.openai.com/v1` | HTTP(S) URL without credentials/query/fragment | OpenAI-compatible API root. Corvex appends `/chat/completions`. `CORVEX_MODEL_BASE_URL` overrides it. Normally managed per provider in the console; this value is the fallback when no model is active. |
| `agent.model` | — | — | Provider model name. `CORVEX_MODEL_NAME` overrides it. Normally managed per provider in the console; this value is the fallback when no model is active. |
| `agent.api_key` | — | — | Provider API key. Managed in the console on the provider record; it is never returned by the API or written to audit logs. |
| `agent.auto_context_tune` | `true` | Boolean | On a recognized provider overflow, lower the effective context window for that fresh-session retry only. The stored model configuration is never changed. |
| `agent.request_timeout` | `120s` | Positive duration when enabled | Maximum time for one model request, including SDK retries. |
| `agent.session_timeout` | `30m` | Positive duration when enabled | Maximum time for one complete Pi agent session. |
| `agent.response_stall_timeout` | `180s` | 0 or positive duration | Abort a turn when the model produces no output (response headers, text, thinking or tool calls) for this long; a waiting notice is streamed to the console while idle. `0` disables the watchdog. Model requests use a matching undici dispatcher so `request_timeout` also covers response headers. |
| `agent.max_output_tokens` | `4096` | 1–8192 | Maximum requested model output tokens. Each model stores its own value; this is the fallback. |
| `agent.daily_token_budget` | `0` | 0–1,000,000,000 | UTC-day token budget; `0` disables budget enforcement. |
| `agent.web_enabled` | `true` | Boolean | Enables the read-only `web_fetch` tool. Set to `false` to disable. |
| `agent.web_search_enabled` | `true` | Boolean | Enables `web_search` via Tavily's free keyless mode. No API key is needed, but every query is sent to Tavily. |
| `agent.web_search_max_queries` | `5` | Number | Maximum `web_search` calls per turn (1–50). |
| `agent.git_tool_call_limit` | `40` | 0–200 | Maximum Git tool calls per turn (failed calls count too). Once exhausted the agent stops using Git tools and reports progress; `0` disables the limit. |
| `agent.auto_create_merge_request` | `true` | Boolean | After the first successful publish to a feature branch, reuse an open MR or create one automatically with the signed-in user token (source = published branch, target = conversation branch). |
| `agent.web_blocked_hosts` | `[]` | Array of DNS hostnames (max 100) | Optional exact hostnames to block, including their subdomains. Private, reserved, and special-use IP ranges/hostnames are always blocked. |
| `agent.skill_paths` | `[]` | Array of paths | Additional trusted Pi Skill directories. These paths are also permitted roots for the bounded read-only `read_file` tool. |
| `agent.context_window` | `131072` | 1,024–10,000,000 | Total token window of the model. It drives prompt budgets and the SDK compaction threshold; it must match what the provider serves. Each model stores its own window; this is the fallback when no model is active. |
| `agent.max_input_tokens` | `0` | 0 ≤ value < `context_window` | Hard cap on the input of one conversation request. `0` derives it from `context_window` minus `max_output_tokens` and a fixed framing overhead. The runtime reserves the system prompt and current request, then bounds history with the remainder. |
| `agent.history_token_budget` | `24000` | 0–`context_window` | Token budget for re-injecting earlier turns into a conversation request. Older history beyond it is trimmed, or summarized when `summary_enabled` is on. Trimming uses a conservative estimate (the larger of chars/4 and UTF-8 bytes/3), so CJK and dense code are not undercounted. |
| `agent.turn_tool_result_bytes` | `262144` | 0–67,108,864 | Cumulative tool-output bytes within one turn before the model is told to record what it has confirmed and continue with more targeted reads. It is a soft checkpoint, not a hard cap, and the runtime caps it at four tool-output rounds so the reminder arrives before compaction. `0` disables the reminder; tool output is still truncated per round. |
| `agent.compaction_reserve_tokens` | `0` | 0 ≤ value < `context_window` | Tokens held back from `context_window` so SDK compaction output still fits. `0` lets the runtime derive it from the tool-output budget, `max_output_tokens` and a fixed margin; an explicit value is raised to that safe floor and capped at 25% of the window so small contexts do not compact at 50%. |
| `agent.compaction_keep_recent_tokens` | `20000` | 0–`context_window` | Recent tokens the SDK keeps verbatim when it compacts. The runtime lowers it when it would not fit next to the reserve. |
| `agent.compaction_trigger_percent` | `85` | 50–95 | Share of the context window that triggers proactive compaction after a turn. The effective threshold also reserves the answer tokens. |
| `agent.compaction_dynamic_threshold` | `true` | Boolean | Adjust the trigger by each turn's token growth: lower it (compact sooner) when context grows fast, raise it (compact later) when growth is slow. Adjustments are bounded to 10% down / 5% up of the window and smoothed over the last four turns; disable it to keep the static percentage. |
| `agent.summary_enabled` | `true` | Boolean | Compress trimmed conversation history into a stored rolling summary that later turns reuse. |
| `agent.project_agents_md` | `true` | Boolean | Read `AGENTS.md` (or `AGENTS.override.md`) from the root of the pinned conversation worktree each turn and inject it as project guidance. It is treated as untrusted repository data and cannot override the system prompt or the current request. |
| `agent.project_agents_md_max_bytes` | `32768` | 1,024–262,144 | Maximum bytes of project guidance injected per turn; longer files are truncated. |

These context-budget keys are the primary defence against provider `context length exceeded` errors: Corvex trims history and caps tool output before a request leaves the process, and makes one more aggressive retry without history if the provider still reports an overflow. Tool results are hard-truncated per call and per assistant round before they enter session history, because the SDK can only estimate what was added since the last response; the compaction reserve is derived from that same bound. They can also be tuned at runtime from the agent console Settings page without editing the config file.

The daily budget conservatively reserves prompt bytes plus the configured maximum output tokens, then settles against provider usage. If a request result is uncertain, the reservation is retained. It is a token limit, not a price-based spending cap.

The branch snapshot captured per turn only guards against stale turns; unpublished local changes are based on a separate sync baseline that advances after a successful publish to the conversation's target branch, so publishing clears the Changes list and allows another commit/publish in the same turn without a rebase. Pi sessions do not expose built-in shell, edit, or write tools. Repository reads use bounded `read_file` and `git_grep`/`search_text` tools; mutations use the bounded `write_file`, `edit_file`, `delete_file`, `move_file` and `copy_file` tools, all confined to the conversation worktree. Worktree files are addressed with repository-relative paths; absolute paths are accepted only for trusted Skill roots. `web_fetch`, when enabled, can request HTTPS pages, JSON APIs, plain text and XML from public DNS hosts, revalidates redirects, rejects private/reserved IPs and configured blocked hosts, validates JSON before returning it pretty-printed, and treats all response content as untrusted model input. `web_download`, enabled with the same switch, writes HTTPS binary or large files (up to 16 MiB) into `.corvex/downloads/` inside the conversation worktree; it uses the same SSRF guards and DNS pinning, refuses executable/installer extensions, never overwrites repository files, and treats downloaded bytes as untrusted data. `web_search`, also enabled by default, calls Tavily's keyless endpoint with an `X-Tavily-Access-Mode: keyless` header and no key; it returns capped titles, URLs and snippets, filters result links through the same URL validation, turns a 429 into a readable notice, and is limited to a configurable number of calls per turn. Keyless access is rate-limited and query text leaves the server, so disable it in the ops console when that is not acceptable.

## Runtime settings

Tunable settings are edited in the console **Settings** page and stored in the SQLite `runtime_settings` table (with `updated_at` and `updated_by`); the config file only supplies their initial values. The console submits the complete editable set on save, so the database is the source of truth afterwards and there is no "restore to config file" action. The Server applies a change to subsequent turns immediately and records it in `audit_events` (`update_settings`, actor = console username). The Server reapplies stored settings at startup, so a restart never silently reverts the values shown in the console.

Settings → Model manages model providers: each provider stores a name, Base URL and API key, and lists its own models with a context window and max output tokens. Exactly one model is active globally: the first model added is activated automatically, and choosing another applies it to subsequent turns without a restart. Every assistant reply records the model that produced it. The active model overrides `agent.model`, `agent.base_url`, `agent.api_key`, `agent.context_window` and `agent.max_output_tokens`; those YAML values and environment variables are the fallback while the catalog is empty. The API key is never returned by the API or written to audit logs; leaving its password field empty keeps the saved value. Protect the SQLite file and its backups because they contain the key. Upgrading from an older version migrates stored `model` / `model_base_url` / `model_api_key` runtime overrides into a provider automatically, and splits the previous single-table model list into providers and models.

Each user also has a personal **Settings** page (`#/settings`) backed by `/api/ops/me/model-providers`. Shared system providers are read-only there and carry a **System** badge; a user can create and edit only their own providers and models. Activating a personal model writes that user's selection, never the global active model. Both the admin and user model managers offer connection tests that never echo the API key.

Editable keys (stored in SQLite with these underscored names; the YAML equivalents use dotted names):

| Key | Type / limits | Description |
|---|---|---|
| `response_language` | `en` \| `zh-CN` | Reply language. |
| `auto_context_tune` | Boolean | Lower the effective context window for the current session's overflow retry. |
| `max_input_tokens` | 0–10,000,000 | Hard input cap; `0` derives it from the context window. |
| `history_token_budget` | 0–10,000,000 | Token budget for earlier turns re-injected into a request. |
| `turn_tool_result_bytes` | 0–64 MiB | Soft checkpoint for cumulative tool output within a turn. |
| `compaction_reserve_tokens` | 0–10,000,000 | Tokens reserved for SDK compaction output. |
| `compaction_keep_recent_tokens` | 0–10,000,000 | Recent tokens kept verbatim through compaction. |
| `compaction_trigger_percent` | 50–95 | Window percentage that triggers proactive compaction after a turn. |
| `compaction_dynamic_threshold` | Boolean | Adapt the trigger to each turn's token growth. |
| `daily_token_budget` | 0–1,000,000,000 | UTC-day token budget; `0` disables it. |
| `summary_enabled` | Boolean | Rolling summary for trimmed history. |
| `project_agents_md` | Boolean | Load the pinned worktree's root `AGENTS.md` as project guidance. |
| `project_agents_md_max_bytes` | 1,024–262,144 | Byte budget for injected project guidance. |
| `web_enabled` | Boolean | Enable the read-only `web_fetch` tool. |
| `web_search_enabled` | Boolean | Enable `web_search` (Tavily keyless, no API key; queries are sent to Tavily). |
| `web_search_max_queries` | Number | Max `web_search` calls per turn (1–50). |
| `git_tool_call_limit` | 0–200 | Max Git tool calls per turn (failed calls count too); `0` disables the limit. |
| `auto_create_merge_request` | Boolean | Reuse or create an MR after the first publish to a feature branch. |
| `web_blocked_hosts` | List of hostnames | Additional exact hosts to block (and their subdomains). |
| `agent_request_timeout` | 1–3,600 seconds | Model request timeout; entered in seconds, stored in milliseconds. |
| `agent_session_timeout` | 1–86,400 seconds | Full session timeout; entered in seconds, stored in milliseconds. |
| `agent_response_stall_timeout` | 0–3,600 seconds | Abort a turn when the model produces no output (headers, text or tool calls) for this long; the console shows a waiting notice while idle. `0` disables the watchdog. Default `180`. |
| `skill_paths` | List of paths | Trusted Skill roots, read at the next session creation. |
| `gitlab_base_url` | HTTP(S) URL | GitLab instance root. |
| `gitlab_oauth_client_id` | String | OAuth client ID. |
| `gitlab_oauth_client_secret` | String | OAuth client secret; blank keeps the saved value. |
| `gitlab_oauth_redirect_uri` | HTTP(S) URL | OAuth callback URL. |
| `storage_retention_days` | 1–36,500 | Retention for terminal turns, trace and usage records. |
| `storage_audit_retention_days` | 1–36,500 | Retention for audit records. |
| `conversation_workspace_ttl_minutes` | 1–14,400 | Idle worktree TTL. |
| `conversation_workspace_max` | 1–200 | Cached worktree limit. |

There are no shared GitLab read/write token settings: every GitLab API and Git network operation uses the signed-in user's OAuth token. The model name, connection URL, API key, context window and output cap are managed in Settings → Model rather than as editable setting keys; older stored overrides (`model`, `model_base_url`, `model_api_key`, `context_window`, `max_output_tokens`) are read for upgrade compatibility but hidden from the console.

Only bootstrap settings remain file/environment-only: `server.listen`/`read_timeout`/`shutdown_timeout`, `storage.root`, `storage.database`, and the fallback model connection values. Each field shows its effective value when the runtime adjusted it: the runtime derives `max_input_tokens`, clamps the tool-result checkpoint to four tool-output rounds, and raises the compaction reserve to its safe floor, so an entered value may intentionally differ from what the process uses.

## All environment variables

| Variable | YAML setting or purpose |
|---|---|
| `CORVEX_LISTEN` | Overrides `server.listen` |
| `CORVEX_GITLAB_BASE_URL` | Overrides `gitlab.base_url` |
| `CORVEX_MODEL_BASE_URL` | Overrides `agent.base_url` |
| `CORVEX_MODEL_NAME` | Overrides `agent.model` |
| `CORVEX_DATABASE` | Overrides `storage.database` |
| `CORVEX_STORAGE_ROOT` | Overrides `storage.root` |

Compose also reads deployment-only variables such as `CORVEX_IMAGE_TAG`, `CORVEX_MEM_LIMIT`, `CORVEX_CPUS`, and `CORVEX_PIDS_LIMIT`; see [Runtime and operations](./operations).
