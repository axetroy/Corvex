# Runtime and operations

## Runtime requirements

- Use Node.js 26.12.1 and pnpm 12.4.1 to build or run from source. `pnpm install --frozen-lockfile` installs the locked dependencies.
- The Server needs outbound access to the configured GitLab API and inbound access from GitLab to its webhook URL.
- The Server needs the `git` executable for inline event execution, outbound GitLab access for API and repository fetches, and outbound HTTPS access to the configured model API when the agent is enabled. The supplied Docker image installs Git.
- SQLite and Git data need persistent, writable storage. Avoid ephemeral container filesystems. Since Corvex uses SQLite WAL mode, use a local filesystem/volume with reliable SQLite locking rather than assuming arbitrary network filesystems are suitable.
- Keep system time synchronized. Daily model budget accounting uses UTC.

SQLite is embedded through Node's built-in `node:sqlite` module; the application does not require a native addon or separate SQLite service. Build the TypeScript application and start the single Server process (HTTP, inline events and inline conversations):

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- --config configs/config.yaml server
```

The default config path is `configs/config.yaml`; pass `--config /path/to/config.yaml` to use another file.

## Docker Compose

1. Copy `.env.example` to `.env` and set the GitLab write token and webhook secret. The read token is required; the model API key is needed when the agent is enabled. Keep this file private and do not commit it.
2. Copy `configs/config.example.yaml` to `configs/config.yaml` and set the GitLab URL. Add user IDs to `gitlab.blocked_user_ids` only to deny command access. The agent console searches every project visible to `CORVEX_GITLAB_READ_TOKEN`.
3. Start the Server:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml pull corvex
   docker compose --env-file .env -f deploy/compose.yaml up -d
   ```

4. To process model tasks, configure the model in the console Settings page and set `CORVEX_MODEL_API_KEY` in `.env` when needed, then recreate the Server container:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml up -d --force-recreate corvex
   ```

The single service mounts the named `corvex-data` volume at `/data/corvex`; Compose points both the database and Git root into that volume, and the service publishes port 8080. The sample Compose setup uses a read-only container root filesystem, a temporary `/tmp`, drops Linux capabilities, and enables `no-new-privileges`.

The Compose file uses the `ghcr.io/axetroy/corvex` image by default. To build from a local checkout instead, add `--build` to `docker compose up`.
GHCR package visibility controls anonymous pulls; make the package public after its first publish if deployments should not require `docker login`.

Compose resource defaults are 1 CPU/1 GiB and 256 PIDs for the Server. Override them with `CORVEX_MEM_LIMIT`, `CORVEX_CPUS`, and `CORVEX_PIDS_LIMIT`. JSON logs rotate at 10 MiB with three files retained.

Expose the webhook through HTTPS and keep the GitLab API, database volume, and metrics endpoint restricted to trusted networks. The compose port mapping is plain HTTP; terminate TLS at a trusted reverse proxy or load balancer.
The read-only agent console is disabled unless both `CORVEX_OPS_USERNAME` and `CORVEX_OPS_PASSWORD` are set. When enabled, open `https://<corvex-host>/ops`; the same credentials protect its API. Use a strong, unique password, and do not expose the console over plain HTTP or directly to an untrusted network.

## HTTP endpoints

