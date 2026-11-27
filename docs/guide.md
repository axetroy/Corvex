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

The composer completes slash commands from the conversation skills configured by an administrator in **Settings → Skills**. A skill follows the [Agent Skills specification](https://agentskills.io/specification): a name, a description and a Markdown prompt template with optional `$ARGUMENTS`. Typing `/` shows the enabled skills in a scrollable list. The command name is replaced by the skill template before the request is sent, so a bare `/docs` still carries a complete instruction; these are **turn-local instructions to the model only** and never create tasks, change conversation state or publish to GitLab. Bundled files stay verbatim in the skill directory and can be read through `skill://` URIs; `SKILL.md` may live in a subdirectory and is discovered recursively. The model sees a compact `<available_skills>` catalog (name, description and virtual location) and loads a full skill body with `read_file` when relevant — `disable-model-invocation: true` hides it from that catalog, `user-invocable: false` hides it from the `/` menu. Personal skills live in the front-end **User settings** page (not the admin Settings): only you can see and edit them; on a name collision the global skill wins and yours stays available as `me:<name>` (`/me:<name>`). To import skills, choose **Import skills** in either the admin Skills page or User settings: upload a ZIP (max 10 MiB), or point at a GitHub repository, a GitLab project (using your signed-in token), or a direct HTTPS ZIP URL. A preview lists every skill found in the source with all of them checked by default; uncheck the ones you do not want and confirm. Only the selected skills are written to disk; each keeps its source and content hash in the local lock file for later verification and offline restore. A running or queued turn shows a **Stop** button that cancels it. The composer footer also has a per-user reasoning-level selector beside the model picker (`off` through `max`); it applies to the next turn and is disabled when an administrator turns reasoning off globally. Below the composer a compact context brief shows the latest request's window usage and token count; click it to open the **Context** tab. If the branch moves before a queued turn starts, that turn ends as `stale`; send the message again to use the current revision.

## 5. Enable a model

Open **Settings → Model** (admin) to add a provider with its Base URL and API key, then add a model with its context window and max output tokens. The first model added is activated automatically; choosing another applies it to subsequent turns without a restart. Corvex sends requests to the provider's `/chat/completions` endpoint. The API key is never returned by the API or written to audit logs; leaving its password field empty keeps the saved value.

Every user also has a personal **Settings** page (`#/settings`) to add their own providers and models alongside the shared system ones (marked **System**, read-only). Activating a model there changes only that user's conversations.

## What the agent can do

Conversations are uniformly read-write. Every tool is bound to the conversation's project and worktree:

- **Files** — bounded read-only tools (`read_file`, `read_dir`, `tree`, `glob`, `stat`, `git_grep`, `search_text`) and bounded write tools (`write_file`, `edit_file`, `delete_file`, `move_file`, `copy_file`). Edits are committed to a per-conversation ref (`refs/conversations/<id>`) in the local mirror, so they survive worktree cleanup; they are never pushed to a GitLab branch.
- **Git** — `git_status`, `git_log`, `git_show`, `git_diff`, `git_branches`, `git_clone`, `git_branch`, `git_checkout`, `git_pull`, `git_sync`, `git_merge`, `git_commit`, `git_push`, `git_publish`, `git_push_branch`, `git_rebase`, `git_cherry_pick` and `git_revert`. There is no arbitrary URL, remote or force option. `git_push` writes only `refs/conversations/<id>` in the local mirror; when you explicitly ask to publish the changes to a GitLab branch, `git_publish` saves the changes and fast-forwards the commit to the named branch in one call so the merge request shows a real diff; `git_push_branch` does the push alone when you already know the exact SHA. Saving changes detaches the worktree HEAD at the saved commit, so `git_rebase` / `git_merge` see a clean worktree; rebase/merge results are saved back to the conversation ref at the end of the turn. The branch snapshot captured when a turn is queued only guards against stale turns; the baseline for unpublished changes is separate and advances only after a successful publish to the conversation's target branch. A local commit alone remains an unpublished change shown in Changes; publishing clears that list and lets you edit and publish again in the same turn without a manual rebase. If a push is rejected as non-fast-forward, the agent recovers with `git_sync` → `git_pull` → `git_rebase` onto `origin/<branch>` and never force-pushes; Git tool calls are capped per turn (`agent.git_tool_call_limit`) so a failed-command loop stops and reports instead of repeating. After the first publish to a feature branch the system reuses or creates an MR (`agent.auto_create_merge_request`); a stale turn records the exact commit and author that moved the branch in its context trace.
- **GitLab** — discovery and reads (project info, issues, merge requests, changes, commits, discussions) plus lifecycle and note tools for issues and merge requests. Write tools require explicit user intent, target the conversation's bound project, and mark irreversible or public actions (delete, merge, approve) in their descriptions.

When execution is enabled in **Settings → Execution**, conversations also get `run_command`: free commands run in the pinned worktree through the configured backend (a container sandbox in production, a local backend for development), bounded by command length, timeout and output limits. The Chat process block shows a live terminal and lets you stop a single command without cancelling the turn. Skills can also declare fixed commands in `corvex-commands` frontmatter metadata; once enabled with `corvex-commands-enabled`, the model can call them through `run_skill_command`, which executes the declared string through the same backend with the same limits, redaction and terminal display. The model cannot supply the command text or interpolate user input into it. `web_fetch`, enabled by default, is read-only and limited to public HTTP(S) hosts with private/reserved addresses always blocked. `web_search`, also on by default, uses several free backends ranked by a composite health score (keyless backends need no API key, optional keys raise the quota); queries are sent to the selected engine and rate-limited backends cool down. It can be switched off in Settings → Search, where the backend order and API keys are also managed. Skills are trusted instruction directories, not an access-control boundary.

## Deferred features

Webhook-driven task events (`review`, `chat`, `explain`, `fix`, `implement`) have been removed in full. They are recorded in [ROADMAP.md](https://github.com/axetroy/Corvex/blob/main/ROADMAP.md) as deferred work; the slash-command suggestions in the composer are turn-local instructions, not those event commands.

## Next steps

- Read [Architecture](./architecture) to understand the turn lifecycle, context budgets and safety boundaries.
- Review every option in the [Configuration reference](./configuration).
- Follow [Runtime and operations](./operations) for Docker Compose, health checks, backups, retention and troubleshooting.
