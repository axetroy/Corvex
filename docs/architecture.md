# Architecture and workflow

## Components

Corvex separates the request path from model and repository work:

1. **Server** exposes an HTTP webhook and operational endpoints. It validates Note Hook requests, applies allowlists, records events and jobs in SQLite, and replies to GitLab.
2. **SQLite** is the durable queue and state store. It records jobs, webhook idempotency/delivery, attempts, audit events, model call metrics, and optional daily token reservations.
3. **Worker** polls the database, claims a job under a renewable lease, fetches the merge request snapshot and repository, and runs the requested workflow. A worker requires `agent.enabled: true`.
4. **GitLab API** provides project/MR metadata, paginated diffs, and the destination for notes and discussions.
5. **OpenAI-compatible model API** is called only by the worker for review, explanation, or fix proposal tasks.

The server can run without a worker: commands are accepted and persisted, but model tasks remain queued. In a split deployment the server and worker must use the same SQLite database and persistent Git storage root.

## Request and queue workflow

1. GitLab sends a `Note Hook` to `POST /webhooks/gitlab`.
2. The server compares `X-Gitlab-Token` to the configured webhook secret using a constant-time comparison. It accepts merge-request notes only, limits the body to 1 MiB, and ignores system notes and notes authored by the configured bot username.
3. Project and user IDs are checked against explicit allowlists. Notes that do not start with `@corvex` are acknowledged without creating work.
4. Supported commands are parsed. The event, response-delivery state, audit event, and (for asynchronous work) job are written transactionally to SQLite. Duplicate webhook deliveries are idempotent.
5. The server posts an immediate acknowledgement or validation response to the MR using the GitLab write token. Model inference does not run in the webhook request.
6. A worker claims queued review, explain, or fix jobs in creation order. It updates job status and attempt records while holding a renewable 30-second lease.

The currently supported commands are `review`, `explain <path>`, `fix [request]`, `status`, and `cancel`. See [Getting started](./guide) for examples.

## Review workflow

1. Fetch the MR and check that it is open and still has the Head SHA captured when the request was queued. A closed or changed MR is marked stale rather than reviewed at a moving revision.
2. Update or create a per-project Git mirror, then create an isolated detached worktree at the exact Head SHA. The worker obtains the diff against the MR Base SHA and enforces the configured file and byte limits.
3. Send bounded MR metadata and diff context to the configured model endpoint. Corvex expects one structured JSON response.
4. Validate the response before publishing: findings must refer to an exact changed path and added line, include evidence found literally on that line, use a supported severity, pass size limits, and not duplicate an existing finding fingerprint. Unsupported findings are discarded.
5. Fetch the MR again. If its state or relevant diff SHAs changed while the model was running, mark the job stale and do not publish its result.
6. Publish supported findings as line discussions. If GitLab rejects an inline position, include that finding in the summary note instead. Clean up the worktree.

The model is not told that tests were run; Corvex does not execute project tests or repository scripts.

## Explain and fix workflows

**Explain** reads the requested file from the pinned MR Head SHA, not from an arbitrary path on the server. Workspace containment and configured context limits are enforced. The file and MR metadata are sent to the model, then the explanation is published as an MR note only if the MR snapshot is still current.

**Fix** is disabled by default and has a separate `fix.allowed_user_ids` allowlist. The requester must also be on the general GitLab user allowlist. The worker sends the bounded MR diff and optional request to the model, accepts only a structured unified diff, and restricts changes to reviewable files already present in the MR diff. It applies the patch in the isolated worktree and runs `git apply --check` and `git diff --check`. After another MR snapshot check, it posts the proposed patch for a human to inspect and apply.

Fix mode does not execute tests, scripts, hooks, or other repository code. It does not create commits or push to GitLab. A posted patch is a proposal, not a verified change.

## Job states, leases, retries, and cancellation

The main lifecycle is:

```text
queued -> preparing -> analyzing -> publishing -> completed
                              \-> fixing -> verifying -/
```

Jobs can also end as `failed`, `stale`, or `cancelled`. The worker polls at `worker.poll_interval` and bounds a job with `worker.job_timeout`.

The 30-second lease is renewed while a worker is active. If a process disappears before publishing, an expired lease can return the job to the queue; interrupted jobs have at most three attempts. An ordinary processing error is recorded as failed. If the lease expires during publishing, the outcome may be uncertain, so Corvex fails the job rather than automatically retrying and potentially duplicating comments.

`@corvex status` reports the latest task on the MR. `@corvex cancel` immediately cancels a queued task or asks the worker to stop an active task. Only the task requester can cancel it. Cancellation is not available after the task has entered publishing, where GitLab may already have accepted a comment.

## Persistence and retention

SQLite uses WAL mode, a single open connection, and a 5-second busy timeout. Keep the database on persistent writable storage. Daily cleanup removes old terminal jobs, their attempts, webhook event records, and token usage according to `storage.retention_days`; audit records use `storage.audit_retention_days`. Queued and in-progress jobs are retained. Git mirrors and worktrees are stored separately under `storage.root` and require their own capacity monitoring.

## Security boundaries and limitations

- The webhook secret authenticates GitLab deliveries; project and user allowlists restrict which events and users can request work.
- Use a read token for API/repository reads and a separate write token for MR comments. Do not give the service the administrator token used by the optional hook-registration script.
- Repository content, comments, filenames, and fix instructions are untrusted model input. Model output is validated, but validation is not a substitute for human review.
- Model prompts may contain source code and MR text. Review the model provider's data handling and your organization's policies before enabling it.
- The worker does not run untrusted repository code. There is no test runner or automatic patch application to the target branch.
- The HTTP service implements GitLab merge-request Note Hooks, not push hooks or merge-request lifecycle events.