| Method and path | Purpose |
|---|---|
| `POST /webhooks/gitlab` | GitLab merge-request and Issue Note Hook endpoint. Requires the matching `X-Gitlab-Token`; only Note Hook events are supported. |
| `GET /healthz` | Process liveness check; returns `200 ok`. |
| `GET /readyz` | Readiness check that pings SQLite; returns `503` if the database is unavailable. |
| `GET /metrics` | Prometheus text metrics for event counts and model call counts, duration, and token totals. |
| `GET /ops` | Optional Basic Auth-protected read-only agent console. Disabled when operations credentials are unset. |
| `GET /api/ops/overview` | Agent console summary with event counts, oldest queued age, the inline runner heartbeat, and model call metrics. |
| `GET /api/ops/events` | Filtered and paginated event list (`status`, `type`, `projectId`, `mrIid`, `search`, `limit`, `offset`). |
| `GET /api/ops/events/<id>` | Event details, persisted attempt history, lifecycle transitions, agent trajectory, and input/output records for each execution step. |
| `GET /api/ops/projects` | Search projects visible to the configured GitLab read token. |
| `GET /api/ops/projects/<id>` | Read repository metadata for the panel opened from the project name above the conversation. |
| `GET /api/ops/projects/<id>/branches` | Search the branches of a project. |
| `GET /api/ops/conversations` / `GET /api/ops/conversations/<id>` | List persistent conversations (with turn counts and the latest turn status) and their messages; the detail response also carries the conversation's derived system prompt. |
| `GET /api/ops/conversations/<id>/turns` | Read the whole conversation: every turn's trajectory and execution records merged into one ordered timeline, plus the per-turn boundaries. Conversation turns are not events and never appear in the events list. |
| `GET /api/ops/conversations/<id>/turns/<turnId>` | Read one turn's own trajectory, execution records, attempts, and lifecycle transitions. Conversation turns are not events and never appear in the events list. |
| `GET /api/ops/conversations/<id>/turns/<turnId>/stream` | Server-sent events with the running turn's cumulative assistant text (`text`), thinking (`thinking`), tool executions (`tool`), context compaction/trimming notices (`context`) with bounded before/after context snapshots in the Trace inspector, and a final `done` status, so the console can render the reply and its interleaved timeline before it is persisted. |
| `GET /api/ops/conversations/<id>/stats` | Aggregate usage and timing for the whole conversation, plus a per-turn breakdown. |
| `POST /api/ops/conversations` / `POST /api/ops/conversations/<id>/messages` | Create a pinned read-only conversation or enqueue its next turn. |
| `POST /api/ops/conversations/<id>/archive` | Archive or unarchive a conversation with `{ "archived": true|false }`; the list endpoint accepts `archived=true|false`. |
| `DELETE /api/ops/conversations/<id>` | Delete a conversation with its turns, messages and process records; rejected while a turn is running. |
| `GET /api/ops/storage/cleanups` | Recent Git storage cleanup records from the CLI, daily retention and the console. |
| `POST /api/ops/storage/cleanup` | Preview (`apply: false`) or run (`apply: true`) cleanup of workspaces older than `olderThanDays`; running and queued turns are protected. |
| `GET /api/ops/model-providers` / `POST /api/ops/model-providers` | List providers with their models, or add a provider; API keys are never returned. |
| `PUT /api/ops/model-providers/<id>` / `DELETE /api/ops/model-providers/<id>` | Edit or remove a provider and its models; an empty `apiKey` keeps the saved value. |
| `POST /api/ops/model-providers/<id>/models` | Add a model under a provider. |
| `PUT`/`DELETE /api/ops/model-providers/<id>/models/<modelId>` | Edit or remove one model. |
| `POST /api/ops/model-providers/<id>/models/<modelId>/activate` | Select the active model; the first model added is active by default. |
| `GET /api/ops/settings` / `PUT /api/ops/settings` | Read the effective runtime settings, or replace them. `PUT` stores the submitted settings in SQLite (the source of truth after the first save) and returns the new effective values; it works with or without `--config`. |

The agent console endpoints require HTTP Basic Auth and return `404` when disabled. Job details include the requester username and ID, the triggering comment, the parsed request, and error text; protect operator credentials and use HTTPS. The triggering comment is sourced from the linked webhook execution event and follows its size limit and best-effort redaction. Do not expose `/metrics` publicly unless your monitoring setup requires it; restrict it at the network or proxy layer.

