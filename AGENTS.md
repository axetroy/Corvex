# AGENTS.md

Guidance for coding agents working in this repository. Read `design.md` before making architectural changes: it is the binding contract for the runtime, boundaries and security invariants.

## Project overview

Corvex is a self-hosted GitLab code review and repair agent. It is a single TypeScript application with two process modes that share one SQLite database and one Git storage root:

- `server`: receives GitLab Note Hooks, verifies them, applies the optional user blocklist, parses commands and creates idempotent events; it also executes conversation turns inline through `ConversationRunner` (never through the worker). The authenticated ops console discovers projects visible to its read token.
- `worker`: claims an event lease, pins the merge-request head SHA, prepares a detached Git worktree, runs one Pi SDK session for that event, validates the output, optionally checks a patch, and publishes notes back to GitLab.

The agent runtime is `@earendil-works/pi-coding-agent` (Pi SDK). Pi runs the model loop, tools and skills; Corvex owns authorization, event state, validation and publishing. Supported events: `review`, `chat`, `explain`, `fix` (proposal only, never committed or pushed), `implement` (Issue assistant; may open a Draft MR, never merges). Persistent read-only `conversation` turns initiated in the ops console are not events: they live in their own `conversations` / `conversation_messages` / `conversation_turns` tables and run inline in the Server.

Conversations are the ops console's primary object: a conversation binds one repository branch and each turn keeps its own trajectory (`event_trace` keyed by `turn_id`) and execution records. The console opens on Conversations, renders each assistant reply's thinking and tool calls in the Chat tab through `ConversationTimeline`, shows the conversation's system prompt above the transcript (the server derives it from `agent.response_language` and the conversation mode in `GET /api/ops/conversations/:id`), and reads a single turn's records through `GET /api/ops/conversations/:id/turns/:turnId`; the store verifies the turn belongs to that conversation. Trajectory data stays redacted and size-capped in `src/events/store.ts`.

The conversation sidebar groups conversations by repository with the most recently updated conversation (and group) first; each group has a sticky header with a stable color dot and separator, items are single-line titles, and a running turn shows a pulsing dot.

While a turn runs, the Chat tab streams its assistant text so the reply fills in token by token instead of appearing at once. `PiAgent` forwards cumulative text from the SDK's `message_update` events (`onTextDelta`), `ConversationRunner` publishes it per turn with the latest snapshot for late subscribers, and `GET /api/ops/conversations/:id/turns/:turnId/stream` serves it as SSE. The console reads it through `src/app/ui/stream.ts` with `fetch` rather than `EventSource`, because the console's Basic credentials are only attached automatically to same-origin `fetch`. The stream is display-only: it never writes to SQLite, closes with a `done` event as soon as the answer is persisted, and polling remains the fallback when the connection drops.

The same stream carries the model's thinking text as `thinking` events and each tool execution as a `tool` event. The console renders them as one interleaved `ConversationTimeline` above the final reply — a new thinking entry starts on every model round and the following tool calls are appended in execution order, so every thought and every tool call is visible separately. Thinking, intermediate replies and tool calls are folded into a redacted, size-capped process snapshot on `conversation_turns.process`, so the process block survives a reload; redacted thinking parts are skipped in the live stream and tool events carry a call ID for replay. The whole process block is forced open and cannot be collapsed while the turn runs, then collapses as one unit when it settles (the operator may expand it again). Each tool call is itself a small disclosure whose parameters stay hidden until expanded. The process uses a lightweight OpenCode-style timeline (left rail, per-step dots, small muted headings, single-line tool rows) rather than stacked cards. The chat transcript pane is the single scroll container: `Bubble.List`'s internal scrolling is disabled and the pane follows new content only while the user is near the bottom.

Each conversation carries an explicit mode (`ConversationMode` in `src/events/model.ts`, default `read_only`) instead of hardcoded read-only assumptions. `conversationCapabilities(mode)` is the single source for a mode's workflow step and whether it may write to the repository; the runner, the Pi prompt and tool access, the store, and the console all derive from it. Only `read_only` exists today (no repository writes, no GitLab publishing); adding a writable mode means extending `conversationCapabilities`, the prompt, and wiring write-tool context, then updating docs.

