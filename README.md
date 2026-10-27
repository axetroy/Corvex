# Corvex

Corvex is a self-hosted GitLab code review and repair agent. This repository is implementing the MVP in phases described in [design.md](design.md).

## Current implementation

The implementation currently provides:

- A GitLab Note Hook endpoint with constant-time webhook-token validation.
- Project and user allowlists, bot/system-note filtering, and strict `@corvex` command parsing.
- SQLite persistence with durable event deduplication and queued review tasks.
- `review`, `status`, and owner-only `cancel` commands.
- GitLab MR note replies, `/healthz` and database-backed `/readyz` endpoints.
- YAML configuration with secrets supplied only through environment variables.
- GitLab MR/project metadata and paginated diff API methods.
- A Git engine for project mirrors, isolated detached worktrees at an exact SHA, bounded local diffs, and workspace-contained file reads.
- An OpenAI-compatible chat client and review workflow with bounded context, strict structured output, added-line/evidence validation, severity checks, and duplicate filtering.

The `server` persists review tasks and the optional `worker` processes them asynchronously. The worker verifies the MR Head SHA before review and again before publishing, uses an isolated worktree, and posts a validated summary note. Findings are not yet published as line-level discussions. The `fix` command remains intentionally disabled.

To enable reviews, set `agent.enabled: true`, configure `agent.base_url` and `agent.model`, and provide `CORVEX_MODEL_API_KEY`. Webhook handling only queues work; the worker performs model calls.

## Run locally

```sh
cp configs/config.example.yaml configs/config.yaml
```

Set `CORVEX_GITLAB_READ_TOKEN` to a read-only GitLab token, `CORVEX_GITLAB_TOKEN` to a token permitted to post MR notes, and `CORVEX_WEBHOOK_SECRET` to the same secret configured on the project webhook. Keep read and write tokens separate and grant each only the required scopes. Then start the server:

```sh
go run ./cmd/corvex --config configs/config.yaml server
```

For asynchronous reviews, enable the agent configuration and run the worker in a second process:

```sh
go run ./cmd/corvex --config configs/config.yaml worker
```

The configured project IDs and user IDs are explicit allowlists. Both must be non-empty; an empty list never means unrestricted access.

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

## Development

```sh
make test
make lint
make build
```

The server and worker use separate read/write GitLab token variables; read requests use the read token, while note publication uses the write token. No untrusted-code executor is included.
