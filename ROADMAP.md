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

### P0 — Tool loop detection and recovery (in progress)

Mainstream agents detect when the model repeats the same tool call with the same arguments, stops making progress, or fails the same way repeatedly, and steer or stop it. Corvex only has narrow guards: a 40-call Git budget, a five-read hint for `read_file`, and a response-stall watchdog. A previous session still produced 253 turns re-reading the same files. Plan: record a bounded signature of `(toolName, normalized args)` per turn, inject a localized "you have repeated this N times — change strategy or report" context notice at a threshold, count repeats toward the turn's tool budget, and mark repeated identical failures as exhausted.

### P0 — Live plan state machine (in progress)

`record_plan` currently stores an immutable text list in the process snapshot; the model cannot update a step's status and a resumed turn does not know its progress. Mainstream agents keep a persisted checklist with `pending / in_progress / completed` states, updated across turns and reflected in the UI. Plan: evolve `record_plan` into a persisted task list with per-step status, allow status-only updates, restore it on resume, and render progress in the console.

### P1 — Task-level round/token budget with forced wrap-up

There is a daily token budget but no per-task round or token ceiling that forces a structured wrap-up when crossed. Add a configurable per-task ceiling that injects a "you must finish and report now" notice before the turn runs away.

### P1 — Completion verification

A turn ends as `completed` when the model says it is done. Combined with `src/agent/claim-verification.ts`, claims such as "fixed / completed / published" should be checked against the turn's tool trace, and "done" should require at least one read-back or diff verification of the changed files.

### P2 — Verification sandbox

The largest structural gap: Corvex has no shell and never executes repository code (`design.md` non-goal), so it cannot close the edit → test → fix loop that mainstream agents rely on. Adding a read-only command allowlist (for example `tsc --noEmit` or a test runner) inside an isolated sandbox requires a separate authorization model and is deferred.

### P2 — Sub-agents / parallel research

Long tasks benefit from lightweight read-only sub-agents that investigate in parallel and return bounded findings, keeping the main session's context clean. Corvex runs one session per turn; delegation is deferred.

## Other deferred items

No other items are currently recorded.