Each conversation keeps one read-only worktree reused across its turns (`workspaces/<projectId>/conversation-<conversationId>`, derived by `conversationWorkspaceName`) instead of preparing and deleting one per turn. `ConversationRunner` owns the cache (idle TTL plus an LRU cap, released on Server shutdown); `GitManager.prepareConversationWorkspace` re-verifies HEAD for the same pinned SHA and only `checkout --detach`s when the snapshot advanced, so the fixed-SHA invariant still holds. Conversations are read-only and serialized per conversation, which is what makes reuse safe. Git mirrors are also fetched lazily: `prepareWorkspace` / `prepareConversationWorkspace` run `cat-file -e` first and only fetch the SHA when it is missing, and the review/fix path calls `ensureCommitAvailable` for the MR base SHA it diffs against. `storage cleanup` skips conversation workspaces whose conversation still has a queued or running turn (`EventStore.activeConversationIds`).

## Environment

- Node.js 26.12.1 (`.nvmrc`, `engines.node`) and pnpm 12.4.1 (`packageManager`). Do not switch package manager or edit `pnpm-lock.yaml` by hand; keep the `allowBuilds` entries in `pnpm-workspace.yaml`.
- Install with `pnpm install --frozen-lockfile`.
- `git` must be on `PATH`: the worker shells out to Git, and the integration tests build real repositories.
- SQLite comes from Node's built-in `node:sqlite`. Never add a database driver, ORM or query builder.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm run build` | `tsc -p tsconfig.json` into `dist/`, then bundles the React agent console into `dist/app/ui` with Vite |
| `pnpm run typecheck` | Type-checks `src` (`tsconfig.json`), `src` + `test` + `scripts` (`tsconfig.test.json`), and the console (`src/app/ui/tsconfig.json`) |
| `pnpm run ui:build` / `ui:dev` | Build the console, or open the Vite dev server proxying `/api` to a local Server |
| `pnpm run lint` | ESLint over `src`, `test`, `scripts` |
| `pnpm test` | Builds the console, then runs Vitest over `test/unit` and `test/integration` |
| `pnpm vitest run test/unit/command.test.ts` | Focused test file |
| `pnpm vitest run -t "name"` | Focused test by name |
| `pnpm dev` | Builds the console, then `tsx watch src/cli.ts` (CLI defaults to `server` mode) |
| `pnpm run docs:dev` / `docs:build` / `docs:preview` | VitePress site under `docs/` |

CLI entry points (`node dist/cli.js ...`, or `pnpm start -- ...`):

- `init --config <path>` writes a config template; `check-config --config <path> [--for server|worker]` validates per role.
- `server` / `worker` start a mode.
- `events list [--status <status>] [--limit n] --database <path>`, `events retry <event-id> --database <path>`.
- `backup --database <path> --output <new-path>`; `storage cleanup [--older-than-days n] [--apply]` (dry run unless `--apply`).

`Makefile` targets (`build`, `test`, `lint`, `typecheck`, `run`, `init`, `config-check`, `deploy`, `deploy-worker`) are thin wrappers around the same commands.

Before finishing a change, run `pnpm run lint`, `pnpm run typecheck` and `pnpm test`; CI runs them on Ubuntu, macOS and Windows, so keep paths and file handling cross-platform.

## Layout

