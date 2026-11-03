# Corvex

Corvex is a self-hosted GitLab code review and repair agent built as a single TypeScript application powered by the Pi SDK. See [design.md](design.md) for the architecture and the [documentation](https://axetroy.github.io/Corvex/).

## Current implementation

The implementation currently provides:

- A GitLab Note Hook endpoint with constant-time webhook-token validation.
- Project allowlists, optional user blocklists, system-note filtering, and configurable bot mentions with slash-prefixed commands.
- SQLite persistence with durable event deduplication, queued review/fix tasks, and fix authorization auditing.
- `review`, `explain <path>` for a file at the MR's pinned Head SHA, allowlisted `fix`, `status`, and owner-only `cancel` commands; cancellation is available until a task enters publishing.
- GitLab MR note replies, `/healthz`, database-backed `/readyz`, and a Prometheus `/metrics` endpoint exposing job statuses plus model call successes/failures, duration, and token totals.
- An optional, Basic Auth-protected read-only operations console with queue overview, worker heartbeats, filterable jobs, and attempt details. It is disabled unless operator credentials are configured.
- YAML configuration with secrets supplied only through environment variables.
- GitLab MR/project metadata and paginated diff API methods.
- A Git engine for project mirrors, isolated detached worktrees at an exact SHA, bounded local diffs, and workspace-contained file reads.
- Pi SDK agent sessions using an OpenAI-compatible provider, with bounded context, a 64 KiB read-only file tool restricted to the pinned worktree and trusted skill paths, strict structured output, added-line/evidence validation, severity checks, and duplicate filtering.
- CLI configuration initialization/validation, job listing and safe pre-publish retry, dry-run-first Git storage cleanup, and a live review benchmark reporting precision, recall, and F1.

The `server` persists tasks and the optional `worker` processes them asynchronously. Any commenter in an allowed project can invoke commands unless their numeric user ID is in `gitlab.blocked_user_ids`. The worker verifies MR snapshots before review and publishing, uses isolated worktrees, and posts validated findings as line-level discussions. Fix proposals are off by default and are posted for manual application. Ordinary Issue mentions let the agent answer, ask for clarification, or propose implementation using recent Issue comments (20 by default, configurable from 0 to 50). Code writes are separately disabled by default: enable `issue.implement_enabled` to allow implementation and Draft MRs. The project default branch is used unless the current request explicitly names another existing branch. The worker does not run repository scripts or tests, force-push, auto-merge, or close the Issue. SQLite records task, authorization, cancellation, and lifecycle events. The curated benchmark uses synthetic labeled examples; run it explicitly because it makes model API calls.

Workers use a 30-second renewable job lease. After a worker interruption, tasks that have not entered publishing are retried up to three attempts. An expired publishing lease fails without automatic retry because the comment outcome may be uncertain, avoiding duplicate GitLab comments.

To enable Issue implementation, set `issue.implement_enabled: true` and grant `CORVEX_GITLAB_TOKEN` permission to push branches and create merge requests. Review the Draft MR before merging. See the [Issue assistance guide](./docs/guide.md#issue-assistance-and-implementation) and configuration reference for safety limits.

## Run locally

Requires Node.js 26.12.1 and pnpm 12.4.1. SQLite is provided by Node's built-in `node:sqlite` module.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

Edit `configs/config.yaml` with the GitLab URL and project allowlist. Optionally add user IDs to `gitlab.blocked_user_ids`. Set `CORVEX_GITLAB_TOKEN` to a token permitted to post MR notes and `CORVEX_WEBHOOK_SECRET` to the same secret configured on the project webhook. Check the server configuration before starting:

```sh
pnpm start -- --config configs/config.yaml check-config
pnpm start -- --config configs/config.yaml server
```

The optional operations console is available at `/ops` only after setting both `CORVEX_OPS_USERNAME` and `CORVEX_OPS_PASSWORD`. Use a strong, unique password and access it over HTTPS.

For asynchronous reviews or fix proposals, enable the agent configuration, set `CORVEX_GITLAB_READ_TOKEN` to a separate read-only token and provide `CORVEX_MODEL_API_KEY`. Validate and start the worker in a second process:

```sh
pnpm start -- --config configs/config.yaml --for worker check-config
pnpm start -- --config configs/config.yaml worker
```

The configured project IDs and user IDs are explicit allowlists. Both must be non-empty; an empty list never means unrestricted access.

An online SQLite backup can be created while the service is running. The destination must not already exist:

```sh
pnpm start -- backup \
  --database ./data/state/corvex.db \
  --output ./data/backups/corvex-$(date +%Y%m%d%H%M%S).db
```

To restore, stop both the server and worker, replace the configured database file with a verified backup, then restart the services. Apply your organization's encryption, access-control, and off-site retention policies to backup files.

The server prunes terminal jobs, job attempts, webhook events, and daily token usage older than `storage.retention_days` (90 days by default), and audit events older than `storage.audit_retention_days` (365 days by default). Queued and in-progress jobs are retained. Adjust these periods to match your organization's retention requirements. Use `pnpm start -- storage cleanup --config configs/config.yaml` to preview unused Git storage cleanup; applying it requires a maintenance window with Workers stopped.

## Docker Compose

Copy `.env.example` to `.env`, set the GitLab write token and webhook secret, and provide `configs/config.yaml`. Add the GitLab read token and model API key when enabling a worker. Then run:

```sh
docker compose --env-file .env -f deploy/compose.yaml pull corvex
docker compose --env-file .env -f deploy/compose.yaml up -d
```

This uses the prebuilt `ghcr.io/axetroy/corvex` image. To also run the worker, enable `agent.enabled: true` in `configs/config.yaml`, provide the model API key in `.env`, and use the `worker` profile:

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile worker pull
docker compose --env-file .env -f deploy/compose.yaml --profile worker up -d
```

For a local source build, use `docker compose --env-file .env -f deploy/compose.yaml up --build -d`. The server and worker share the SQLite/Git data volume; only the server exposes port 8080. The server receives only its write token and webhook secret; the worker receives GitLab read/write and model credentials. Register a project hook with the optional idempotent helper (requires `curl` and `jq`):

```sh
GITLAB_URL=https://gitlab.example.com \
GITLAB_ADMIN_TOKEN=... \
GITLAB_PROJECT_ID=101 \
CORVEX_WEBHOOK_URL=https://corvex.example.com/webhooks/gitlab \
CORVEX_WEBHOOK_SECRET=... \
./scripts/register-webhook.sh
```

The registration token is used only by the one-time script and must not be given to the running Corvex service.

Compose defaults to 1 CPU/1 GiB for the server and 2 CPU/2 GiB for the worker, with a 256 PID limit for each. JSON file logs are capped at 10 MiB per file with three files retained. Override these using `CORVEX_MEM_LIMIT`, `CORVEX_CPUS`, `CORVEX_PIDS_LIMIT`, and the corresponding `CORVEX_WORKER_*` variables.

## Development

```sh
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
```

Run the labeled review benchmark explicitly (it calls the configured model three times):

```sh
pnpm run benchmark:review -- --config configs/config.yaml --min-f1 0.6
```

The worker uses a GitLab read token for API/repository reads and the write token for note publication; the server only needs the write token. No untrusted-code executor is included.

## CI and releases

GitHub Actions runs lint, type checking, tests, and a production build on Node.js 26.12.1. Pushes to `main`, pull requests, and version tags run CI.

To publish a GitHub Release and a multi-architecture GHCR image, push a version tag such as `v1.0.0`. The release workflow verifies the code, publishes `ghcr.io/axetroy/corvex:<version>` and `:latest`, then creates the source release.
