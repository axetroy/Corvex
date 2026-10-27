import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import {
  jobStatuses,
  jobTypes,
  type EventResult,
  type Job,
  type JobStatus,
  type JobType,
  type ModelCallMetric,
} from "./model.js";

const maxAttempts = 3;
const terminal = new Set<JobStatus>(["completed", "failed", "stale", "cancelled"]);
const active = ["preparing", "analyzing", "fixing", "verifying", "publishing"];

interface JobRow {
  id: string;
  type: JobType;
  status: JobStatus;
  project_id: number;
  mr_iid: number;
  head_sha: string;
  actor_id: number;
  request: string;
  created_at: string;
  attempt_count: number;
  last_error: string;
  cancel_requested: number;
  lease_token: string;
}

function stringColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`SQLite column "${name}" is not text`);
  return value;
}

function numberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`SQLite column "${name}" is not a safe integer`);
  }
  return value;
}

function isJobType(value: string): value is JobType {
  return jobTypes.some((type) => type === value);
}

function isJobStatus(value: string): value is JobStatus {
  return jobStatuses.some((status) => status === value);
}

function readJobRow(row: Record<string, unknown> | undefined): JobRow | undefined {
  if (!row) return undefined;
  const type = stringColumn(row, "type");
  if (!isJobType(type)) throw new Error(`SQLite job type "${type}" is invalid`);
  const status = stringColumn(row, "status");
  if (!isJobStatus(status)) throw new Error(`SQLite job status "${status}" is invalid`);
  return {
    id: stringColumn(row, "id"),
    type,
    status,
    project_id: numberColumn(row, "project_id"),
    mr_iid: numberColumn(row, "mr_iid"),
    head_sha: stringColumn(row, "head_sha"),
    actor_id: numberColumn(row, "actor_id"),
    request: stringColumn(row, "request"),
    created_at: stringColumn(row, "created_at"),
    attempt_count: numberColumn(row, "attempt_count"),
    last_error: stringColumn(row, "last_error"),
    cancel_requested: numberColumn(row, "cancel_requested"),
    lease_token: stringColumn(row, "lease_token"),
  };
}

function readModelCallMetric(row: Record<string, unknown>): ModelCallMetric {
  const taskType = stringColumn(row, "taskType");
  if (!isJobType(taskType)) throw new Error(`SQLite model metric task type "${taskType}" is invalid`);
  const outcome = stringColumn(row, "outcome");
  if (outcome !== "success" && outcome !== "failure") {
    throw new Error(`SQLite model metric outcome "${outcome}" is invalid`);
  }
  return {
    taskType,
    outcome,
    calls: numberColumn(row, "calls"),
    durationMs: numberColumn(row, "durationMs"),
    inputTokens: numberColumn(row, "inputTokens"),
    outputTokens: numberColumn(row, "outputTokens"),
  };
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    projectId: row.project_id,
    mrIid: row.mr_iid,
    headSha: row.head_sha,
    actorId: row.actor_id,
    request: row.request,
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    cancellationRequested: row.cancel_requested !== 0,
    leaseToken: row.lease_token,
  };
}

export class JobStore {
  private readonly db: DatabaseSync;

  private constructor(private readonly path: string, db: DatabaseSync) {
    this.db = db;
  }

