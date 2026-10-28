# Runtime and operations

## Runtime requirements

- Use Node.js 26.12.1 and npm to build or run from source. `npm ci` installs the locked dependencies.
- The Server needs outbound access to the configured GitLab API and inbound access from GitLab to its webhook URL.
- The Worker needs the `git` executable, outbound GitLab access for API and repository fetches, and outbound HTTPS access to the configured model API when the agent is enabled. The supplied Docker image installs Git.
- SQLite and Git data need persistent, writable storage. Avoid ephemeral container filesystems. Since Corvex uses SQLite WAL mode, use a local filesystem/volume with reliable SQLite locking rather than assuming arbitrary network filesystems are suitable.
- Keep system time synchronized. Daily model budget accounting uses UTC.

SQLite is embedded through Node's built-in `node:sqlite` module; the application does not require a native addon or separate SQLite service. Build the TypeScript application and start the Server or Worker as separate processes:

```sh
npm ci
npm run build
npm start -- --config configs/config.yaml server
npm start -- --config configs/config.yaml worker
```

The default config path is `configs/config.yaml`; pass `--config /path/to/config.yaml` to use another file. The Worker refuses to start unless `agent.enabled: true`.

## Docker Compose

1. Copy `.env.example` to `.env` and set the GitLab write token and webhook secret. The read token and model API key are needed only when running a Worker. Keep this file private and do not commit it.
2. Copy `configs/config.example.yaml` to `configs/config.yaml`; set the GitLab URL and explicit project/user allowlists.
3. Start the Server:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml pull corvex
   docker compose --env-file .env -f deploy/compose.yaml up -d
   ```

4. To process model tasks, set `agent.enabled: true`, configure the model URL/name, set `CORVEX_MODEL_API_KEY` in `.env`, then enable the worker profile:

   ```sh
   docker compose --env-file .env -f deploy/compose.yaml --profile worker pull
   docker compose --env-file .env -f deploy/compose.yaml --profile worker up -d
   ```

Both services mount the same named `corvex-data` volume at `/data/corvex`; Compose points both the database and Git root into that volume. Only the Server publishes port 8080. The sample Compose setup uses a read-only container root filesystem, a temporary `/tmp`, drops Linux capabilities, and enables `no-new-privileges`.

The Compose file uses the `ghcr.io/axetroy/corvex` image by default. To build from a local checkout instead, add `--build` to `docker compose up`.
GHCR package visibility controls anonymous pulls; make the package public after its first publish if deployments should not require `docker login`.

Compose resource defaults are 1 CPU/1 GiB and 256 PIDs for the Server, and 2 CPUs/2 GiB and 256 PIDs for the Worker. Override them with `CORVEX_MEM_LIMIT`, `CORVEX_CPUS`, `CORVEX_PIDS_LIMIT`, and the corresponding `CORVEX_WORKER_MEM_LIMIT`, `CORVEX_WORKER_CPUS`, and `CORVEX_WORKER_PIDS_LIMIT`. JSON logs rotate at 10 MiB with three files retained.

Expose the webhook through HTTPS and keep the GitLab API, database volume, and metrics endpoint restricted to trusted networks. The compose port mapping is plain HTTP; terminate TLS at a trusted reverse proxy or load balancer.
The read-only operations console is disabled unless both `CORVEX_OPS_USERNAME` and `CORVEX_OPS_PASSWORD` are set. When enabled, open `https://<corvex-host>/ops`; the same credentials protect its API. Use a strong, unique password, and do not expose the console over plain HTTP or directly to an untrusted network.

## HTTP endpoints

| Method and path | Purpose |
|---|---|
| `POST /webhooks/gitlab` | GitLab merge-request Note Hook endpoint. Requires the matching `X-Gitlab-Token`; only Note Hook events are supported. |
| `GET /healthz` | Process liveness check; returns `200 ok`. |
| `GET /readyz` | Readiness check that pings SQLite; returns `503` if the database is unavailable. |
| `GET /metrics` | Prometheus text metrics for job counts and model call counts, duration, and token totals. |
| `GET /ops` | Optional Basic Auth-protected read-only operations console. Disabled when operations credentials are unset. |
| `GET /api/ops/overview` | Operations summary with job counts, oldest queued age, worker heartbeats, and model call metrics. |
| `GET /api/ops/jobs` | Filtered and paginated job list (`status`, `type`, `projectId`, `mrIid`, `search`, `limit`, `offset`). |
| `GET /api/ops/jobs/<id>` | Job details and persisted attempt history. |

