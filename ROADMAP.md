# Roadmap

This document tracks features that were deferred or are still pending. Implemented items are marked as such and kept as a design record; the rest remain for a later iteration.

## GitLab webhook-driven events (deferred)

The original product included a second execution path beside persistent conversations: GitLab Note Hooks were verified and parsed into idempotent **events** that ran an agent session and published results back to a merge request. This path has been removed in full. It is recorded here so the design is not lost.

### Planned capabilities

- **Note Hook ingestion** — constant-time webhook secret verification, request body limits, optional blocked-user checks, bot/system note filtering, and idempotent delivery handling.
- **Commands** — slash commands in merge-request notes (`review`, `chat`, `explain`, `fix`, `implement`) parsed into typed events, with authorization checked in application code (including feature flags such as `fix.enabled` and `issue.implement_enabled`).
- **Event lifecycle** — a persisted state machine (`queued -> preparing -> analyzing -> [fixing -> verifying] -> publishing -> completed`, plus `failed`, `stale`, `cancelled`), leases renewed while running, startup recovery of interrupted events, and explicit retry rules (publishing failures are never retried automatically because the GitLab outcome is uncertain).
- **Revision safety** — record and re-verify the MR head SHA when fetching the diff, preparing the worktree and publishing, so a stale snapshot ends in `stale` instead of a partial publication.
- **Review workflow** — validate that each finding resolves to an added diff line, bound context size and finding count, and publish findings as MR notes without letting the agent publish directly.
- **Fix workflow** — proposal only, never commit or push; patches are limited to changed paths, size-capped, and checked with `git apply --check` and `git diff --check`.
- **Implement workflow** — Issue assistant that may open a Draft MR but never merges.
- **Operations surface** — event list/detail pages in the ops console, event CLI commands (`events list`, `events retry`), event metrics, traces and execution steps.

### Why it is deferred

The current stage focuses on persistent, user-driven conversations in the ops console. Conversations already cover repository inspection, editing, Git operations and GitLab writes through explicit tools, so the webhook path is redundant for now. Reintroducing it requires restoring a dedicated event store, the webhook/command layer, the workflows and their tests as a coherent unit.

### Reintroduction notes

- Keep authorization in application code; never trust webhook payloads or agent output.
- Keep the narrow tool set (no built-in shell, edit or write) and path/byte guards.
- Keep all agent output untrusted and re-check authorization, cancellation and revision before publishing to GitLab.
- Restore bilingual docs and integration tests together with the feature.

## Long-running autonomous agent gaps

Corvex already covers context governance (microcompaction, proactive compaction, real token counts, bounded tool results), human collaboration (steer/interject, queued follow-ups, Stop, notifications) and durable state (per-conversation full Pi session persistence, interrupted-turn recovery, rolling summaries). To match mainstream coding agents on **long, autonomous tasks**, the following gaps were identified. Most are now implemented (marked below); the remaining ones are ordered by impact.

### P0 — Tool loop detection and recovery (implemented)

Mainstream agents detect when the model repeats the same tool call with the same arguments, stops making progress, or fails the same way repeatedly, and steer or stop it. `src/agent/tool-loop.ts` records a bounded `(toolName, normalized args)` signature per session and injects a localized "you have repeated this N times — change strategy or report" steer at a threshold (4 consecutive / 8 total), treating repeated identical failures as exhausted. Git calls are separately capped per turn (`agent.git_tool_call_limit`), and a response-stall watchdog covers a silent model.

### P0 — Live plan state machine (implemented)

`record_plan` persists a task checklist in `conversation_plans` (`ConversationPlan`) with `pending / in_progress / completed` steps. The model can rewrite the list or send status-only updates; progress survives across turns and resume, and the console renders step statuses in the Chat process block.

### P1 — Task-level round/token budget with forced wrap-up (implemented)

`agent.task_max_rounds` / `agent.task_max_output_tokens` are soft per-task ceilings. `src/agent/task-budget.ts` observes model rounds and generated tokens, and at the ceiling steers the model once to stop starting new work, wrap up, and report from confirmed results. It never aborts the turn.

### P1 — Completion verification (implemented)

