# Getting started

Corvex is a self-hosted agent for GitLab repositories. It runs as a single process:

- **Server** serves the operations console, authenticates each user through GitLab OAuth2, exposes the HTTP API and health endpoints, and executes conversation turns inline.
- **ConversationRunner** pins the branch head SHA at the start of each turn, reuses that conversation's detached Git worktree, runs one Pi SDK session, streams its output to the console, and persists the trajectory and final reply.

Persistent conversations are the only execution path. See [Architecture](./architecture), [Configuration reference](./configuration) and [Runtime and operations](./operations) for details.

## Requirements

- Node.js 26.12.1 and pnpm 12.4.1 to run from source. Install the locked dependencies with `pnpm install --frozen-lockfile`.
- A GitLab instance and an OAuth2 application so users can sign in to the console. Each user only sees projects visible to their own GitLab account.
- GitLab OAuth2 credentials for console sign-in. All GitLab API and Git network operations run as the signed-in user, using that user's token; the service has no shared PAT.
- The `git` executable on the Server host. The supplied Docker image includes it.
- An OpenAI-compatible Chat Completions endpoint and an API key for a provider that needs one. Pi SDK provides the agent runtime; model providers and keys are managed in the console.
- Persistent writable storage for the SQLite database, Git mirrors and conversation worktrees. Keep it across restarts.
- No inbound webhook URL is needed.

## 1. Prepare configuration and secrets

Build the CLI and initialize a configuration template:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

Copy `configs/config.example.yaml` to `configs/config.yaml`. The template is intentionally small: it contains only the listener and storage paths. The GitLab base URL, OAuth application, model providers, budgets, tool switches and retention values are managed in the console and stored in SQLite; the config file supplies their initial values only.

```sh
# Optional startup fallback; the effective value comes from console Settings.
# CORVEX_GITLAB_BASE_URL=https://gitlab.example.com
```

No GitLab PAT, OAuth credentials or model API key are required at startup. GitLab access is always performed with the token of the user signed in to the console, so permissions are exactly that user's GitLab permissions. Refer to the [configuration reference](./configuration) for every setting and its limits.

## 2. Start the server

```sh
pnpm start -- --config configs/config.yaml check-config
pnpm start -- --config configs/config.yaml server
```

`server` is the only runtime mode: it serves HTTP and runs conversations inline in the same process. The default listener is `0.0.0.0:8080`. Put it behind HTTPS when exposing it to users; do not expose the service directly to an untrusted network without appropriate network controls.

## 3. Sign in and configure GitLab OAuth

Open the console at `/ops`. On a fresh installation it redirects to `/setup`, where you enter the GitLab instance URL plus the OAuth application's client ID, client secret and callback URL. These values are stored in SQLite, not in environment variables, and can later be edited in the admin **Settings** page. The callback URL must point back to the console (for example `https://corvex.example.com/auth/gitlab/callback`).

After setup, sign in with **GitLab OAuth2**. Corvex stores each user's encrypted token in SQLite and uses it for that user's console API calls. The project picker lists only projects visible to the signed-in user, so there is no static project allowlist to maintain.

## 4. Start a conversation

The console opens on **Conversations**. Use the repository and branch pickers to start one: search projects by full path, then pick a branch. The server resolves and pins that branch's head SHA when a message is queued; conversations and their turns are stored in SQLite and one turn per conversation can run at a time.

The workspace fills the viewport and offers several views:

- **Chat** — the Markdown transcript. Assistant replies fill in token by token while a turn runs, with the model's thinking and each tool call shown separately in a process block above the final reply. The conversation's system prompt appears as a collapsible block above the transcript, and every settled reply shows its copy action, generation speed, duration and producing model.
- **Activity records** (`records`) — the execution records of the turns in this conversation.
- **Trace** — one merged timeline of every turn's model, tool and context activity, switchable to a single turn. Context compaction and trimming notices carry bounded before/after snapshots.
- **Context** — a per-request inspection: window usage, a composition bar for system / tools / user / injected / assistant / tool-result tokens, a request timeline, a per-item browser with redacted previews and context events. Selecting a request updates every section; collection can be disabled in Settings → Budget.
- **Stats** — model usage and elapsed time for the whole conversation, with a per-turn breakdown.
- **Changes** — bounded per-file diffs of the conversation ref, with a turn filter and inline Monaco diff viewer.
- **Git** — a read-only commit graph of the project mirror, with the pinned SHA and saved conversation commits highlighted, expandable commit details and downloadable patches.
- **File panel** — a toggled side pane that browses the pinned worktree (falling back to GitLab files if the worktree has not been prepared), previews images and opens text files in a read-only code viewer.

The composer completes slash commands (`/review`, `/explain`, `/fix`, `/test`, `/docs`, `/commit`, `/mr`). These are **turn-local instructions to the model only**: they do not create tasks, change conversation state or publish anything to GitLab. A running or queued turn shows a **Stop** button that cancels it. If the branch moves before a queued turn starts, that turn ends as `stale`; send the message again to use the current revision.

## 5. Enable a model

Open **Settings → Model** (admin) to add a provider with its Base URL and API key, then add a model with its context window and max output tokens. The first model added is activated automatically; choosing another applies it to subsequent turns without a restart. Corvex sends requests to the provider's `/chat/completions` endpoint. The API key is never returned by the API or written to audit logs; leaving its password field empty keeps the saved value.

Every user also has a personal **Settings** page (`#/settings`) to add their own providers and models alongside the shared system ones (marked **System**, read-only). Activating a model there changes only that user's conversations.

## What the agent can do

Conversations are uniformly read-write. Every tool is bound to the conversation's project and worktree:

- **Files** — bounded read-only tools (`read_file`, `git_grep`, `search_text`) and bounded write tools (`write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file`). Edits are committed to a per-conversation ref (`refs/conversations/<id>`) in the local mirror, so they survive worktree cleanup; they are never pushed to a GitLab branch.
- **Git** — `git_status`, `git_log`, `git_show`, `git_diff`, `git_branches`, `git_clone`, `git_branch`, `git_checkout`, `git_pull`, `git_merge`, `git_commit`, `git_push`, `git_publish`, `git_push_branch`, `git_rebase`, `git_cherry_pick` and `git_revert`. There is no arbitrary URL, remote or force option. `git_push` writes only `refs/conversations/<id>` in the local mirror; when you explicitly ask to publish the changes to a GitLab branch, `git_publish` saves the changes and fast-forwards the commit to the named branch in one call so the merge request shows a real diff; `git_push_branch` does the push alone when you already know the exact SHA.
- **GitLab** — discovery and reads (project info, issues, merge requests, changes, commits, discussions) plus lifecycle and note tools for issues and merge requests. Write tools require explicit user intent, target the conversation's bound project, and mark irreversible or public actions (delete, merge, approve) in their descriptions.

There is no built-in shell, and Corvex never executes repository code, scripts or tests. `web_fetch`, enabled by default, is read-only and limited to public HTTP(S) hosts with private/reserved addresses always blocked. `web_search`, also on by default, uses Tavily's free keyless mode — no API key to configure, but queries are sent to Tavily and the shared allowance is rate-limited; it can be switched off in Settings. Skills are trusted instruction directories, not an access-control boundary.

## Deferred features

Webhook-driven task events (`review`, `chat`, `explain`, `fix`, `implement`) have been removed in full. They are recorded in [ROADMAP.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.md) as deferred work; the slash-command suggestions in the composer are turn-local instructions, not those event commands.

## Next steps

- Read [Architecture](./architecture) to understand the turn lifecycle, context budgets and safety boundaries.
- Review every option in the [Configuration reference](./configuration).
- Follow [Runtime and operations](./operations) for Docker Compose, health checks, backups, retention and troubleshooting.