```text
src/cli.ts          argument parsing and process wiring (init/backup/events/storage/server/worker)
src/config/         YAML loading, role-based validation, defaults
src/app/            HTTP server, inline conversation runner, worker loop, leases/retries, readiness, metrics, ops console
src/app/ui/         React agent console, bundled by Vite into dist/app/ui and served under /ops
src/events/         SQLite schema + migrations, event/conversation store, state machine, trace/metrics persistence
src/gitlab/         webhook verification/parsing, command parsing, REST client
src/git/            mirror clones, detached worktrees, diffs, path and patch checks
src/agent/          Pi session factory, prompts, and the narrow per-event/conversation tools
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
- No secrets in code, configs, fixtures, logs, prompts or trace payloads. Trace data is redacted and size-capped in `src/events/store.ts`; do not bypass that path.
- The ops console runs on Ant Design v6. Select-like popups are portalled to `body`, so they leave the component's subtree: custom properties defined on the trigger do not reach them (pass `classNames.popup.root` and declare the popup's own variables), and Ant Design's runtime-injected styles use three class selectors, so overrides need at least four.
- The console shell (`.app-shell`) is a full-viewport flex row: a collapsible left sidebar (`<aside class="sidebar">`, `flex: 0 0 auto`) holds a compact head (48px: brand plus an icon language `Dropdown`) above the inline `Menu`, and a scrolling `<main>` (`flex: 1`, `min-width: 0`) fills the rest. Collapsing toggles `inlineCollapsed` and the `sidebar-collapsed` class (narrow width, icon-only menu, icon-only brand head) and persists in `localStorage`. There is no footer: the refresh caption is a floating `#updated` span positioned over the shell (hidden under 800px). Non-conversation pages keep their centered max-width via `<main>` padding (`max(24px, calc((100% - 1200px) / 2))`) with `overflow: auto`, so the scrollbar sits at the window edge; the conversation route adds `content-full`, which drops the padding and lets the workspace fill the whole `<main>`. On the conversation page the repository info is passed to the `Tabs` `tabBarExtraContent` so it shares the tab row (it wraps below the tabs under 640px) rather than occupying its own header line.
- The conversation **Trace** tab reads the whole conversation through `GET /api/ops/conversations/<id>/turns` (every turn's trajectory merged into one timeline) and defaults to that merged view; `GET /api/ops/conversations/<id>/turns/<turnId>` still serves a single turn. `TraceExperience` renders only the timeline (`TraceDiagram`); the earlier session view was removed, so keep one view rather than re-adding tabs. Trace entries and execution steps carry `turnId`, so the console groups them by turn. The timeline geometry lives in `buildTimelineLayout` (`src/app/ui/trace.ts`): each turn becomes one band with its own ruler and a fixed pixel `segmentGap` between bands, so real elapsed time is expressed by each band's own ruler and a long pause between turns does not open a huge blank. Because bands are laid out independently, drag selection compares absolute pixels, not the per-band ratios.
- Context governance lives in `src/agent/budget.ts` (`estimateTokens`, `estimateConservativeTokens`, `resolveMaxInputTokens`, `resolveHistoryBudgetTokens`, `chunkForSummary`, `isContextOverflowError`, `trimHistory`), `src/agent/tool-budget.ts` and the `agent.*` budget keys (`context_window`, `max_input_tokens`, `history_token_budget`, `turn_tool_result_bytes`, `compaction_*`, `summary_enabled`). Tool results are hard-truncated per call and per assistant round before they enter session history, and the compaction reserve is derived from that round bound plus `max_output_tokens`, because the SDK only estimates content added since the last provider usage. `turn_tool_result_bytes` stays a soft checkpoint, not a hard cap: at 75% the model is steered to record progress and use targeted reads, but the turn is not aborted; context growth is absorbed by SDK compaction and a single history-dropping retry on a provider overflow. `session.prompt()` resolves normally when the provider rejects a request, so `runSession` records the final assistant message's `errorMessage` and rethrows it: without that, a failed turn would return the previous turn's reply (the last assistant message in the session) as a fresh answer and the overflow retry would never fire. Requests are trimmed locally before they leave the process; do not widen these budgets to paper over a provider error. `resolveMaxPromptBytes` derives the per-request prompt cap from `context_window` rather than a fixed 96 KiB, so long history is not rejected before it leaves the process.
- Runtime settings are the only supported way to change the model, response language, budgets, tool switches, review limits or repair permissions without editing the config file. `src/config/settings.ts` owns the generalized `runtimeSettingDefinitions` (section + field, not just `agent`, and `number` / `boolean` / `string` types), `runtimeSettingsView`, `runtimeSettingsEffective`, `applyRuntimeSettings`, `applyRuntimeSettingRows`, `copyRuntimeSettings` and `validateRuntimeSettings`; the Server exposes `GET`/`PUT /api/ops/settings` (SQLite `runtime_settings` with `updated_at`/`updated_by`, `409` without `--config`), reapplies stored overrides at startup, and writes an `update_settings` audit entry with the operator and the old→new diff. The Worker reloads the overrides each poll and rebuilds the workflows that captured review/fix limits in their constructor, so a console change reaches event tasks without a restart. `model` and `response_language` are read per request/turn, so they apply to the next one. Credentials, `agent.base_url`, `agent.api_key`, `agent.enabled`, skill paths, blocked hosts, timeouts, retention and worker poll parameters stay file/environment-only. The console `SettingsPage` renders `settingGroups` from `src/app/ui/types.ts`: common groups stay expanded, while window-derived keys live in a collapsed advanced group, and every field shows the effective value returned by the Server when the runtime adjusted it. String fields render a `Select` when the field lists `values`, otherwise an `Input`. The UI field keys must match `runtimeSettingDefinitions` exactly; `test/unit/settings.test.ts` enforces that both directions stay in sync.

## Architecture and safety invariants

These are deliberate constraints, not incidental behavior. Do not weaken them to make a change simpler.

- Authorization lives in Corvex code: constant-time webhook secret comparison, request body limits, optional blocked-user checks, bot/system notes ignored, webhook events idempotent. Register webhooks only on projects where commands are intended; the ops console project scope is controlled by the GitLab read token, not a static allowlist. `fix` additionally requires `fix.enabled` (which requires `agent.enabled`); `implement` requires `issue.implement_enabled` (also gated on `agent.enabled`).
- Every event records the MR head SHA and re-verifies that snapshot when fetching the diff, preparing the worktree and publishing. A stale snapshot ends in `stale`, not a partial publication.
- The Pi session gets only the tools the task needs. No built-in `bash`, `edit` or `write` for review or fix events; custom tools confine paths to the task worktree and enforce byte limits themselves. Skills are instructions, never access control.
- Conversation turns pin their GitLab target SHA and expose repository tools derived from the conversation's mode; a `read_only` conversation must not publish to GitLab or write to the worktree.
- Agent output is untrusted: findings must resolve to added diff lines; patches are limited to changed paths, size-capped, and checked with `git apply --check` and `git diff --check`. The agent never publishes directly — Corvex re-checks authorization, cancellation and revision before writing to GitLab.
- Never execute repository code, scripts or tests. There is no shell executor by design; adding one requires a separate sandbox and authorization design.
- Event state transitions are enforced in `EventStore` (`queued -> preparing -> analyzing -> [fixing -> verifying] -> publishing -> completed`, plus `failed`, `stale`, `cancelled`). Leases are renewed while an event runs; publishing failures are not retried automatically because the GitLab outcome may be uncertain. Conversation turns follow their own `queued -> running -> completed` lifecycle and never publish.
- Configuration is validated per role: `server` needs no model key, `worker` needs no webhook secret, `storage` commands need only storage settings.

## Tests

- Vitest; `vitest.config.ts` scopes the suite to `test/**` so local runtime data under `data/` (conversation workspaces can contain third-party `*.test.js`) is never scanned. Unit tests sit in `test/unit/<module>.test.ts` next to the module they cover; the ops console scripts have `test/unit/ui-*.test.js`.
- Integration tests (`test/integration/`) spin up fake GitLab and model HTTP servers on ephemeral ports, use real Git repos in temporary directories, and drive `CorvexServer` + `Worker` against one throwaway SQLite database. Follow that pattern instead of mocking the store or the client wholesale.
- Keep tests hermetic: no outbound network, no dependence on developer machine state, clean up temp dirs, and abort running loops in `afterEach`.
- Add or update tests for behavior changes, including failure paths (invalid model output, expired revision, duplicate webhook, cancellation, patch scope violation).

## Commits and pull requests

- Conventional commit prefixes are used (`feat:`, `fix:`, `docs:`, `chore:` and scoped variants like `feat(git):`); subjects are written in Chinese or English, matching the surrounding history.
- Keep one logical change per commit and stage only files related to it. Do not commit `.env`, local databases, or `data/`.
- CI (`.github/workflows/ci.yml`) runs lint, typecheck, tests, build, then a Docker server/worker smoke test. A tag push (`.github/workflows/release.yml`) publishes the multi-arch GHCR image and a GitHub release, so do not create releases or push tags from a working branch.