The operations endpoints require HTTP Basic Auth and return `404` when disabled. Job details include submitted requests and error text; protect operator credentials and use HTTPS. Do not expose `/metrics` publicly unless your monitoring setup requires it; restrict it at the network or proxy layer.

The console has three read-only views: an overview of queue and worker status, a filterable job list, and a per-job detail/attempt history view. It refreshes automatically every 15 seconds. It does not retry, cancel, or create tasks.
The interface supports English and Simplified Chinese. On first visit it selects the best supported browser language; a manual selection is saved in browser storage for later visits.

## Logs and troubleshooting

Corvex writes structured JSON logs to stdout. In Compose, inspect logs with:

```sh
docker compose --env-file .env -f deploy/compose.yaml logs -f corvex
docker compose --env-file .env -f deploy/compose.yaml --profile worker logs -f corvex-worker
```

The Server logs webhook receipt, validation/rejection, ignored comments, recognized commands, task enqueue or deduplication, GitLab response publication, and the HTTP response status. The Worker logs claimed jobs and each status transition. These logs include event/job IDs and project/MR IDs, but not comment bodies or webhook credentials.

| Symptom | Checks |
|---|---|
| Webhook returns `401` | Confirm the GitLab hook secret exactly matches `CORVEX_WEBHOOK_SECRET`. |
| Webhook returns `400` | The endpoint only accepts valid merge-request Note Hook payloads. Disable unsupported event types and ensure the request is a merge-request comment. |
| Webhook returns `403` | Confirm the webhook's project ID and comment author's user ID are in the configured allowlists. |
| Tasks stay queued | Confirm a Worker is running with `agent.enabled: true`, using the same database volume/config, and that model settings are valid. |
| Worker cannot clone a project | Check GitLab network access, read token permissions, project visibility, and that the worker has Git installed. |
| Task becomes stale | The MR was closed or its diff changed after the command was queued; submit a new command on the current revision. |
| `readyz` returns `503` | Check the database path, persistent volume mount, and filesystem permissions. |

## Job administration

List recent jobs or filter failures using the same SQLite database as the Server and Worker:

```sh
npm start -- jobs list --database ./data/state/corvex.db --status failed
npm start -- jobs list --database ./data/state/corvex.db --limit 100
```

An operator can requeue a failed job only when it failed before publishing and has automatic attempts remaining:

```sh
npm start -- jobs retry <job-id> --database ./data/state/corvex.db
```

Publishing failures cannot be retried because GitLab may already have accepted the comment. The CLI writes an operator retry audit event; run it on a host with access to the persistent database.

## Git storage cleanup

Preview old workspaces and project mirrors before removing them:

```sh
npm start -- storage cleanup --config configs/config.yaml --older-than-days 1
npm start -- storage cleanup --config configs/config.yaml --older-than-days 1 --apply
```

Cleanup is dry-run by default, excludes active workspaces and projects with queued or active tasks, and removes only directories older than the selected age. Stop all Workers before applying a cleanup to avoid races with a newly claimed task. For Compose, run the command in the Server container after stopping the Worker profile:

```sh
docker compose --env-file .env -f deploy/compose.yaml exec corvex \
  node /app/dist/cli.js storage cleanup --config /etc/corvex/config.yaml --apply
```

## Backup, restore, and retention

Create an online SQLite backup while the service is running. The destination must not already exist:

```sh
npm start -- backup \
  --database ./data/state/corvex.db \
  --output ./data/backups/corvex-$(date +%Y%m%d%H%M%S).db
```

For a container deployment, run the backup command in an environment that can access the mounted database and has the Corvex executable. Protect backups with the same encryption and access controls as the live database.

To restore, stop both Server and Worker, preserve the current database for rollback, replace it with a verified backup at the configured database path, and restart both processes. Do not overwrite a live database.

The Server runs cleanup at startup and then approximately every 24 hours. Terminal jobs, attempts, webhook delivery records, and daily token usage use `storage.retention_days` (90 days by default). Audit events use `storage.audit_retention_days` (365 days by default). Queued and active jobs are retained. Git mirrors under `storage.root` are not covered by this database cleanup; monitor disk use and define a separate mirror maintenance policy.

## Upgrades and development

Back up the database before upgrading. The application applies SQLite schema migrations at startup; deploy the same application version to Server and Worker and keep their shared data volume. Test the upgrade and restore procedure against a backup before relying on it in production.

From a source checkout, the usual checks are:

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

The repository CI runs these checks on Node.js 26.12.1. Git must be installed on any host that runs a Worker.
