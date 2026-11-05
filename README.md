# Corvex

Corvex is a self-hosted GitLab code review and repair agent built as a single TypeScript application powered by the Pi SDK. See [design.md](design.md) for the architecture and the [documentation](https://axetroy.github.io/Corvex/).

## Overview

Corvex receives GitLab Note Hooks, queues work in SQLite, and processes model tasks in a separate worker. It supports merge-request review, chat, explanation and fix proposals, plus Issue assistance that can answer or propose implementation.

- The operations console can discover every repository visible to its GitLab read token; webhook commands can be restricted with an optional user blocklist.
- Reviews use pinned merge-request revisions and publish validated findings as line discussions.
- Fix proposals are for manual application. Issue replies do not write code; implementation is separately disabled by default with `issue.implement_enabled`.
- Issue implementation targets the project default branch unless the current request explicitly names another existing branch. It creates a Draft MR and never auto-merges.
- The worker does not execute repository scripts or tests. SQLite records tasks and lifecycle events.
- An optional read-only operations console and Prometheus metrics support monitoring.

See the [getting started guide](https://axetroy.github.io/Corvex/guide), [configuration reference](https://axetroy.github.io/Corvex/configuration), [architecture](https://axetroy.github.io/Corvex/architecture), and [operations guide](https://axetroy.github.io/Corvex/operations) for setup, limits, and safety details.

## Quick start

Requires Node.js 26.12.1 and pnpm 12.4.1. From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

Set the GitLab URL in the generated YAML, provide secrets through environment variables, and configure a read token for repository discovery in the operations console. Follow the [getting started guide](https://axetroy.github.io/Corvex/guide) to register the Note Hook and start the server and optional worker. For Docker Compose, backups, retention, TLS, and persistent chat sessions, see the [operations guide](https://axetroy.github.io/Corvex/operations).

## Deployment

Corvex provides a prebuilt `ghcr.io/axetroy/corvex` image and a Compose deployment for the server and optional worker. Follow the [operations guide](https://axetroy.github.io/Corvex/operations) for deployment, webhook registration, storage, and resource settings.

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

The worker uses a GitLab read token for API/repository reads and a write token for publication. No untrusted-code executor is included.
