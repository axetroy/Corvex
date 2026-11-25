# Roadmap

This document tracks features that are intentionally deferred. Items here are not implemented in the current stage; they are kept as a design record and will be revisited in a later iteration.

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

Corvex already covers context governance (microcompaction, proactive compaction, real token counts, bounded tool results), human collaboration (steer/interject, queued follow-ups, Stop, notifications) and durable state (per-conversation full Pi session persistence, interrupted-turn recovery, rolling summaries). To match mainstream coding agents on **long, autonomous tasks**, the following gaps remain. They are ordered by impact and are not implemented in this stage (except where noted).

### P0 — Tool loop detection and recovery (implemented)

Mainstream agents detect when the model repeats the same tool call with the same arguments, stops making progress, or fails the same way repeatedly, and steer or stop it. Corvex only has narrow guards: a 40-call Git budget, a five-read hint for `read_file`, and a response-stall watchdog. A previous session still produced 253 turns re-reading the same files. Plan: record a bounded signature of `(toolName, normalized args)` per turn, inject a localized "you have repeated this N times — change strategy or report" context notice at a threshold, count repeats toward the turn's tool budget, and mark repeated identical failures as exhausted.

### P0 — Live plan state machine (implemented)

`record_plan` currently stores an immutable text list in the process snapshot; the model cannot update a step's status and a resumed turn does not know its progress. Mainstream agents keep a persisted checklist with `pending / in_progress / completed` states, updated across turns and reflected in the UI. Plan: evolve `record_plan` into a persisted task list with per-step status, allow status-only updates, restore it on resume, and render progress in the console.

### P1 — Task-level round/token budget with forced wrap-up (implemented)

`agent.task_max_rounds` / `agent.task_max_output_tokens` are soft per-task ceilings. `src/agent/task-budget.ts` observes model rounds and generated tokens, and at the ceiling steers the model once to stop starting new work, wrap up, and report from confirmed results. It never aborts the turn.

### P1 — Completion verification (implemented)

`src/agent/claim-verification.ts` now also treats "fixed / completed" claims as high-risk: they are unverified unless the turn's tool trace contains a read-back (`read_file`) or diff (`git_diff`) tool. The system prompt requires reading changes back before claiming completion; unverified claims surface as a `context` notice in the process snapshot.

### P2 — Verification sandbox (implemented)

The largest structural gap: Corvex has no shell and never executes repository code (`design.md` non-goal), so it cannot close the edit → test → fix loop that mainstream agents rely on. The decision is to allow **free commands** (not an allowlist) through a new `run_command` tool that parses argv without a shell interpreter, with two backends: a development-only `local` backend and a mandatory `sandbox` backend for production. The full design lives in [execution-design.md](execution-design.md) (Chinese, binding contract): config is file-only and fail-closed, authorization and audit stay in Corvex code, results are redacted into traces. The sandbox backend runs commands in a container (network namespace isolated from the host, bridge by default so dependencies can be installed, `none` for full isolation), drops capabilities, uses a read-only rootfs with only the worktree mounted, and enforces CPU/memory/pids limits plus timeouts. P0/P1/P2/P3 are implemented: the process timeline renders `run_command` invocations with their command, the completion guard requires a successful `run_command` before claiming "tests/typecheck passed". Execution config is managed by admins at **Settings → Execution** (`GET/PUT/DELETE /api/ops/admin/execution`), stored in SQLite, validated fail-closed, and applies immediately; YAML/env remains the file fallback. The conversation workspace has an **Executions** tab listing past commands, backends and exit codes from audit events. End-to-end tests cover a real `run_command` call through PiAgent with the local backend. A future increment could reuse past results.

### P2 — Sub-agents / parallel research

Long tasks benefit from lightweight read-only sub-agents that investigate in parallel and return bounded findings, keeping the main session's context clean. Corvex runs one session per turn; delegation is deferred.

## Other deferred items

No other items are currently recorded.