  static async open(path: string): Promise<JobStore> {
    if (!path) throw new Error("database path is required");
    if (path !== ":memory:") await mkdir(dirname(resolve(path)), { recursive: true });
    const db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.exec("PRAGMA journal_mode = WAL");
    const store = new JobStore(path, db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  ping(): void {
    this.db.prepare("SELECT 1").get();
  }

  jobCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  modelCallMetrics(): ModelCallMetric[] {
    return this.db
      .prepare(
        `SELECT task_type AS taskType, outcome, calls, duration_ms AS durationMs,
         input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM model_call_metrics ORDER BY task_type, outcome`,
      )
      .all()
      .map(readModelCallMetric);
  }

  recordModelCall(
    taskType: JobType,
    outcome: "success" | "failure",
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    if (!["review", "explain", "fix"].includes(taskType)) {
      throw new Error(`unsupported model call task type "${taskType}"`);
    }
    if (!["success", "failure"].includes(outcome)) {
      throw new Error(`unsupported model call outcome "${outcome}"`);
    }
    if (durationMs < 0 || inputTokens < 0 || outputTokens < 0) {
      throw new Error("model call metrics cannot be negative");
    }
    this.db
      .prepare(
        `INSERT INTO model_call_metrics
         (task_type, outcome, calls, duration_ms, input_tokens, output_tokens)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(task_type, outcome) DO UPDATE SET
           calls = calls + 1,
           duration_ms = duration_ms + excluded.duration_ms,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(taskType, outcome, Math.floor(durationMs), inputTokens, outputTokens);
  }

  pruneHistory(historyBefore: Date, auditBefore: Date): void {
    if (Number.isNaN(historyBefore.valueOf()) || Number.isNaN(auditBefore.valueOf())) {
      throw new Error("history and audit retention cutoffs are required");
    }
    this.transaction(() => {
      const history = historyBefore.toISOString();
      const audit = auditBefore.toISOString();
      const terminalStatuses = ["completed", "failed", "stale", "cancelled"];
      const statusParams = terminalStatuses.join(",");
      this.db
        .prepare(
          `DELETE FROM job_attempts WHERE job_id IN
           (SELECT id FROM jobs WHERE status IN (${statusParams}) AND updated_at < ?)`,
        )
        .run(...terminalStatuses, history);
      this.db
        .prepare(`DELETE FROM jobs WHERE status IN (${statusParams}) AND updated_at < ?`)
        .run(...terminalStatuses, history);
      this.db.prepare("DELETE FROM webhook_events WHERE received_at < ?").run(history);
      this.db
        .prepare("DELETE FROM model_token_usage WHERE day < ?")
        .run(historyBefore.toISOString().slice(0, 10));
      this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(audit);
    });
  }

  reserveModelTokens(dailyLimit: number, tokens: number): string {
    if (dailyLimit <= 0 || tokens <= 0) {
      throw new Error("daily model token limit and reservation must be positive");
    }
    const day = new Date().toISOString().slice(0, 10);
    this.transaction(() => {
      this.db.prepare("INSERT INTO model_token_usage(day) VALUES (?) ON CONFLICT(day) DO NOTHING").run(day);
      const result = this.db
        .prepare(
          `UPDATE model_token_usage SET reserved_tokens = reserved_tokens + ?
           WHERE day = ? AND used_tokens + reserved_tokens + ? <= ?`,
        )
        .run(tokens, day, tokens, dailyLimit);
      if (result.changes !== 1) {
        throw new Error(`daily model token budget of ${dailyLimit} tokens would be exceeded`);
      }
    });
    return day;
  }

  settleModelTokens(day: string, reserved: number, actual: number): void {
    if (!day || reserved <= 0 || actual < 0) throw new Error("model token reservation settlement is invalid");
    const result = this.db
      .prepare(
        `UPDATE model_token_usage
         SET reserved_tokens = reserved_tokens - ?, used_tokens = used_tokens + ?
         WHERE day = ? AND reserved_tokens >= ?`,
      )
      .run(reserved, actual, day, reserved);
    if (result.changes !== 1) throw new Error("model token reservation no longer exists");
  }

  async backup(destination: string): Promise<void> {
    if (!destination.trim()) throw new Error("backup destination is required");
    const output = resolve(destination);
    if (this.path !== ":memory:" && output === resolve(this.path)) {
      throw new Error("backup destination must differ from the database path");
    }
    try {
      await import("node:fs/promises").then(({ lstat }) => lstat(output));
      throw new Error(`backup destination "${output}" already exists`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // The destination is absent, as required.
      } else {
        throw error;
      }
    }
    await mkdir(dirname(output), { recursive: true });
    await sqliteBackup(this.db, output);
  }

  createReview(eventId: string, key: string, job: Partial<Job> & Pick<Job, "projectId" | "mrIid" | "actorId" | "headSha">): EventResult {
    return this.createQueuedTask(eventId, key, job, "review");
  }

  createExplain(
    eventId: string,
    key: string,
    job: Partial<Job> & Pick<Job, "projectId" | "mrIid" | "actorId" | "headSha" | "request">,
  ): EventResult {
    return this.createQueuedTask(eventId, key, job, "explain");
  }

  createFix(
    eventId: string,
    key: string,
    job: Partial<Job> & Pick<Job, "projectId" | "mrIid" | "actorId" | "headSha" | "request">,
    enabled: boolean,
    authorized: boolean,
  ): EventResult {
    return this.transaction(() => {
      const existingEvent = this.eventResult(eventId);
      if (existingEvent) return existingEvent;
      let auditResult = "authorized_queued";
      let response: string;
      if (!enabled) {
        response = "Fix proposals are disabled.";
        auditResult = "denied_disabled";
      } else if (!authorized) {
        response = "You are not authorized to request fix proposals.";
        auditResult = "denied_not_allowlisted";
      } else {
        const existing = this.db.prepare("SELECT id FROM jobs WHERE idempotency_key = ?").get(key) as
          | { id: string }
          | undefined;
        if (existing) {
          response = `Fix task \`${existing.id}\` is already queued for this comment.`;
          auditResult = "authorized_duplicate";
        } else {
          const created = new Date().toISOString();
          const id = randomUUID();
          this.db
            .prepare(
              `INSERT INTO jobs
               (id,idempotency_key,event_id,type,status,project_id,mr_iid,head_sha,actor_id,request,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(id, key, eventId, "fix", "queued", job.projectId, job.mrIid, job.headSha, job.actorId, job.request, created, created);
          response = `Queued fix task \`${id}\` for MR !${job.mrIid} at \`${job.headSha.slice(0, 12)}\`.`;
        }
      }
      this.insertEvent(eventId, response);
      this.insertAudit(job.actorId, "request_fix", `${job.projectId}:${job.mrIid}`, auditResult);
      return { response, delivered: false };
    });
  }

