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

## Other deferred items

No other items are currently recorded.
