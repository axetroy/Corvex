# Runtime and operations

## Runtime requirements

- Use Node.js 26.12.1 and pnpm 12.4.1 to build or run from source. `pnpm install --frozen-lockfile` installs the locked dependencies.
- The Server needs outbound access to the configured GitLab API, outbound HTTPS access to the model API, and the `git` executable for conversation worktrees. No inbound webhook URL is required. The supplied Docker image installs Git.
- SQLite and Git data need persistent, writable storage. Avoid ephemeral container filesystems. Since Corvex uses SQLite WAL mode, use a local filesystem/volume with reliable SQLite locking rather than assuming arbitrary network filesystems are suitable.
- Keep system time synchronized. Daily model budget accounting uses UTC.

SQLite is embedded through Node's built-in `node:sqlite` module; the application does not require a native addon or separate SQLite service. Build the TypeScript application and start the single Server process (HTTP and inline conversation turns):

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- --config configs/config.yaml server
```

The default config path is `configs/config.yaml`; pass `--config /path/to/config.yaml` to use another file. `check-config` validates the file, `init` writes a template, and `backup` and `storage cleanup` are maintenance commands. There is no `events` command.

## Docker Compose

1. Copy `.env.example` to `.env` only for optional bootstrap values (listener, storage, GitLab base URL). Keep this file private and do not commit it. There are no shared GitLab tokens: OAuth credentials and model API keys are configured in the console, and every GitLab call uses the signed-in user's token.
2. Copy `configs/config.example.yaml` to `configs/config.yaml`. The template only contains the listener and storage paths; set the GitLab base URL, tokens, model providers and OAuth application in the console. The console searches every project visible to the signed-in user's GitLab token.
3. Start the Server:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml pull corvex
   docker compose --env-file .env -f deploy/compose.yaml up -d
   ```

4. Open `/ops`, complete the first-run `/setup` page with the GitLab OAuth application details, sign in, and add a model provider and model under **Settings → Model**. The first model added is activated automatically; later selections apply to subsequent turns without recreating the container.

The single service mounts the named `corvex-data` volume at `/data/corvex`; Compose points both the database and Git root into that volume, and the service publishes port 8080. The sample Compose setup uses a read-only container root filesystem, a temporary `/tmp`, drops Linux capabilities, and enables `no-new-privileges`.

The Compose file uses the `ghcr.io/axetroy/corvex` image by default. To build from a local checkout instead, add `--build` to `docker compose up`. GHCR package visibility controls anonymous pulls; make the package public after its first publish if deployments should not require `docker login`.

Compose resource defaults are 1 CPU/1 GiB and 256 PIDs for the Server. Override them with `CORVEX_MEM_LIMIT`, `CORVEX_CPUS`, and `CORVEX_PIDS_LIMIT`. JSON logs rotate at 10 MiB with three files retained.

Expose the console through HTTPS and keep the GitLab API, database volume, and metrics endpoint restricted to trusted networks. The compose port mapping is plain HTTP; terminate TLS at a trusted reverse proxy or load balancer. On a fresh installation `/ops` redirects to `/setup`; after setup, the OAuth callback URL must point back to the console.

## HTTP endpoints