`src/agent/claim-verification.ts` now also treats "fixed / completed" claims as high-risk: they are unverified unless the turn's tool trace contains a read-back (`read_file`) or diff (`git_diff`) tool. The system prompt requires reading changes back before claiming completion; unverified claims surface as a `context` notice in the process snapshot.

### P2 — Verification sandbox (implemented)

The largest structural gap was that Corvex had no shell and never executed repository code, so it could not close the edit → test → fix loop that mainstream agents rely on. The decision is to allow **free commands** (not an allowlist) through a new `run_command` tool that supports shell syntax (pipes/redirects) in the configured backend, with two backends: a development-only `local` backend and a mandatory `sandbox` backend for production. The full design lives in [execution-design.md](execution-design.md) (Chinese, binding contract): config is admin-managed in SQLite with a YAML/env fallback and validated fail-closed, authorization and audit stay in Corvex code, results are redacted into traces. The sandbox backend runs commands in a container (network namespace isolated from the host, bridge by default so dependencies can be installed, `none` for full isolation), drops capabilities, uses a read-only rootfs with only the worktree mounted, and enforces CPU/memory/pids limits plus timeouts. P0/P1/P2/P3 are implemented: the process timeline renders `run_command` invocations with their command, the completion guard requires a successful `run_command` before claiming "tests/typecheck passed". Execution config is managed by admins at **Settings → Execution** (`GET/PUT/DELETE /api/ops/admin/execution`), stored in SQLite, validated fail-closed, and applies immediately; YAML/env remains the file fallback. The conversation workspace has an **Executions** tab listing past commands, backends and exit codes from audit events. End-to-end tests cover a real `run_command` call through PiAgent with the local backend. A future increment could reuse past results.

### P2 — Sub-agents / parallel research (planned)

Long tasks benefit from lightweight read-only sub-agents that investigate in parallel and return bounded findings, keeping the main session's context clean. Corvex still runs one session per turn; delegation is not implemented. The design is recorded in [subagent-design.md](subagent-design.md) (Chinese), based on how Claude Code, OpenCode, Cursor, Codex CLI and the Pi SDK example handle context isolation, tool scoping, delegation and result return. P0: a `spawn_subagent` tool with admin-defined agents, fresh context, a read-only tool subset, depth 1 and sidechain traces. P1: admin UI, resume and concurrency/token budgets. P2: background completion notifications and worktree-isolated writers.

## Readable terminal (P0/P1/P2 done)

A readable terminal for `run_command`: stream command output to the console in real time and let the user stop a single command without cancelling the whole turn. Full design in [terminal-design.md](terminal-design.md) (Chinese). P0 (done): `exec` SSE event, backend `onChunk`, streaming UI terminal and per-command cancel API/UI (stop reason `user manually stopped this command` is reported to the model). P1 (done): offline replay from the persisted process snapshot (`execOutput`). P2 (done, simplified): xterm.js rendering (ANSI + virtual scrolling), per-command filtering, and a collapsible terminal that auto-collapses on exit code 0; search/copy controls were removed.

## Scheduled tasks / natural-language scheduling (P0/P1/P2 done; webhook/new-conversation deferred)

Users can say "check CI every Monday at 9am" or "remind me in 45 minutes to push the branch" and the prompt runs automatically as a normal conversation turn. Design in [scheduled-tasks-design.md](scheduled-tasks-design.md) (Chinese), based on Claude Code `/loop` + `CronCreate/CronList/CronDelete`, Codex Automations and Cloud/Desktop scheduled tasks: natural language → 5-field cron confirmed by the model, no catch-up, per-user OAuth token (no global fallback). P0 (done): `scheduled_tasks` / `scheduled_task_runs` tables, strict cron parser + next-run helpers, Server abortable ticker with atomic claim, one-shot + recurring execution via `runTurn`, startup recovery without replay, model-side `schedule_task` / `list_scheduled_tasks` / `cancel_scheduled_task` tools. P1 (done): `/api/ops/me/scheduled-tasks` CRUD + run history and the ops-console Scheduled tasks page in the account menu; 30-day expiry. P2 (done): deterministic per-task jitter, IANA timezone-aware cron (UTC default), pause/resume and manual "run now" API + UI, run-history popover. GitLab webhook event triggers and creating a fresh conversation per task remain deferred (see the webhook events section above).

## Other deferred items

No other items are currently recorded.
