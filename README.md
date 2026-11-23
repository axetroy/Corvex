# Corvex

Corvex is a self-hosted GitLab agent built as a single TypeScript application powered by the Pi SDK. See [design.md](design.md) for the architecture and the [documentation](https://axetroy.github.io/Corvex/).

## Overview

Corvex runs persistent conversations in the ops console. Each conversation is bound to one repository branch and a pinned revision, and runs inline in the Server process.

- The console discovers every repository visible to the signed-in user's GitLab token and stores conversations and turns in SQLite.
- Each turn keeps its own trajectory, execution records, a streaming reply and bounded per-request context snapshots; the workspace includes Context and Trace inspectors, a read-only Git graph, file browser and conversation records.
- Conversations may read and, with explicit user intent, write to GitLab through bounded tools; the Git tool set is confined to the conversation worktree and local mirror.
- Corvex does not execute repository scripts or tests. There is no shell executor by design.
- Prometheus metrics and a storage cleanup console support operations.

Webhook-driven task events (review, chat, explain, fix, Issue implementation) are not part of this stage; see [ROADMAP.md](ROADMAP.md) for the deferred design.

See the [getting started guide](https://axetroy.github.io/Corvex/guide), [configuration reference](https://axetroy.github.io/Corvex/configuration), [architecture](https://axetroy.github.io/Corvex/architecture), and [operations guide](https://axetroy.github.io/Corvex/operations) for setup and safety details.

## Quick start

Requires Node.js 26.12.1 and pnpm 12.4.1. From a source checkout:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

Configure GitLab OAuth in the setup page, then sign in at `/ops` to create conversations. For Docker Compose, backups, retention and TLS, see the [operations guide](https://axetroy.github.io/Corvex/operations).

## Deployment

Corvex provides a prebuilt `ghcr.io/axetroy/corvex` image and a Compose deployment with a single Server service. See the [operations guide](https://axetroy.github.io/Corvex/operations) for deployment, storage and resource settings.

## Development

```sh
pnpm test
pnpm run lint
pnpm run typecheck
pnpm run build
```

Corvex performs every GitLab API and Git network operation with the signed-in user's OAuth token; it has no shared read/write PAT. GitLab write tools still require explicit user intent. No untrusted-code executor is included.
