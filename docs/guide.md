# Getting started

Corvex is a self-hosted code review and repair agent for GitLab merge requests. It has two processes:

- **Server** receives GitLab Note Hook events, checks access, writes tasks to SQLite, and replies to the note.
- **Worker** polls SQLite, reads the exact merge request revision, calls an OpenAI-compatible model when needed, and publishes the result.

The server can run without a worker, but review, explain, fix, and Issue assistant tasks remain queued until a worker is running. See [Architecture and workflow](./architecture), [Configuration reference](./configuration), and [Runtime and operations](./operations) for details.

## Requirements

- Node.js 26.12.1 and pnpm 12.4.1 to run from source. Install the locked dependencies with `pnpm install --frozen-lockfile`.
- GitLab access from the server and worker, including a reachable webhook URL.
- A GitLab read token for API reads and repository fetches; a separate write token for MR notes and discussions.
- The `git` executable on the worker host. The supplied Docker image includes it.
- If using an agent, an OpenAI-compatible Chat Completions endpoint and an API key. Pi SDK provides the agent runtime.
- Persistent writable storage for the SQLite database and Git mirrors. Keep it across restarts.

## 1. Prepare configuration and secrets

Build the CLI and initialize a configuration template:

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start -- init
```

Edit `configs/config.yaml` to set the GitLab URL and project allowlist. Add numeric user IDs to `gitlab.blocked_user_ids` only when you want to prevent them from invoking commands. Set these variables for the Server:

```sh
export CORVEX_GITLAB_TOKEN='your-write-token'
export CORVEX_WEBHOOK_SECRET='a-long-random-secret'
```

The IDs are numeric GitLab IDs. Both allowlists must be non-empty; empty lists do not mean “allow everyone.” Keep credentials out of the YAML file and source control. Refer to the [configuration reference](./configuration) for every setting and its limits.

The Server only needs the write token and webhook secret. The Worker additionally needs `CORVEX_GITLAB_READ_TOKEN` and, when the agent is enabled, `CORVEX_MODEL_API_KEY`. The read token is used for project/MR API reads and repository fetches; use separate read/write tokens with only the required permissions.

## 2. Start the server

```sh
pnpm start -- --config configs/config.yaml check-config
pnpm start -- --config configs/config.yaml server
```

The default listener is `0.0.0.0:8080`. Put it behind HTTPS when exposing it to GitLab; do not expose the service directly to an untrusted network without appropriate network controls.

## 3. Configure the GitLab webhook

Create a project webhook whose URL is:

```text
https://corvex.example.com/webhooks/gitlab
```

Use the same value as `CORVEX_WEBHOOK_SECRET` for the webhook secret token. Enable **Comments** (Note events); the endpoint processes comments on merge requests and Issues. It does not process merge-request state events or push events. Keep SSL verification enabled.

The optional `scripts/register-webhook.sh` helper creates or updates the project hook idempotently. It requires `curl`, `jq`, and a GitLab administrator token used only for registration:

```sh
GITLAB_URL=https://gitlab.example.com \
GITLAB_ADMIN_TOKEN=... \
GITLAB_PROJECT_ID=101 \
CORVEX_WEBHOOK_URL=https://corvex.example.com/webhooks/gitlab \
CORVEX_WEBHOOK_SECRET=... \
./scripts/register-webhook.sh
```

The runtime service does not need the administrator token.

## 4. Use the bot on GitLab

Mention the configured GitLab bot account. The username comes from `gitlab.bot_username` (for example, `corvex-bot`).

### Merge request commands

Use these commands in a merge request comment:

| Command | Behavior |
|---|---|
| `@corvex-bot /review [request]` | Queue a review of the current merge request revision, optionally with supplemental instructions or examples. |
| `@corvex-bot <message>` | Chat about the current merge request, such as summarizing its changes or suggesting a title. |
| `@corvex-bot /explain path/to/file.ts` | Explain a file at the pinned merge request Head SHA. |
| `@corvex-bot /status` | Show the latest task state for the merge request. |
| `@corvex-bot /cancel` | Cancel a queued task or request cancellation of an active task you started. |
| `@corvex-bot /fix Make this error easier to handle` | Request a bounded fix proposal, if fix mode is enabled and you are not blocked. |

`/review` accepts an optional supplemental request of up to 2,000 characters. Its line breaks, indentation, and repeated spaces are preserved, so it can include multi-line examples. Plain-text MR mentions also accept up to 2,000 characters and use the pinned MR metadata, diff, and recent comments as chat context. The default is 20 comments; configure `chat.history_comments` from 0 to 50. Chat can also read more recent comments from the current MR on demand. `/status` and `/cancel` take no arguments. `/explain` takes one path; `/fix` takes an optional natural-language request. Any commenter in a project listed in `gitlab.allowed_project_ids` can invoke commands unless their ID is in `gitlab.blocked_user_ids`.

### Issue mentions

Plain-text mentions in an Issue start an assistant task. The agent can answer, ask for clarification, or propose implementation using the Issue and recent comments:

| Mention | Behavior |
|---|---|
| `@corvex-bot Is this change feasible?` | Ask for analysis or clarification; the agent replies without changing code. |
| `@corvex-bot Add the requested validation` | Let the agent decide whether to reply or propose implementation. Code writes require Issue implementation to be enabled. |
| `@corvex-bot /implement Add the requested validation` | Explicitly request implementation; code writes still require Issue implementation to be enabled. |

Any commenter in an allowed project can mention the bot unless their ID is in `gitlab.blocked_user_ids`.

## 5. Enable model tasks

Reviews, explanations, fix proposals, and Issue assistance require a worker and a model configuration. Set `agent.enabled: true`, configure `agent.base_url` and `agent.model`, and provide `CORVEX_MODEL_API_KEY`. The base URL is the API root; Corvex sends requests to its `/chat/completions` endpoint.

## Issue assistance and implementation

Issue mentions require the agent to be enabled. The agent receives the Issue and the latest 20 non-system comments by default; configure `issue.history_comments` from 0 to 50. It decides whether to answer, ask a clarifying question, or propose implementation. Replies do not create or push code.

Code writes are disabled by default. To allow implementation, set `issue.implement_enabled: true` and provide a GitLab write token with permission to push branches and create merge requests. The worker targets the project's default branch unless the current request explicitly names another existing branch; comments cannot select a branch. It creates a new `corvex/issue-*` branch and opens a Draft MR. It does not run repository scripts, tests, or automatically merge. Review the resulting MR before merging.

In another process, start:

```sh
pnpm start -- --config configs/config.yaml --for worker check-config
pnpm start -- --config configs/config.yaml worker
```

When the agent is disabled, the server can still accept events and persist tasks, but a worker will refuse to start. For local-only server testing, use the health endpoints described in [Runtime and operations](./operations).

## Enable fix proposals carefully

Fix mode is disabled by default. To enable it, set `fix.enabled: true` and enable the agent. Any non-blocked commenter in an allowed project can then request a proposal. The model can propose a patch only for changed text files in the MR diff. Corvex validates and applies that patch in a disposable isolated worktree, then posts it for a human to review and apply. It does **not** run repository code or tests, create a commit, or push changes. A proposal is not evidence that the project tests pass.

The Pi session exposes no built-in shell or arbitrary command execution. Its repository tools include bounded `read_file` and `git_grep`, plus chat-only `git_log` and `git_show` for commits reachable from the pinned MR HEAD. Chat provides `update_mr_metadata` to change only the current MR's title and/or description when requested; omitted fields stay unchanged. With a write token and a same-project MR, Chat also provides `git_status`, `git_apply_patch`, `git_commit`, `git_push`, and `git_revert`, all bound to the current isolated worktree and MR source branch. Writes require no extra confirmation after the user requested them. Patches modify existing tracked regular files only; commits accept unstaged tracked modifications only; after all requested edits and available checks, Chat creates one final commit and pushes as the last repository operation before replying. It does not push intermediate work or modify files after pushing. Pushes are ordinary fast-forward updates and force-push is never possible; rollback adds a revert commit for the latest Corvex commit. Fork MRs do not receive Git write tools. Literal `search_text` remains available for bounded searches in the worktree and trusted skill roots; it is limited to 1,000 files, 16 MiB, and 50 matches per call. `web_fetch` is available only to review and explain tasks when enabled; private/reserved addresses are always blocked, `agent.web_blocked_hosts` adds optional host blocks, and at most 10 pages can be fetched per session. Redirects are revalidated and page text is untrusted input. Skills are loaded from `agent.skill_paths`. MCP is disabled by default; enabling `agent.mcp_enabled` loads MCP tools only for review tasks from the service's Pi agent directory. MCP server processes run with the worker's OS permissions; use only administrator-controlled configurations and do not treat MCP as a sandbox.

## Next steps

- Read [Architecture and workflow](./architecture) to understand task processing, retries, and safety boundaries.
- Review every option in the [Configuration reference](./configuration).
- Follow [Runtime and operations](./operations) for Docker Compose, health checks, backups, retention, and troubleshooting.
