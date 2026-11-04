# AGENTS.md

Guidance for coding agents working in this repository. Read `design.md` before making architectural changes: it is the binding contract for the runtime, boundaries and security invariants.

## Project overview

Corvex is a self-hosted GitLab code review and repair agent. It is a single TypeScript application with two process modes that share one SQLite database and one Git storage root:

- `server`: receives GitLab Note Hooks, verifies them, applies allowlists, parses commands and creates idempotent jobs.
- `worker`: claims a job lease, pins the merge-request head SHA, prepares a detached Git worktree, runs one Pi SDK session for that job, validates the output, optionally checks a patch, and publishes notes back to GitLab.

The agent runtime is `@earendil-works/pi-coding-agent` (Pi SDK). Pi runs the model loop, tools and skills; Corvex owns authorization, job state, validation and publishing. Supported jobs: `review`, `chat`, `explain`, `fix` (proposal only, never committed or pushed), and `implement` (Issue assistant; may open a Draft MR, never merges).

## Environment

- Node.js 26.12.1 (`.nvmrc`, `engines.node`) and pnpm 12.4.1 (`packageManager`). Do not switch package manager or edit `pnpm-lock.yaml` by hand; keep the `allowBuilds` entries in `pnpm-workspace.yaml`.
- Install with `pnpm install --frozen-lockfile`.
- `git` must be on `PATH`: the worker shells out to Git, and the integration tests build real repositories.
- SQLite comes from Node's built-in `node:sqlite`. Never add a database driver, ORM or query builder.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm run build` | `tsc -p tsconfig.json` into `dist/`, then copies the operations console (`src/app/ui`) into `dist/app/ui` |
| `pnpm run typecheck` | Type-checks `src` (`tsconfig.json`) and `src` + `test` + `scripts` (`tsconfig.test.json`) |
| `pnpm run lint` | ESLint over `src`, `test`, `scripts` |
| `pnpm test` | Vitest run: everything under `test/unit` and `test/integration` |
| `pnpm vitest run test/unit/command.test.ts` | Focused test file |
| `pnpm vitest run -t "name"` | Focused test by name |
| `pnpm dev` | `tsx watch src/cli.ts` (CLI defaults to `server` mode) |
| `pnpm run docs:dev` / `docs:build` / `docs:preview` | VitePress site under `docs/` |

CLI entry points (`node dist/cli.js ...`, or `pnpm start -- ...`):

- `init --config <path>` writes a config template; `check-config --config <path> [--for server|worker]` validates per role.
- `server` / `worker` start a mode.
- `jobs list [--status <status>] [--limit n] --database <path>`, `jobs retry <job-id> --database <path>`.
- `backup --database <path> --output <new-path>`; `storage cleanup [--older-than-days n] [--apply]` (dry run unless `--apply`).

`Makefile` targets (`build`, `test`, `lint`, `typecheck`, `run`, `init`, `config-check`, `deploy`, `deploy-worker`) are thin wrappers around the same commands.

Before finishing a change, run `pnpm run lint`, `pnpm run typecheck` and `pnpm test`; CI runs them on Ubuntu, macOS and Windows, so keep paths and file handling cross-platform.

## Layout

```text
src/cli.ts          argument parsing and process wiring (init/backup/jobs/storage/server/worker)
src/config/         YAML loading, role-based validation, defaults
src/app/            HTTP server, worker loop, leases/retries, readiness, metrics, ops console
src/app/ui/         vanilla HTML/CSS/JS operations console (copied into dist at build time)
src/jobs/           SQLite schema + migrations, job store, state machine, trace/metrics persistence
src/gitlab/         webhook verification/parsing, command parsing, REST client
src/git/            mirror clones, detached worktrees, diffs, path and patch checks
src/agent/          Pi session factory, prompts, and the narrow per-job tools
src/review/         review workflow, finding validation, benchmark support
src/fix/            fix-proposal workflow
src/implement/      Issue assistant / Draft MR workflow
test/unit/          unit tests, grouped by module
test/integration/   end-to-end loops with fake GitLab and model HTTP servers
test/fixtures/      config fixtures used by CI docker smoke
```

