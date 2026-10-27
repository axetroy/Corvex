# Corvex Architecture

## Status and decision

**Target and implementation: one TypeScript application powered by the Pi TypeScript SDK.**
Preserve the existing user-visible behavior and security boundaries without
retaining artifacts from the superseded runtime.

Corvex is a self-hosted GitLab merge-request review and repair assistant. Users
trigger `review`, `explain <path>`, `fix`, `status`, and `cancel` by mentioning
`@corvex` in a GitLab MR note. The system authenticates and authorizes the
request, persists it, analyzes the exact MR revision, validates the result, and
publishes it back to GitLab.

## Goals and non-goals

### Goals

- Use Pi for the agent loop, model/session lifecycle, custom tools, Skills, and
  optional MCP integrations instead of reimplementing those runtime features.
- Keep the product deployable as one Node.js application, with `server` and
  `worker` process modes and shared SQLite/Git storage.
- Preserve durable jobs, webhook idempotency, leases, cancellation, retry
  policy, auditing, token accounting, and observability.
- Pin all repository analysis to the MR's exact base/head SHAs and isolate each
  job in its own detached Git worktree.
- Keep authorization, result validation, patch scope checks, and publication
  decisions in trusted Corvex code, outside the agent's authority.
- Keep repository code, GitLab credentials, model credentials, and agent tools
  within the configured self-hosted deployment boundary.

### Non-goals

- A second control-plane runtime with a TypeScript/Pi sidecar.
- Giving the model unrestricted shell, filesystem, network, GitLab, or MCP
  access.
- Running repository scripts, committing changes, pushing branches, or merging
  MRs as part of the current fix proposal workflow.
- Treating Pi project trust or prompt instructions as a sandbox.
- Replacing SQLite or introducing distributed infrastructure before single-host
  deployment requires it.

## Target architecture

```text
GitLab Note Hook
       |
       v
TypeScript server
  - validate webhook token and event
  - filter bot/system notes
  - enforce project/user allowlists
  - parse commands and persist idempotent jobs
  - health, readiness, metrics, retention
       |
       v
SQLite task store <----- TypeScript worker
                         - lease, heartbeat, cancellation, retry
                         - fetch current MR and pinned diff
                         - prepare isolated detached worktree
                         - invoke Pi SDK with job-scoped tools
                         - validate output and re-check MR revision
                         - apply/check bounded patch when authorized
                         - publish findings/summary through GitLab API
```

Server and worker are modes of the same TypeScript entry point, not separate
services. They may run in separate containers/processes for isolation while
using the same local SQLite database and storage volume. SQLite data must not
be shared across hosts on a network filesystem.

### Responsibility boundaries

| Area | Owner |
|---|---|
| Webhook verification, command parsing, allowlists, fix authorization | Corvex policy code |
| Durable jobs, idempotency, leases, transitions, retries, cancellation | Corvex SQLite store and worker |
| GitLab API access and comment publication | Corvex GitLab client |
| Mirror, exact-SHA worktree, bounded diff and safe file access | Corvex Git engine |
| Agent loop, model providers, session/context lifecycle | Pi SDK |
| Skills, custom agent tools, optional MCP integrations | Pi resources/extensions, explicitly configured by Corvex |
| Finding/patch validation, revision checks, publication decision | Corvex policy code |

Pi is an execution dependency, not the authority for business state. Its
sessions are diagnostic/agent context; the SQLite job record remains
authoritative for job status, retries, audit, cancellation, and publication.
Transient one-job sessions are preferred unless session resumption becomes an
explicit product requirement.

## Pi integration and capabilities

Use `@earendil-works/pi-coding-agent` through its TypeScript SDK in the worker.
Create a separate session for each task with an explicit working directory,
model/runtime settings, resource loader, tools, and cleanup lifecycle.

- Use the Pi loop for multi-step reasoning and tool calls.
- Provide only the tools required by a job. Do not enable built-in `bash`,
  `edit`, or `write` for review or fix proposal jobs.
- Keep custom tools narrow: for example, reading a validated path in the pinned
  worktree and retrieving already-authorized MR metadata. Tool implementations
  must enforce byte limits and path containment themselves.
- Discover Skills from Corvex-managed trusted directories. Skills supply
  instructions, not access control.
- MCP is opt-in per deployment and job type. Register Pi's MCP extension
  explicitly in the SDK resource loader; validate server configuration and
  expose only approved servers/tools. Never treat arbitrary MCP tools as safe.
- Return agent output through a strict structured format. Validate findings
  against added diff lines and validate patch paths/content before any local
  application or publication.
- Subscribe to Pi events for logging/metrics, but do not log source code,
  prompts, credentials, or full tool payloads by default.

Pi tools and extensions execute with the operating-system permissions of the
worker. Run the worker as a dedicated low-privilege user, mount only the
required worktree and data, keep credentials narrowly scoped, and apply
container/network restrictions. Prompt injection defenses are useful but are
not a security boundary.

## Security invariants

1. Webhook secrets are compared in constant time. Request bodies are bounded.
2. Empty project/user allowlists are invalid and never mean allow-all.
3. Bot/system notes do not create work. Duplicate webhook events are
   idempotent.
