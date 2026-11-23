# Architecture

## Components

Corvex runs one process that owns one SQLite database and one Git storage root:

1. **Server** — serves the operations console under `/ops`, authenticates each user through GitLab OAuth2, exposes the HTTP API and health endpoints, and executes conversation turns inline.
2. **SQLite** — the durable store. It holds conversations, messages and turns; per-turn trajectories (`conversation_trace`) and execution records (`execution_steps`); model call metrics and daily token reservations; audit events; runtime settings; model providers and per-user model selections; users and sessions; and cleanup records.
3. **ConversationRunner** — lives inside the Server process. A queued turn is executed immediately, one per conversation at a time. It pins the branch head SHA, reuses that conversation's detached Git worktree, runs one Pi SDK session, streams output to the console, and persists the trajectory and final reply. Startup recovers turns left in flight by a previous process.
4. **GitLab API** — provides project discovery and the destination for the conversation's explicit GitLab write tools. The console's project scope is whatever the signed-in user's GitLab token can see.
5. **OpenAI-compatible model API** — called by the Pi SDK session for each conversation turn.

The agent runtime is `@earendil-works/pi-coding-agent` (Pi SDK). Pi runs the model loop, tools and skills; Corvex owns authorization, state, persistence and GitLab writes.

Clone and web URLs are derived from the configured `gitlab.base_url` plus the project's `path_with_namespace`; GitLab's own `http_url_to_repo`/`web_url` values are ignored because they follow the instance `external_url` and may point at an address Corvex cannot reach. The Git manager still requires the resulting URL to match the configured scheme and host.

GitLab GET requests retry transient network failures and HTTP 408, 425, 429, 500, 502, 503, or 504 responses up to three attempts with bounded backoff. POST writes are never automatically retried because their remote outcome may be uncertain.

Commands are accepted and executed in the same process. There is no separate worker, queue service or split deployment.

## Conversation lifecycle

A conversation binds one repository branch. When a message is queued, the server resolves and pins that branch's head SHA; the turn runs against that exact revision. Turn states are `queued -> running -> completed`, plus `failed`, `stale` and `cancelled`. A branch that moves before a queued turn starts, or a snapshot that no longer matches before a GitLab write, ends the turn as `stale` rather than writing to a moving target.

Each turn keeps its own trajectory and execution records, keyed by its `turn_id`. The console reads the whole conversation through `GET /api/ops/conversations/<id>/turns`, which merges every turn into one timeline, or a single turn through `GET /api/ops/conversations/<id>/turns/<turnId>`, which verifies the turn belongs to that conversation. `GET /api/ops/conversations/<id>/stats` aggregates usage and timing. The detail response (`GET /api/ops/conversations/<id>`) also derives the conversation's system prompt so the Chat tab can show it above the transcript.

While a turn runs, `GET /api/ops/conversations/<id>/turns/<turnId>/stream` serves its output as Server-Sent Events: cumulative assistant text (`text`), thinking (`thinking`), tool executions (`tool`), context compaction/trimming notices (`context`) with bounded before/after snapshots, an `interjection` notice when the user supplements the running turn, and a final `done` status. A message sent to `POST /api/ops/conversations/<id>/messages` during a running turn is routed through `SteerChannel` to the Pi SDK's `session.steer`, so it reaches the model before its next call without a new turn or a new SHA snapshot; if the turn already settled it falls back to an ordinary queued turn. The same endpoint also accepts `delivery: "queue"` for a durable, reorderable FIFO (`conversation_followups`) that the Runner drains after the turn settles with a freshly resolved branch SHA, and `delivery: "interrupt"` to abort the turn, wait for its partial changes to land, then start a new turn. The composer exposes all three alongside Stop. The stream is display-only — it never writes to SQLite — and closes as soon as the answer is persisted; polling remains the fallback when the connection drops. Thinking, intermediate replies and tool calls are also folded into a redacted, size-capped process snapshot on the turn so the process block survives a reload.

The Chat tab renders thinking, tool calls and the final reply as one interleaved timeline. The Activity records tab shows execution records, the Trace tab shows the merged model/tool/context timeline, the Stats tab shows per-turn usage, the Git tab reads the project's commit graph, and a toggled file panel browses the pinned worktree (with a GitLab file fallback). Composer slash commands are turn-local model instructions only: they never create events, change state or publish.

## Worktrees and saved changes

Each conversation keeps one worktree reused across its turns (`workspaces/<projectId>/conversation-<conversationId>`). `ConversationRunner` owns an idle-TTL and least-recently-used cache, released on shutdown and swept on startup; turns are serialized per conversation, which makes reuse safe. `GitManager.prepareConversationWorkspace` re-verifies HEAD for the pinned SHA and only detaches again when the snapshot advanced. Mirrors are fetched lazily: the pinned SHA is checked with `cat-file -e` first and fetched only when missing.

Repository file edits are bounded and worktree-relative. They are committed to `refs/conversations/<id>` in the local project mirror (parented on the pinned SHA) and checked out again when the worktree is prepared, so TTL/LRU eviction, shutdown and startup cleanup cannot lose them. These refs are never pushed to GitLab. A `storage cleanup` run skips conversations with queued or running turns and keeps mirrors for every project referenced by a conversation; orphan refs and unreachable objects are pruned and garbage-collected during retention cleanup. Cleanup runs are recorded in `storage_cleanup_log`. Per-conversation resource cleanup (Git refs/worktree, cached stream state and any plugin-owned resources) is centralized in the `conversationDelete` hook: both DELETE routes and the retention prune fire it with the conversation ID, project ID and turn IDs, default taps release Git resources first and stream state second, and the database row is removed only after every tap succeeds. `AppStore.pruneHistory` returns the pruned targets so retention can fire the hook per conversation instead of only sweeping orphan refs.