## Code conventions

- ESM with `module`/`moduleResolution` `NodeNext`: relative imports carry a `.js` extension even from `.ts` files (`./model.js`). Use `import type` / `type` modifiers for type-only imports.
- TypeScript is `strict`. Avoid `any`; validate external data (YAML, HTTP bodies, GitLab payloads, model output, SQLite rows) at the boundary and narrow with type guards.
- Prefer Node built-ins (`node:fs/promises`, `node:crypto`, `node:sqlite`, `node:http`, `node:timers/promises`) and standard `fetch`. New runtime dependencies are an architecture decision: justify them in `design.md` and keep the dependency set minimal.
- Source comments and JSDoc are written in Chinese; keep that convention and keep them true. Identifiers and user-visible log keys are English.
- User-visible text follows the configured `agent.response_language` (`en` or `zh-CN`). Docs are bilingual: `docs/<page>.md` plus `docs/zh-CN/<page>.md`, and `README.md` plus `README.zh_CN.md`, with navigation in `docs/.vitepress/config.mts`. Update both languages when behavior, config, or operations change.
- No secrets in code, configs, fixtures, logs, prompts or trace payloads. Trace data is redacted and size-capped in `src/jobs/store.ts`; do not bypass that path.

## Architecture and safety invariants

These are deliberate constraints, not incidental behavior. Do not weaken them to make a change simpler.

- Authorization lives in Corvex code: constant-time webhook secret comparison, request body limits, empty allowlist means invalid (never "allow all"), bot/system notes ignored, webhook events idempotent. `fix` additionally requires `fix.enabled` (which requires `agent.enabled`); `implement` requires `issue.implement_enabled` (also gated on `agent.enabled`).
- Every job records the MR head SHA and re-verifies that snapshot when fetching the diff, preparing the worktree and publishing. A stale snapshot ends in `stale`, not a partial publication.
- The Pi session gets only the tools the job needs. No built-in `bash`, `edit` or `write` for review or fix jobs; custom tools confine paths to the task worktree and enforce byte limits themselves. Skills are instructions, never access control.
- Agent output is untrusted: findings must resolve to added diff lines; patches are limited to changed paths, size-capped, and checked with `git apply --check` and `git diff --check`. The agent never publishes directly — Corvex re-checks authorization, cancellation and revision before writing to GitLab.
- Never execute repository code, scripts or tests. There is no shell executor by design; adding one requires a separate sandbox and authorization design.
- Job state transitions are enforced in `JobStore` (`queued -> preparing -> analyzing -> [fixing -> verifying] -> publishing -> completed`, plus `failed`, `stale`, `cancelled`). Leases are renewed while a job runs; publishing failures are not retried automatically because the GitLab outcome may be uncertain.
- Configuration is validated per role: `server` needs no model key, `worker` needs no webhook secret, `storage` commands need only storage settings.

## Tests

- Vitest, no custom config. Unit tests sit in `test/unit/<module>.test.ts` next to the module they cover; the ops console scripts have `test/unit/ui-*.test.js`.
- Integration tests (`test/integration/`) spin up fake GitLab and model HTTP servers on ephemeral ports, use real Git repos in temporary directories, and drive `CorvexServer` + `Worker` against one throwaway SQLite database. Follow that pattern instead of mocking the store or the client wholesale.
- Keep tests hermetic: no outbound network, no dependence on developer machine state, clean up temp dirs, and abort running loops in `afterEach`.
- Add or update tests for behavior changes, including failure paths (invalid model output, expired revision, duplicate webhook, cancellation, patch scope violation).

## Commits and pull requests

- Conventional commit prefixes are used (`feat:`, `fix:`, `docs:`, `chore:` and scoped variants like `feat(git):`); subjects are written in Chinese or English, matching the surrounding history.
- Keep one logical change per commit and stage only files related to it. Do not commit `.env`, local databases, or `data/`.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, build, then a Docker server/worker smoke test. A tag push (`.github/workflows/release.yml`) publishes the multi-arch GHCR image and a GitHub release, so do not create releases or push tags from a working branch.
