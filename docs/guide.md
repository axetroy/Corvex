# Getting started

Corvex is a self-hosted code review and repair agent for GitLab. The webhook server accepts GitLab Note Hook events, and an optional worker processes queued review and fix tasks asynchronously.

## Requirements

- Go version specified in [`go.mod`](https://github.com/axetroy/Corvex/blob/main/go.mod)
- A GitLab project and webhook
- GitLab API tokens for repository reads and (if publishing review comments) writes

## Run locally

Copy the example configuration and set the required secrets in your environment:

```sh
cp configs/config.example.yaml configs/config.yaml
```

Set `CORVEX_GITLAB_READ_TOKEN` to a read-only token, `CORVEX_GITLAB_TOKEN` to a token permitted to post merge request notes, and `CORVEX_WEBHOOK_SECRET` to the secret configured for the GitLab webhook. Keep read and write tokens separate and grant each only the required permissions.

Start the webhook server:

```sh
go run ./cmd/corvex --config configs/config.yaml server
```

Add the project IDs and user IDs permitted to use Corvex to the configuration. Both allowlists must be non-empty; an empty list never grants unrestricted access.

## Enable reviews

Configure `agent.enabled: true`, `agent.base_url`, and `agent.model`, then provide `CORVEX_MODEL_API_KEY`. Start a worker in a second process:

```sh
go run ./cmd/corvex --config configs/config.yaml worker
```

Webhook handling only queues work; the worker performs model calls. The worker checks that the merge request diff has not changed before reviewing and before publishing findings. Reviews use an isolated worktree and validated findings are published as line-level discussions, with a summary comment as a fallback.

The optional `agent.daily_token_budget` is a UTC-day token budget, not a price-based spend cap. See [`configs/config.example.yaml`](https://github.com/axetroy/Corvex/blob/main/configs/config.example.yaml) for all available settings.

## Fix proposals

Fix proposals are disabled by default. To enable them, set `fix.enabled: true` and configure a non-empty `fix.allowed_user_ids` allowlist. The agent must also be enabled. Proposed patches are limited to files changed in the merge request, validated, and posted for manual application. Corvex does not run repository scripts, create commits, or push code.

## Docker Compose

Copy `.env.example` to `.env`, configure the GitLab tokens and webhook secret, and prepare `configs/config.yaml`. Start the server:

```sh
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

To run the worker too, enable the agent in the configuration and use the `worker` profile:

```sh
docker compose --env-file .env -f deploy/compose.yaml --profile worker up --build -d
```

## Development

```sh
make test
make lint
make build
```

See the [repository README](https://github.com/axetroy/Corvex/blob/main/README.md) for backup and restore, retention, metrics, and additional operational details.