## Tools and boundaries

The Pi session receives only the tools a conversation needs. There is no built-in `bash`, `edit` or `write`, and no shell executor by design.

- **File tools** — read-only reads (`read_file`, `git_grep`, `search_text`) and bounded mutations (`write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file`). Repository paths must be worktree-relative; absolute paths are accepted only for trusted Skill roots. Every result is byte-capped.
- **Git tools** — `git_status`, `git_log`, `git_show`, `git_diff`, `git_branches` for inspection; `git_clone`, `git_branch`, `git_checkout`, `git_pull`, `git_merge` for workspace operations; and `git_commit`, `git_push`, `git_revert` for changes. All are bound to the conversation's worktree and local mirror: no arbitrary URL or remote, no force option, and push writes only `refs/conversations/<id>`.
- **GitLab tools** — discovery and reads (project info, issues, merge requests, changes, commits, discussions) plus issue and merge-request lifecycle and note tools. Every tool is fixed to the conversation's project; identifiers must come from the user or a read result; write tools require explicit user intent and describe irreversible or public actions (delete, merge, approve) in their descriptions.

Skills are instructions, not an access-control boundary. `web_fetch`, when enabled, is read-only and blocks private/reserved addresses; page text is untrusted model input. `web_search` uses Tavily's free keyless mode (no API key): each query is sent to Tavily, the shared allowance is rate-limited and rate limits are returned to the model as a notice rather than failing the turn. Result links pass the same URL validation as `web_fetch`, snippets are size-capped, and the count of searches per turn is configurable. Search results are untrusted third-party text. Agent output is always untrusted: Corvex validates tool arguments and re-checks authorization and the pinned revision before any GitLab write.

## Context budgets

Corvex keeps a conversation inside the model's context window instead of letting the provider reject it. Before a request leaves the process, `src/agent/budget.ts` estimates tokens conservatively (the larger of chars/4 and UTF-8 bytes/3, so CJK and dense code are not undercounted) and `trimHistory` keeps only the newest earlier turns that fit `agent.history_token_budget` and the remaining `agent.max_input_tokens`; the dropped turns are compressed into a persisted rolling summary (`summary_enabled`) that later turns reuse, summarized in budget-sized chunks so the summary request cannot overflow on a long conversation. The request is built as structured messages rather than one concatenated blob.

Within a turn, tool results are truncated deterministically before they enter session history: `src/agent/tool-budget.ts` caps each call and each assistant round and leaves a marker telling the model to continue with a narrower path or line range. That hard cap matters because the SDK anchors its estimate on the last provider usage and can only estimate what was added since; an unbounded tool result could cross the window before the next compaction check. `agent.turn_tool_result_bytes` stays a soft checkpoint that asks the model to record progress and use targeted reads; the runtime caps it at four tool-output rounds so it fires before compaction. Context growth is absorbed by SDK compaction (the Pi session gets the same `agent.context_window` and compaction thresholds through an in-memory settings manager), and the reserve is raised to cover the worst-case token growth of one tool-output round plus `max_output_tokens`. Compaction start and end produce `kind='context'` trace entries and console notices, with bounded snapshots of the messages summarised and the resulting summary.

If the provider still reports an overflow (`context length exceeded` and similar), `isContextOverflowError` recognizes it and one more aggressive retry drops the history entirely. With `agent.auto_context_tune` enabled, a recognized overflow lowers the effective context window only for that session's retry; the stored model configuration is unchanged.

These keys, the active model and the response language are editable at runtime from the console Settings page. The Server validates them against the same definitions it uses for the config file, stores the overridden keys with the operator and timestamp, records an `update_settings` audit entry, and reapplies them at startup. The page returns an `effective` map computed with the same resolve functions as the runtime, so an entered value overridden by a safe floor is shown as such instead of looking ignored.

## Persistence and retention

SQLite uses WAL mode, a single open connection, and a 5-second busy timeout. Keep the database on persistent writable storage. Daily cleanup removes terminal conversation turns, their trace and execution records, cleanup logs and daily token usage according to `storage.retention_days`; audit records use `storage.audit_retention_days`. Conversations idle for longer than the retention window are deleted with their messages and turns, while a conversation with a queued or running turn is kept. Trajectory data is redacted and size-capped in `src/store.ts`, but it intentionally retains model prompts, tool arguments and outputs so the console can render a complete session; it may contain repository source or other sensitive content and should be treated as confidential. Git mirrors and worktrees live under `storage.root` and need separate capacity monitoring.

## Security boundaries and limitations

- Authorization lives in Corvex code: GitLab OAuth2 login, per-user GitLab tokens for console calls, and explicit user intent for every GitLab write. The console's project scope comes from the logged-in user's GitLab token, not a static allowlist.
- Every GitLab API and Git network call uses the signed-in user's OAuth token; the service has no shared read/write PAT. Grants come from that user's GitLab permissions.
- Every turn pins the branch head SHA and re-verifies it before worktree preparation and GitLab writes. Repository content, filenames and model output are untrusted; validation is not a substitute for human review.
- There is no shell, test runner or automatic application of changes to a GitLab branch. Model prompts may contain source code; review the model provider's data handling and your organization's policies before enabling it.
- The service implements no webhook surface: it does not accept Note Hooks, push hooks or merge-request lifecycle events.

## Deferred features

GitLab webhook-driven task events (`review`, `chat`, `explain`, `fix`, `implement`), their command layer, event state machine, event admin pages and event metrics have been removed in full and are recorded as deferred work in [ROADMAP.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.md). They are not part of the current runtime, configuration or HTTP API.