| Method and path | Purpose |
|---|---|
| `GET /healthz` | Process liveness check; returns `200 ok`. |
| `GET /readyz` | Readiness check that pings SQLite; returns `503` if the database is unavailable. |
| `GET /metrics` | Prometheus text metrics for model calls, duration and token totals (`corvex_model_calls_total`, `corvex_model_call_duration_seconds_sum`, `corvex_model_input_tokens_total`, `corvex_model_output_tokens_total`). |
| `GET /auth/gitlab` | Start GitLab OAuth2 login. Returns `503` when OAuth is not configured. |
| `GET /auth/gitlab/callback` | OAuth callback; sets the session cookie and redirects to `/ops#/conversations`. |
| `POST /auth/logout` | Clear the session. |
| `GET /api/auth/status` | Public 200-only status probe used by the console route guard (`authenticated`, `oauthConfigured`, `setupRequired`). |
| `GET /api/auth/me` | Current signed-in user. Returns 401 JSON with `setupRequired` when OAuth is not configured, so the console redirects to `/setup` rather than the unavailable login page. |
| `GET /api/setup/status` | Whether OAuth has been configured. |
| `POST /api/setup/oauth` | First-run setup: GitLab URL and OAuth client ID, secret and callback URL. |
| `GET /ops` | Agent console; requires GitLab OAuth2 login. |
| `GET /api/ops/overview` | Console summary with conversation turn counts, oldest queued age and model call metrics. |
| `GET /api/ops/projects` / `GET /api/ops/projects/<id>` | Search projects visible to the signed-in user / read repository metadata for the panel opened from the project name. |
| `GET /api/ops/projects/<id>/branches` | Search the branches of a project. |
| `GET /api/ops/conversations` / `GET /api/ops/conversations/<id>` | List persistent conversations (turn counts and latest turn status) and their messages; the detail response also carries the derived system prompt. |
| `POST /api/ops/conversations` / `POST /api/ops/conversations/<id>/messages` | Create a pinned conversation or enqueue its next turn. |
| `POST /api/ops/conversations/<id>/archive` | Archive or unarchive a conversation with `{ "archived": true|false }`; the list endpoint accepts `archived=true|false`. |
| `DELETE /api/ops/conversations/<id>` | Delete a conversation and its turns, messages and process records; rejected while a turn is running. |
| `GET /api/ops/conversations/<id>/turns` | Read all turns: trajectory and execution records merged into one ordered timeline. |
| `GET /api/ops/conversations/<id>/turns/<turnId>` | Read one turn's trajectory, execution records and lifecycle transitions; the turn must belong to that conversation. |
| `GET /api/ops/conversations/<id>/turns/<turnId>/stream` | SSE stream of the running turn's assistant text (`text`), thinking (`thinking`), tool executions (`tool`) and context notices (`context`), ending with `done`. |
| `POST /api/ops/conversations/<id>/turns/<turnId>/cancel` | Request cancellation of a queued or running turn. |
| `GET /api/ops/conversations/<id>/stats` | Aggregate usage and timing for the whole conversation, plus a per-turn breakdown. |
| `GET /api/ops/conversations/<id>/context` / `.../context/<seq>` | Per-request context snapshot summary (no item previews) or the full bounded items for one request. |
| `GET /api/ops/conversations/<id>/git/graph`, `/git/authors`, `/git/commit/:sha`, `/git/commit/:sha/patch` | Read-only commit graph, author filter, commit details and a downloadable patch from the project mirror. |
| `GET /api/ops/conversations/<id>/files/tree`, `/files/content`, `/files/image` | Browse the pinned worktree (with a GitLab fallback) and preview images. |
| `GET` / `DELETE /api/ops/conversations/<id>/changes` | Inspect or remove the conversation's saved changes ref and worktree. |
| `GET /api/ops/storage/cleanups` | Recent Git storage cleanup records from the CLI, daily retention and the console. |
| `POST /api/ops/storage/cleanup` | Preview (`apply: false`) or run (`apply: true`) cleanup; queued and running turns are protected. |
| `GET` / `POST /api/ops/model-providers` | List providers with their models, or add a provider; API keys are never returned. |
| `PUT` / `DELETE /api/ops/model-providers/<id>` | Edit or remove a provider and its models; an empty `apiKey` keeps the saved value. |
| `POST /api/ops/model-providers/<id>/models`, `PUT` / `DELETE /api/ops/model-providers/<id>/models/<modelId>` | Add, edit or remove a model. |
| `POST /api/ops/model-providers/<id>/models/<modelId>/activate` | Select the active global model; the first model added is active by default. |
| `POST /api/ops/model-providers/test`, `POST /api/ops/model-providers/<id>/models/test` | Connection tests; results never echo the API key. |
| `GET` / `PUT /api/ops/settings` | Read the effective runtime settings, or replace them. `PUT` stores the submitted set in SQLite (the source of truth after the first save). |
| `GET` / `POST /api/ops/me/model-providers` and the `/api/ops/me/...` variants | Per-user providers, models and activation; system providers are read-only there. |
| `GET /api/ops/admin/users`, `PUT /api/ops/admin/users/<id>` | Administrator-only user list and admin-flag updates. |
| `GET /api/ops/skills` | Enabled conversation skills (SKILL.md documents following [agentskills.io/specification](https://agentskills.io/specification)) for every signed-in user. |
| `GET` / `POST /api/ops/admin/skills`, `PUT` / `DELETE /api/ops/admin/skills/<id>` | Administrator CRUD for conversation skills; the seven seeded system skills can be edited or disabled but not deleted. |

The console endpoints require a GitLab OAuth2 session; settings, model providers and storage maintenance are administrator-only. API calls return `401` JSON when unauthenticated, never a redirect, and the console turns that into a client-side redirect to login or setup. Protect operator sessions and use HTTPS. Do not expose `/metrics` publicly unless your monitoring setup requires it; restrict it at the network or proxy layer. Webhook and event endpoints are deferred; see [ROADMAP.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.md).

The console is conversation-first: it opens on **Conversations**, which lists conversations grouped by repository with turn counts and the latest turn status. The shell fills the viewport with a collapsible sidebar, a resizable workspace and a toggled file panel, and no footer. The admin console at `#/admin` hosts the system overview and user list; each user also has a personal **Settings** page at `#/settings`. The Settings page is split into Basics / Model / GitLab / Storage / Advanced tabs and edits the model, response language, context budgets (including the context-inspection switch and snapshot caps), GitLab connection, tool switches and retention at runtime. Secrets are redacted in API responses and left blank to keep the saved value, and connection changes reconfigure the GitLab clients immediately.

Conversations can be archived, unarchived and deleted from the sidebar; deletion removes the worktree and is rejected while a turn is running. Each turn is pinned to the server-resolved branch head SHA, persisted in SQLite, and runs with the bounded repository and GitLab tools described in [Architecture](./architecture). The interface supports English and Simplified Chinese, with theme and language preferences that follow the system by default.

## Logs and troubleshooting

Corvex writes structured JSON logs to stdout. In Compose, inspect logs with:

```sh
docker compose --env-file .env -f deploy/compose.yaml logs -f corvex
```

The Server logs OAuth sign-ins, conversation creation, turn start and completion, status transitions, model calls, storage cleanup and the HTTP response status. These logs do not include API keys or user tokens.

| Symptom | Checks |
|---|---|
| `/ops` redirects to `/setup` | Complete the first-run OAuth setup: GitLab URL, client ID, client secret and callback URL. All three OAuth fields are required together. |
| Login fails at the callback | Confirm the redirect URI registered in GitLab exactly matches the callback URL saved in Settings, and that the OAuth application has the required scopes. |
| A user sees no projects | Project search uses that user's GitLab token; check the token's scopes and project visibility. |
| A turn fails immediately | Confirm a model provider and model are configured and activated, and that the API key and Base URL are valid. |
| A turn becomes `stale` | The branch moved or the pinned snapshot changed; send the message again to use the current revision. |
| The Server cannot clone a project | Check GitLab network access, the signed-in user's token permissions, project visibility, and that the Server host has Git installed. |
| `readyz` returns `503` | Check the database path, persistent volume mount, and filesystem permissions. |

## Git storage cleanup

Preview old workspaces and project mirrors before removing them:

```sh
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1
pnpm start -- storage cleanup --config configs/config.yaml --older-than-days 1 --apply
```

Cleanup is dry-run by default, excludes active workspaces, conversations with queued or running turns, and projects referenced by conversations, and removes only directories older than the selected age. Stop the Server before applying a cleanup to avoid races with a newly queued turn. For Compose, run the command in the Server container:

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

For a container deployment, run the backup command in an environment that can access the mounted database and has the Corvex executable. Protect backups with the same encryption and access controls as the live database; they contain provider API keys and encrypted user tokens.

To restore, stop the Server, preserve the current database for rollback, replace it with a verified backup at the configured database path, and restart the Server. Do not overwrite a live database.

The Server runs retention cleanup at startup and then approximately every 24 hours. Terminal conversation turns, their trace and execution records, cleanup logs and daily token usage use `storage.retention_days` (90 days by default). Audit events use `storage.audit_retention_days` (365 days by default). Queued and running turns are retained. Conversations idle for longer than the retention window are deleted with their messages and turns; a conversation with a queued or running turn is kept so an active conversation is never dropped. Deleting a conversation also removes its Git worktree and saved-changes ref, and startup prunes orphan refs and garbage-collects unreachable mirror objects.

Trajectory data is redacted and size-capped in `src/store.ts`, but it intentionally retains model prompts, tool arguments and results, and model outputs so the console can render the complete session; it may contain repository source, diffs, webpage content or other sensitive text. Protect the database, backups and agent console accordingly, use HTTPS, and restrict operator access. Git mirrors under `storage.root` are not covered by this database cleanup; monitor disk use and define a separate mirror maintenance policy.

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