The console is conversation-first: it opens on **Conversations**, which lists conversations with their turn counts, mode tag, and latest turn status. The shell itself fills the viewport: a collapsible left sidebar holds the brand, navigation, and language picker (collapsed state persists in `localStorage`), the main area takes the remaining width, and there is no footer, so the conversation workspace occupies the full screen. Overview, events, event detail, and a **Settings** page remain available; Settings edits the model, response language, context budgets (`auto_context_tune` lowers an oversized model context window after a provider overflow, recording an audit entry), GitLab connection (base URL, read/write tokens, webhook secret, bot name, blocked user IDs), tool switches, review limits, and repair/implementation permissions at runtime; secrets are redacted in API responses and left blank to keep the saved value, and connection changes reconfigure the GitLab clients immediately, writing only the overridden keys to SQLite with the operator and timestamp, and is read-only when the Server runs without `--config`. Starting a conversation uses a searchable repository picker that shows each project's full path and description, plus a searchable branch picker whose options show each branch's latest commit (short SHA, title, and relative time), and both can scroll through every project and branch visible to the GitLab read token; the welcome page offers quick prompts grouped by intent (understand, locate, improve, onboard), and clicking one fills the composer with the full question; each turn is pinned to the server-resolved branch head SHA, persisted in SQLite, and runs with tools derived from the conversation's mode (shown as a tag in the sidebar and repository header): `read_only` only inspects the repository, while `gitlab` adds project/issue/MR read tools and explicit-user-request writes such as posting notes, updating titles/descriptions and closing issues or MRs. The page fills the viewport: a sidebar lists conversations, and the workspace puts the repository info (project, branch, mode tag, and the pinned revision) on the same row as four tabs — **Chat** for the Markdown transcript whose settled replies show, in order, Copy, generation TPS, elapsed time, and the producing provider/model label from the settings catalog, plus each assistant reply's tool calls (readable description, result, and duration) and a lightweight step checklist recorded by the model via `record_plan`, plus the conversation's system prompt as a collapsible block above the transcript, **Call records** for every turn's execution steps, **Trace** to inspect every turn merged into one trajectory by default, or a single turn, with that scope's own trajectory, execution records, and lifecycle transitions (its timeline overview splits into one band per turn with its own ruler and a fixed pixel gap between turns, and supports free zoom with the scroll wheel — anchor-preserving, `Shift`+scroll to pan, drag to select a time range — plus zoom buttons and a reset), and **Stats** for usage and timing totals with a per-turn breakdown. The floating composer starts at three rows and grows with the input, and its footer holds a model switcher; choosing a model there makes it the global active model for the next turn without leaving the conversation. It does not modify repositories or publish replies to GitLab. The console refreshes queue views automatically; active conversation turns poll more frequently. Use a strong GitLab read token and strong Basic Auth credentials. It is a React bundle built into `dist/app/ui`; use `pnpm run ui:build` to build it locally, or `pnpm run ui:dev` for interface work against a local Server. The `ui:dev` server proxies `/api` to `http://127.0.0.1:8080`; set `CORVEX_OPS_API` to use another Server origin. Event list filters (`status`, `type`, `search`) are kept in the URL. `/ops` only answers `GET` and `HEAD`, and its responses carry a restrictive Content Security Policy and `X-Robots-Tag: noindex` so the console is not indexed or embedded.
The interface supports English and Simplified Chinese. On first visit it selects the best supported browser language; a manual selection is saved in browser storage for later visits.

## Logs and troubleshooting

Corvex writes structured JSON logs to stdout. In Compose, inspect logs with:

```sh
docker compose --env-file .env -f deploy/compose.yaml logs -f corvex
```

The Server logs webhook receipt, validation/rejection, ignored comments, recognized commands, task enqueue or deduplication, GitLab response publication, and the HTTP response status. The inline event runner logs claimed events and each status transition. These logs include event IDs and project/MR IDs, but not comment bodies or webhook credentials.

| Symptom | Checks |
|---|---|
| Webhook returns `401` | Confirm the GitLab hook secret exactly matches `CORVEX_WEBHOOK_SECRET`. |
| Webhook returns `400` | The endpoint only accepts valid merge-request or Issue Note Hook payloads. Disable unsupported event types and ensure the request is a comment on a merge request or Issue. |
| Webhook returns `403` | Check whether the commenter is in `gitlab.blocked_user_ids`, or whether the requested capability is disabled. |
| Tasks stay queued | Confirm the model settings in the console are valid. |
| The Server cannot clone a project | Check GitLab network access, read token permissions, project visibility, and that the Server host has Git installed. |
| Task becomes stale | The MR was closed or its diff changed after the command was queued; submit a new command on the current revision. |
| `readyz` returns `503` | Check the database path, persistent volume mount, and filesystem permissions. |

