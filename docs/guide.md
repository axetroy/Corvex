# Getting started

Corvex is a self-hosted code review and repair agent for GitLab merge requests. It has two processes:

- **Server** receives GitLab Note Hook events, checks access, writes tasks to SQLite, and replies to the note.
- **Worker** polls SQLite, reads the exact merge request revision, calls an OpenAI-compatible model when needed, and publishes the result.

The server can run without a worker, but review, explain, and fix tasks remain queued until a worker is running. See [Architecture and workflow](./architecture), [Configuration reference](./configuration), and [Runtime and operations](./operations) for details.

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

Edit `configs/config.yaml` to set the GitLab URL and explicit project/user allowlists. Set these variables for the Server:

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

Use the same value as `CORVEX_WEBHOOK_SECRET` for the webhook secret token. Enable **Comments** (Note events); the current endpoint processes comments on merge requests only. It does not process merge-request state events or push events. Keep SSL verification enabled.

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

## 4. Use commands in a merge request

Commands must start with `@corvex` as the first token in a merge request comment:

| Command | Behavior |
|---|---|
| `@corvex review` | Queue a review of the current merge request revision. |
| `@corvex explain path/to/file.ts` | Explain a file at the pinned merge request Head SHA. |
| `@corvex status` | Show the latest task state for the merge request. |
| `@corvex cancel` | Cancel a queued task or request cancellation of an active task you started. |
| `@corvex fix Make this error easier to handle` | Request a bounded fix proposal, if fix mode is enabled and you are allowlisted. |

`review`, `status`, and `cancel` take no arguments. `explain` takes one path; `fix` takes an optional natural-language request. The sender must be in `gitlab.allowed_user_ids`, and the project must be in `gitlab.allowed_project_ids`. For `fix`, the sender must also be in `fix.allowed_user_ids`.

## 5. Enable model tasks

Reviews, explanations, and fix proposals require a worker and a model configuration. Set `agent.enabled: true`, configure `agent.base_url` and `agent.model`, and provide `CORVEX_MODEL_API_KEY`. The base URL is the API root; Corvex sends requests to its `/chat/completions` endpoint.

In another process, start:

```sh
pnpm start -- --config configs/config.yaml --for worker check-config
pnpm start -- --config configs/config.yaml worker
```

When the agent is disabled, the server can still accept events and persist tasks, but a worker will refuse to start. For local-only server testing, use the health endpoints described in [Runtime and operations](./operations).

## Enable fix proposals carefully

Fix mode is disabled by default. To enable it, set `fix.enabled: true`, enable the agent, and populate `fix.allowed_user_ids`. The model can propose a patch only for changed text files in the MR diff. Corvex validates and applies that patch in a disposable isolated worktree, then posts it for a human to review and apply. It does **not** run repository code or tests, create a commit, or push changes. A proposal is not evidence that the project tests pass.

The Pi session exposes no built-in shell, edit, or write tools. Its custom `read_file` tool is read-only, restricted to the pinned worktree and configured trusted skill directories, and limited to 64 KiB per file. Skills are loaded from `agent.skill_paths`. MCP is disabled by default; enabling `agent.mcp_enabled` loads MCP servers from the service's Pi agent directory. MCP server processes run with the worker's OS permissions; use only administrator-controlled configurations and do not treat MCP as a sandbox.

## Next steps

- Read [Architecture and workflow](./architecture) to understand task processing, retries, and safety boundaries.
- Review every option in the [Configuration reference](./configuration).
- Follow [Runtime and operations](./operations) for Docker Compose, health checks, backups, retention, and troubleshooting.