  status(eventId: string, projectId: number, mrIid: number): EventResult {
    return this.transaction(() => {
      const previous = this.eventResult(eventId);
      if (previous) return previous;
      const row = this.db
        .prepare(
          `SELECT id, status, actor_id, cancel_requested FROM jobs
           WHERE project_id = ? AND mr_iid = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectId, mrIid) as
        | { id: string; status: string; actor_id: number; cancel_requested: number }
        | undefined;
      let response = "No Corvex task has been created for this MR.";
      if (row) {
        response = `Latest task \`${row.id}\`: **${row.status}** (requested by user ${row.actor_id}).`;
        if (row.cancel_requested) response += " Cancellation has been requested.";
      }
      this.insertEvent(eventId, response);
      return { response, delivered: false };
    });
  }

  cancel(eventId: string, projectId: number, mrIid: number, actorId: number): EventResult {
    return this.transaction(() => {
      const previous = this.eventResult(eventId);
      if (previous) return previous;
      const row = this.db
        .prepare(
          `SELECT id, status, actor_id FROM jobs
           WHERE project_id = ? AND mr_iid = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectId, mrIid) as { id: string; status: JobStatus; actor_id: number } | undefined;
      let response: string;
      let auditResult: string;
      let resource = `${projectId}:${mrIid}`;
      if (!row) {
        response = "There is no task to cancel for this MR.";
        auditResult = "no_task";
      } else {
        resource = row.id;
        if (row.actor_id !== actorId) {
          response = "You can only cancel a task that you started.";
          auditResult = "denied_not_owner";
        } else if (row.status === "queued") {
          const updated = this.db
            .prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
            .run("cancelled", new Date().toISOString(), row.id, "queued").changes;
          response =
            updated === 1
              ? `Cancelled task \`${row.id}\`.`
              : `Task \`${row.id}\` changed state before it could be cancelled.`;
          auditResult = updated === 1 ? "cancelled" : "denied_state_changed";
        } else if (["preparing", "analyzing", "fixing", "verifying"].includes(row.status)) {
          const updated = this.db
            .prepare(
              "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = ? AND cancel_requested = 0",
            )
            .run(new Date().toISOString(), row.id, row.status).changes;
          response =
            updated === 1
              ? `Cancellation requested for task \`${row.id}\`.`
              : `Task \`${row.id}\` changed state before it could be cancelled.`;
          auditResult = updated === 1 ? "cancellation_requested" : "denied_state_changed";
        } else {
          response = `Task \`${row.id}\` is ${row.status} and can no longer be cancelled.`;
          auditResult = `denied_status_${row.status}`;
        }
      }
      this.insertAudit(actorId, "cancel_job", resource, auditResult);
      this.insertEvent(eventId, response);
      return { response, delivered: false };
    });
  }

  markDelivered(eventId: string): void {
    this.db.prepare("UPDATE webhook_events SET delivered = 1 WHERE event_id = ?").run(eventId);
  }

  recordResponse(eventId: string, response: string): EventResult {
    return this.transaction(() => {
      const previous = this.eventResult(eventId);
      if (previous) return previous;
      this.insertEvent(eventId, response);
      return { response, delivered: false };
    });
  }

  claimNextWithLease(leaseMs: number): Job | undefined {
    if (leaseMs <= 0) throw new Error("job lease duration must be positive");
    return this.transaction(() => {
      this.recoverExpiredLeases();
      const row = readJobRow(this.db
        .prepare(
          "SELECT * FROM jobs WHERE status = 'queued' AND type IN ('review','fix','explain') ORDER BY created_at LIMIT 1",
        )
        .get());
      if (!row) return undefined;
      const now = new Date();
      const leaseToken = randomUUID();
      const result = this.db
        .prepare(
          `UPDATE jobs SET status='preparing', attempt_count=attempt_count+1, updated_at=?,
           lease_token=?, lease_until=? WHERE id=? AND status='queued'`,
        )
        .run(now.toISOString(), leaseToken, now.valueOf() + leaseMs, row.id);
      if (result.changes !== 1) return undefined;
      this.db
        .prepare("INSERT INTO job_attempts(job_id,attempt,started_at) VALUES (?,?,?)")
        .run(row.id, row.attempt_count + 1, now.toISOString());
      this.insertAudit(row.actor_id, "job_status", row.id, "queued->preparing");
      const claimed = readJobRow(this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(row.id));
      if (!claimed) throw new Error(`claimed job "${row.id}" disappeared`);
      return mapJob(claimed);
    });
  }

  updateLeasedStatus(jobId: string, leaseToken: string, from: JobStatus, to: JobStatus, failure = ""): void {
    if (!leaseToken) throw new Error("job lease token is required");
    if (!this.validTransition(from, to)) throw new Error(`invalid job transition "${from}" -> "${to}"`);
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT actor_id, cancel_requested FROM jobs WHERE id=? AND status=? AND lease_token=?")
        .get(jobId, from, leaseToken) as { actor_id: number; cancel_requested: number } | undefined;
      if (!row) throw new Error(`job "${jobId}" is no longer in status "${from}"`);
      if (row.cancel_requested && to !== "cancelled") throw new Error("job cancellation requested");
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE jobs SET status=?, last_error=?, updated_at=?,
           lease_token=CASE WHEN ? THEN '' ELSE lease_token END,
           lease_until=CASE WHEN ? THEN 0 ELSE lease_until END
           WHERE id=? AND status=? AND lease_token=? AND (? OR cancel_requested=0)`,
        )
        .run(to, failure, now, terminal.has(to) ? 1 : 0, terminal.has(to) ? 1 : 0, jobId, from, leaseToken, to === "cancelled" ? 1 : 0);
      if (result.changes !== 1) throw new Error(`job "${jobId}" is no longer in status "${from}"`);
      if (terminal.has(to)) {
        this.db
          .prepare("UPDATE job_attempts SET finished_at=?, error=? WHERE job_id=? AND finished_at IS NULL")
          .run(now, failure, jobId);
      }
      this.insertAudit(row.actor_id, "job_status", jobId, `${from}->${to}`);
    });
  }

  renewLease(jobId: string, leaseToken: string, leaseMs: number): void {
    if (!leaseToken || leaseMs <= 0) throw new Error("job lease token and positive duration are required");
    const now = new Date();
    const result = this.db
      .prepare(
        `UPDATE jobs SET lease_until=?, updated_at=? WHERE id=? AND lease_token=?
         AND status IN (${active.map(() => "?").join(",")})`,
      )
      .run(now.valueOf() + leaseMs, now.toISOString(), jobId, leaseToken, ...active);
    if (result.changes !== 1) throw new Error(`job "${jobId}" lease is no longer owned`);
  }

  cancellationRequested(jobId: string, leaseToken: string): boolean {
    if (!leaseToken) throw new Error("job lease token is required");
    const row = this.db
      .prepare("SELECT cancel_requested FROM jobs WHERE id=? AND lease_token=?")
      .get(jobId, leaseToken) as { cancel_requested: number } | undefined;
    if (!row) throw new Error(`job "${jobId}" lease is no longer owned`);
    return row.cancel_requested !== 0;
  }

  getJob(jobId: string): Job {
    const row = readJobRow(this.db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId));
    if (!row) throw new Error(`job "${jobId}" not found`);
    return mapJob(row);
  }

  private createQueuedTask(
    eventId: string,
    key: string,
    job: Partial<Job> & Pick<Job, "projectId" | "mrIid" | "actorId" | "headSha">,
    type: "review" | "explain",
  ): EventResult {
    return this.transaction(() => {
      const previous = this.eventResult(eventId);
      if (previous) return previous;
      const existing = this.db
        .prepare("SELECT id FROM jobs WHERE idempotency_key = ?")
        .get(key) as { id: string } | undefined;
      const label = type === "review" ? "Review" : "Explain";
      let response: string;
      let auditResult = "queued";
      if (existing) {
        response = `${label} task \`${existing.id}\` is already queued for this comment.`;
        auditResult = "authorized_duplicate";
      } else {
        const id = randomUUID();
        const created = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO jobs
             (id,idempotency_key,event_id,type,status,project_id,mr_iid,head_sha,actor_id,request,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(id, key, eventId, type, "queued", job.projectId, job.mrIid, job.headSha, job.actorId, job.request ?? "", created, created);
        response = `Queued ${type} task \`${id}\` for MR !${job.mrIid} at \`${job.headSha.slice(0, 12)}\`.`;
      }
      this.insertEvent(eventId, response);
      this.insertAudit(job.actorId, `request_${type}`, `${job.projectId}:${job.mrIid}`, auditResult);
      return { response, delivered: false };
    });
  }

  private recoverExpiredLeases(): void {
    const now = new Date();
    const rows = this.db
      .prepare(
        `SELECT id,status,attempt_count,cancel_requested,actor_id FROM jobs
         WHERE lease_token != '' AND lease_until > 0 AND lease_until <= ?
         AND status IN (${active.map(() => "?").join(",")})`,
      )
      .all(now.valueOf(), ...active) as {
      id: string;
      status: JobStatus;
      attempt_count: number;
      cancel_requested: number;
      actor_id: number;
    }[];
    for (const row of rows) {
      let status: JobStatus = "queued";
      let error = "Worker lease expired; task will be retried.";
      if (row.cancel_requested) {
        status = "cancelled";
        error = "Worker lease expired after cancellation was requested; task was cancelled.";
      } else if (row.status === "publishing") {
        status = "failed";
        error = "Worker lease expired during publishing; outcome is uncertain, so automatic retry was skipped to prevent duplicate GitLab comments.";
      } else if (row.attempt_count >= maxAttempts) {
        status = "failed";
        error = "Worker lease expired and the maximum number of attempts was reached.";
      }
      this.db
        .prepare(
          "UPDATE jobs SET status=?,last_error=?,updated_at=?,lease_token='',lease_until=0 WHERE id=? AND status=?",
        )
        .run(status, error, now.toISOString(), row.id, row.status);
      this.db
        .prepare("UPDATE job_attempts SET finished_at=?,error=? WHERE job_id=? AND finished_at IS NULL")
        .run(now.toISOString(), error, row.id);
      this.insertAudit(row.actor_id, "job_status", row.id, `${row.status}->${status}`);
    }
  }

  private validTransition(from: JobStatus, to: JobStatus): boolean {
    const transitions: Partial<Record<JobStatus, JobStatus[]>> = {
      preparing: ["analyzing", "stale", "failed", "cancelled"],
      analyzing: ["fixing", "verifying", "publishing", "stale", "failed", "cancelled"],
      fixing: ["verifying", "stale", "failed", "cancelled"],
      verifying: ["publishing", "stale", "failed", "cancelled"],
      publishing: ["completed", "failed"],
    };
    return transitions[from]?.includes(to) ?? false;
  }

  private eventResult(eventId: string): EventResult | undefined {
    const row = this.db
      .prepare("SELECT response, delivered FROM webhook_events WHERE event_id=?")
      .get(eventId) as { response: string; delivered: number } | undefined;
    return row ? { response: row.response, delivered: row.delivered !== 0 } : undefined;
  }

  private insertEvent(eventId: string, response: string): void {
    this.db
      .prepare("INSERT INTO webhook_events(event_id,response,received_at) VALUES (?,?,?)")
      .run(eventId, response, new Date().toISOString());
  }

  private insertAudit(actorId: number, action: string, resource: string, result: string): void {
    this.db
      .prepare("INSERT INTO audit_events(actor_id,action,resource,result,created_at) VALUES (?,?,?,?,?)")
      .run(actorId, action, resource, result, new Date().toISOString());
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "SQLite transaction failed and rollback also failed",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, status TEXT NOT NULL, project_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL,
        head_sha TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL, request TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_mr_created_idx ON jobs(project_id,mr_iid,created_at DESC);
      CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY, response TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL, action TEXT NOT NULL,
        resource TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, error TEXT NOT NULL DEFAULT '', UNIQUE(job_id,attempt)
      );
      CREATE TABLE IF NOT EXISTS model_token_usage (
        day TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL DEFAULT 0, reserved_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS model_call_metrics (
        task_type TEXT NOT NULL, outcome TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_type,outcome)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    const existing = new Set(columns.map((column) => column.name));
    const additions: Record<string, string> = {
      attempt_count: "INTEGER NOT NULL DEFAULT 0",
      last_error: "TEXT NOT NULL DEFAULT ''",
      request: "TEXT NOT NULL DEFAULT ''",
      lease_token: "TEXT NOT NULL DEFAULT ''",
      lease_until: "INTEGER NOT NULL DEFAULT 0",
      cancel_requested: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
  }
}