## Event administration

List recent events or filter failures using the same SQLite database as the Server:

```sh
pnpm start -- events list --database ./data/state/corvex.db --status failed
pnpm start -- events list --database ./data/state/corvex.db --limit 100
```

An operator can requeue a failed event only when it failed before publishing and has automatic attempts remaining:

```sh
pnpm start -- events retry <event-id> --database ./data/state/corvex.db
```

Publishing failures cannot be retried because GitLab may already have accepted the comment. The CLI writes an operator retry audit event; run it on a host with access to the persistent database.

If an event fails while publishing, treat the result as potentially partial. Open the event in the agent console and inspect its execution records for successful `gitlab.post_discussion`, `gitlab.post_review_summary`, or `gitlab.post_fix_proposal` steps; then compare them with the MR before taking action. Do not retry the failed event: publishing may have succeeded remotely even when Corvex did not receive the response, and retrying could duplicate comments. Corvex does not currently resume or reconcile individual publication steps. If work must be repeated, first determine which comments are already present and account for possible duplicates.

Webhook command replies use a short database delivery lease to prevent concurrent redeliveries from posting the same response at once. This is not an exactly-once guarantee: if GitLab accepts a note but its response is lost, a later retry after the lease expires may post a duplicate. Inspect the event's `gitlab.post_note` and `webhook.mark_delivered` steps before investigating repeated command replies.

## Git storage cleanup

Preview old workspaces and project mirrors before removing them:

```sh
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1 --apply
```

Cleanup is dry-run by default, excludes active workspaces, conversations with queued or running turns, and projects with queued or active tasks, and removes only directories older than the selected age. Stop the Server before applying a cleanup to avoid races with a newly claimed task. For Compose, run the command in the Server container:

```sh
docker compose --env-file .env -f deploy/compose.yaml exec corvex \
  node /app/dist/cli.js storage cleanup --config /etc/corvex/config.yaml --apply
```

## Backup, restore, and retention

Create an online SQLite backup while the service is running. The destination must not already exist:

```sh
pnpm start -- backup \
  --database ./data/state/corvex.db \
  --output ./data/backups/corvex-$(date +%Y%m%d%H%M%S).db
```

For a container deployment, run the backup command in an environment that can access the mounted database and has the Corvex executable. Protect backups with the same encryption and access controls as the live database.

To restore, stop the Server, preserve the current database for rollback, replace it with a verified backup at the configured database path, and restart the Server. Do not overwrite a live database.

The Server runs cleanup at startup and then approximately every 24 hours. Terminal events, attempts, linked execution steps, agent trajectory entries, webhook delivery records, and daily token usage use `storage.retention_days` (90 days by default). Unlinked execution steps use the same retention. Audit events use `storage.audit_retention_days` (365 days by default). Queued and active events are retained. Operations-console conversations that have been idle for longer than the retention window are deleted with their messages; a conversation that still has a queued or running reply is kept so an active conversation is never dropped. Execution-event inputs and outputs are bounded and credential-like values are redacted on a best-effort basis. Agent trajectories intentionally retain model prompts and context, tool arguments and results, and model outputs so the agent console can render the complete session; context entries are stored incrementally between model turns and reconstructed when an individual turn is inspected. Trajectories may contain repository source, diffs, webpage content, comments, or secrets, and are not covered by the execution-event redaction and size limits. Protect the database, backups, and agent console accordingly, use HTTPS, and restrict operator access. Git mirrors under `storage.root` are not covered by this database cleanup; monitor disk use and define a separate mirror maintenance policy.

## Upgrades and development

Back up the database before upgrading. The application applies SQLite schema migrations at startup; deploy the same application version to the Server and keep its data volume. Test the upgrade and restore procedure against a backup before relying on it in production.

From a source checkout, the usual checks are:

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm test
pnpm run build
```

The repository CI runs these checks on Node.js 26.12.1. Git must be installed on the Server host.