4. Fix requests require the independent fix allowlist and enabled fix mode.
5. A task records a full MR Head SHA; diff retrieval, worktree setup, and
   publication validate the expected snapshot.
6. Repository paths are normalized and confined to the job worktree. Symlinks,
   oversized/binary files, and out-of-scope paths are rejected where relevant.
7. Agent output is untrusted. Findings must cite exact added lines. Fix patches
   are limited to changed paths, size-bounded, and checked by `git apply
   --check` and `git diff --check`.
8. The agent cannot publish directly. Corvex rechecks authorization, job
   cancellation, and MR revision before publishing via a write-scoped token.
9. Publishing is not blindly retried when the external outcome is uncertain.
10. Repository commands/scripts are not executed. Adding an executor requires
    a separate sandbox design and explicit authorization model.

## Job and failure semantics

The lifecycle remains `queued -> preparing -> analyzing -> [fixing ->
verifying] -> publishing -> completed`, with `failed`, `stale`, and `cancelled`
terminal outcomes. State transitions are validated by the store.

Workers claim jobs using renewable leases and check owner cancellation while
running. Work interrupted before publication may be retried within the bounded
attempt limit. A lease expiring during publication fails without automatic
retry to avoid duplicate GitLab comments. The worker always disposes the Pi
session and cleans up its worktree, reporting cleanup errors.

## TypeScript project structure

```text
src/
  cli.ts
  config/
  app/                 # HTTP server and worker lifecycle
  jobs/                # SQLite schema, store, state machine, metrics
  gitlab/              # Webhook parsing, commands, REST client
  git/                 # mirror/worktree/diff/path and patch operations
  agent/               # Pi session factory, events, structured result parsing
  review/
  fix/
  policy/
  observability/
test/
  unit/
  integration/
```

Prefer Node.js built-ins for HTTP, signals, process management, and filesystem
operations. Keep external dependencies limited to Pi, YAML parsing, SQLite,
and test tooling. Runtime packages and lockfile use the repository's existing
npm convention; Node.js is pinned by `engines.node` and CI.

## Configuration and operations

Retain YAML configuration and existing environment variable names for GitLab
tokens, webhook secret, model key/base URL/name, listen address, database path,
and storage root. Validate configuration before opening listeners or workers.
Keep secrets out of YAML examples and logs.

Preserve:

- `server`, `worker`, and `backup` CLI modes.
- `/healthz`, database-backed `/readyz`, and Prometheus `/metrics`.
- Docker Compose server/worker profiles, non-root execution, read-only
  container root, dropped capabilities, resource limits, and persistent
  SQLite/Git volumes.
- Retention and online SQLite backup/restore procedures.

The runtime must include Git. SQLite is provided by Node.js 26.12.1's built-in
`node:sqlite` module. Docker builds install locked production dependencies,
build TypeScript, and run the compiled application on Node.js 26.12.1.

## Migration record

The migration was implemented in small, verifiable stages, using the previous
runtime's behavior as a reference. No permanent RPC/sidecar bridge remains.

1. **Architecture contract:** this document is the target of record; preserve
   current behavior and security invariants.
2. **TypeScript foundation:** Node version, npm scripts, strict TypeScript,
   test runner, linting, build, and Pi SDK dependency.
3. **Pure domain modules:** config validation, command parsing, models,
   validation and state transition tests.
4. **Storage and integrations:** SQLite schema/store, GitLab API/webhook, Git
   engine; port tests and add fixture-based integration tests.
5. **Application runtime:** CLI, HTTP server, background worker, leases,
   cancellation, retention, metrics, and backup.
6. **Pi worker:** one isolated Pi session per job, controlled tools/resources,
   structured outputs, token accounting, review/fix parity.
7. **Packaging:** Docker/Compose, CI, release process, examples and docs.
8. **Cutover:** remove superseded source, module files, CI/release steps, and
   obsolete instructions after parity checks.

No phase may weaken authorization or safety constraints to make the migration
easier. Data compatibility must be tested: the TypeScript store must open the
existing SQLite schema without data loss, or provide a tested, documented
backup-and-migration procedure before cutover.

## Completion criteria

- TypeScript implements all current commands, webhook filtering and
  authorization, queue/state/retry/cancel behavior, GitLab publishing, Git
  isolation, review validation, fix patch checks, token accounting, metrics,
  retention, and backup.
- Tests cover parity for existing behavior, including adverse inputs,
  lease expiry, cancellation, stale MR revisions, duplicate events, invalid
  model output, and patch scope violations.
- `npm ci`, lint, typecheck, unit/integration tests, and production build pass
  in CI; Docker server and worker modes start successfully.
- Deployment and configuration docs describe only the TypeScript/Pi runtime.
- The production build and deployment use a single runtime with no superseded
  source or release path remaining.

## Pi references

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi agent loop](https://pi.dev/docs/latest/how-pi-works)
- [Pi Skills](https://pi.dev/docs/latest/skills)
- [Pi RPC and CLI integration](https://pi.dev/docs/latest/cli-integration)
- [Pi security](https://pi.dev/docs/latest/security)
