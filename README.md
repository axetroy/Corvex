# Corvex

Corvex is a self-hosted GitLab code review and repair agent. This repository is implementing the MVP in phases described in [design.md](design.md). Read the [documentation](https://axetroy.github.io/Corvex/).

## Current implementation

The implementation currently provides:

- A GitLab Note Hook endpoint with constant-time webhook-token validation.
- Project and user allowlists, bot/system-note filtering, and strict `@corvex` command parsing.
- SQLite persistence with durable event deduplication, queued review/fix tasks, and fix authorization auditing.
- `review`, `explain <path>` for a file at the MR's pinned Head SHA, allowlisted `fix`, `status`, and owner-only `cancel` commands; cancellation is available until a task enters publishing.
- GitLab MR note replies, `/healthz`, database-backed `/readyz`, and a Prometheus `/metrics` endpoint exposing job statuses plus model call successes/failures, duration, and token totals.
- YAML configuration with secrets supplied only through environment variables.
- GitLab MR/project metadata and paginated diff API methods.
- A Git engine for project mirrors, isolated detached worktrees at an exact SHA, bounded local diffs, and workspace-contained file reads.
- An OpenAI-compatible chat client and review workflow with bounded context, strict structured output, added-line/evidence validation, severity checks, and duplicate filtering.

The `server` persists review tasks and the optional `worker` processes them asynchronously. The worker verifies the MR diff snapshot before review and again before publishing, uses an isolated worktree, posts validated findings as line-level discussions, and falls back to a summary note when GitLab rejects a discussion position. Fix proposals are off by default and have a dedicated user allowlist. When enabled, the worker asks the model for a bounded unified diff, applies it only to an isolated worktree and only to files changed in the MR, runs the built-in `git apply --check` and `git diff --check` validations, then posts the patch for manual application. It does not run repository scripts, commit, or push. SQLite records review/explain/fix requests, authorization and cancellation outcomes, and job status transitions; a curated review-quality benchmark dataset is not yet included.

Workers use a 30-second renewable job lease. After a worker interruption, tasks that have not entered publishing are retried up to three attempts. An expired publishing lease fails without automatic retry because the comment outcome may be uncertain, avoiding duplicate GitLab comments.

To enable reviews, set `agent.enabled: true`, configure `agent.base_url` and `agent.model`, and provide `CORVEX_MODEL_API_KEY`. `agent.max_output_tokens` bounds each completion's output (4096 by default, maximum 8192). Set `agent.daily_token_budget` to reserve a UTC-day token budget (`0` disables it); the client conservatively reserves prompt bytes plus maximum output tokens and settles against provider usage, retaining the reservation when a request's outcome is uncertain. This is a token budget, not a price-based spend cap. Webhook handling only queues work; the worker performs model calls. To enable fix proposals, additionally set `fix.enabled: true` and populate `fix.allowed_user_ids` with the permitted GitLab user IDs. The fix allowlist must be non-empty, and the agent must be enabled.

## Run locally

```sh
cp configs/config.example.yaml configs/config.yaml
```

Set `CORVEX_GITLAB_READ_TOKEN` to a read-only GitLab token, `CORVEX_GITLAB_TOKEN` to a token permitted to post MR notes, and `CORVEX_WEBHOOK_SECRET` to the same secret configured on the project webhook. Keep read and write tokens separate and grant each only the required scopes. Then start the server:

```sh
go run ./cmd/corvex --config configs/config.yaml server
```

For asynchronous reviews or fix proposals, enable the agent configuration and run the worker in a second process:

```sh
go run ./cmd/corvex --config configs/config.yaml worker
```

The configured project IDs and user IDs are explicit allowlists. Both must be non-empty; an empty list never means unrestricted access.

An online SQLite backup can be created while the service is running. The destination must not already exist:

```sh
go run ./cmd/corvex backup \
  --database ./data/state/corvex.db \
  --output ./data/backups/corvex-$(date +%Y%m%d%H%M%S).db
```

To restore, stop both the server and worker, replace the configured database file with a verified backup, then restart the services. Apply your organization's encryption, access-control, and off-site retention policies to backup files.

The server prunes terminal jobs, job attempts, webhook events, and daily token usage older than `storage.retention_days` (90 days by default), and audit events older than `storage.audit_retention_days` (365 days by default). Queued and in-progress jobs are retained. Adjust these periods to match your organization's retention requirements. Project Git mirrors still require separate monitoring and maintenance.

## Docker Compose

Copy `.env.example` to `.env`, set the GitLab read/write tokens and webhook secret, and provide `configs/config.yaml`. Then run:

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

This starts the webhook server. To also run the worker, enable `agent.enabled: true` in `configs/config.yaml` and use the `worker` profile:

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile worker up --build -d
```

The server and worker share the SQLite/Git data volume; only the server exposes port 8080. Register a project hook with the optional idempotent helper (requires `curl` and `jq`):

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
make test
make lint
make build
```

The server and worker use separate read/write GitLab token variables; read requests use the read token, while note publication uses the write token. No untrusted-code executor is included.

## CI and releases

GitHub Actions runs tests and `go vet` on Linux, macOS, and Windows, and builds Linux, macOS, and Windows binaries for amd64 and arm64. Pushes to `main`, pull requests, and version tags run CI.

To publish a GitHub Release, push a version tag such as `v1.0.0`. GoReleaser attaches compressed binaries for all six platform/architecture combinations and a SHA-256 checksum file.
