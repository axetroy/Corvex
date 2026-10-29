import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/jobs/store.js";

describe("JobStore", () => {
  let directory = "";
  let store: JobStore | undefined;

  afterEach(async () => {
    store?.close();
    store = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("persists idempotent jobs and enforces leased status transitions", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-"));
    store = await JobStore.open(join(directory, "state.db"));
    const queued = store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    expect(queued.response).toContain("Queued review task");
    const duplicate = store.createReview("event-2", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    expect(duplicate.response).toContain("already queued");

    const job = store.claimNextWithLease(30_000);
    expect(job?.status).toBe("preparing");
    expect(job?.attemptCount).toBe(1);
    expect(() =>
      store!.updateLeasedStatus(job!.id, job!.leaseToken, "preparing", "publishing"),
    ).toThrow("invalid job transition");
    store.updateLeasedStatus(job!.id, job!.leaseToken, "preparing", "analyzing");
    expect(store.getJob(job!.id).status).toBe("analyzing");
    expect(store.jobCounts().analyzing).toBe(1);
  });

  it("summarizes lifecycle counts and the oldest queued task for the operations dashboard", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });

    const overview = store.operationsOverview();

    expect(overview.counts.queued).toBe(1);
    expect(overview.counts.completed).toBe(0);
    expect(overview.oldestQueuedAt).toBe(store.listJobs("queued", 10)[0]?.createdAt);
  });

  it("reports recent worker heartbeats in the operations overview", async () => {
    store = await JobStore.open(":memory:");
    store.heartbeatWorker("worker-1");

    const overview = store.operationsOverview();

    expect(overview.workers.onlineCount).toBe(1);
    expect(overview.workers.lastSeenAt).toEqual(expect.any(String));
  });

  it("filters and paginates operations jobs with a matching total", async () => {
    store = await JobStore.open(":memory:");
    for (const [event, projectId, mrIid] of [
      ["event-1", 7, 3],
      ["event-2", 7, 4],
      ["event-3", 8, 5],
    ] as const) {
      store.createReview(event, `key-${event}`, {
        projectId,
        mrIid,
        headSha: "a".repeat(40),
        actorId: 11,
      });
    }

    const firstPage = store.listOperationsJobs({ projectId: 7, limit: 1, offset: 0 });
    const secondPage = store.listOperationsJobs({ projectId: 7, limit: 1, offset: 1 });

    expect(firstPage.total).toBe(2);
    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.total).toBe(2);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  });

  it("returns job details with the persisted attempt timeline", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "failed", "provider unavailable");

    const details = store.getJobDetails(job.id);

    expect(details?.attempts).toHaveLength(1);
    expect(details?.attempts[0]).toMatchObject({
      attempt: 1,
      finishedAt: expect.any(String),
      error: "provider unavailable",
    });
    expect(details?.timeline.map(({ from, to }) => [from, to])).toEqual([
      ["queued", "preparing"],
      ["preparing", "failed"],
    ]);
    expect(store.getJobDetails("missing-job")).toBeUndefined();
  });

  it("persists model and tool activity in the job trajectory", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");

    const modelCall = store.startJobTrace(
      job.id,
      job.attemptCount,
      "llm",
      "review",
      "test/model",
      JSON.stringify({ systemPrompt: "Review safely.", userPrompt: "Inspect the diff." }),
    );
    store.finishJobTrace(modelCall, "succeeded", 125, 70, 25);
    const toolCall = store.startJobTrace(job.id, job.attemptCount, "tool", "read_file", "", '{"path":"README.md"}');
    store.finishJobTrace(toolCall, "failed", 18, undefined, undefined, "Error: ENOENT: file not found");

    expect(store.getJobDetails(job.id)?.trajectory).toEqual([
      expect.objectContaining({
        kind: "tool",
        name: "read_file",
        status: "failed",
        durationMs: 18,
        rawContent: '{"path":"README.md"}',
        errorDetail: "Error: ENOENT: file not found",
      }),
      expect.objectContaining({
        kind: "llm",
        name: "review",
        status: "succeeded",
        model: "test/model",
        durationMs: 125,
        inputTokens: 70,
        outputTokens: 25,
        rawContent: JSON.stringify({ systemPrompt: "Review safely.", userPrompt: "Inspect the diff." }),
      }),
    ]);
  });

  it("lists jobs and requeues a failed job that stopped before publishing", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
    store.updateLeasedStatus(job.id, job.leaseToken, "analyzing", "failed", "temporary API error");

    expect(store.retryFailedJob(job.id).status).toBe("queued");
    expect(store.listJobs("queued", 10)).toHaveLength(1);
    expect(store.listJobs("failed", 10)).toHaveLength(0);
  });

  it("does not allow an operator retry after entering publishing", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
    store.updateLeasedStatus(job.id, job.leaseToken, "analyzing", "publishing");
    store.updateLeasedStatus(job.id, job.leaseToken, "publishing", "failed", "GitLab request failed");

    expect(() => store.retryFailedJob(job.id)).toThrow("publishing failures cannot be retried");
  });

  it("prunes terminal job history using a valid parameterized status filter", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "failed", "test failure");

    expect(() => store.pruneHistory(new Date(Date.now() + 86_400_000), new Date(Date.now() + 86_400_000))).not.toThrow();
    expect(store.jobCounts().failed ?? 0).toBe(0);
  });

  it("checks token reservations and records model call metrics", async () => {
    store = await JobStore.open(":memory:");
    const day = store.reserveModelTokens(1000, 100);
    expect(() => store.reserveModelTokens(100, 1)).toThrow("budget");
    store.settleModelTokens(day, 100, 25);
    store.recordModelCall("review", "success", 1250, 70, 25);
    expect(store.modelCallMetrics()).toEqual([
      {
        taskType: "review",
        outcome: "success",
        calls: 1,
        durationMs: 1250,
        inputTokens: 70,
        outputTokens: 25,
      },
    ]);
  });

  it("requests and finalizes cancellation while a task is leased", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
    expect(store.cancel("event-2", 7, 3, 11).response).toContain("Cancellation requested");
    expect(store.cancellationRequested(job.id, job.leaseToken)).toBe(true);
    expect(() =>
      store.updateLeasedStatus(job.id, job.leaseToken, "analyzing", "publishing"),
    ).toThrow("job cancellation requested");
    store.updateLeasedStatus(job.id, job.leaseToken, "analyzing", "cancelled");
    expect(store.getJob(job.id).status).toBe("cancelled");
  });

  it("records cancellation of a queued task in its lifecycle timeline", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.listJobs("queued", 1)[0];
    if (!job) throw new Error("expected a queued job");

    store.cancel("event-2", 7, 3, 11);

    expect(store.getJobDetails(job.id)).toMatchObject({
      status: "cancelled",
      timeline: [{ from: "queued", to: "cancelled", at: expect.any(String) }],
    });
  });

  it("does not retry after an expired publishing lease", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(250);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
    store.updateLeasedStatus(job.id, job.leaseToken, "analyzing", "publishing");
    await sleep(300);
    expect(store.claimNextWithLease(30_000)).toBeUndefined();
    expect(store.getJob(job.id).status).toBe("failed");
    expect(store.getJob(job.id).lastError).toContain("outcome is uncertain");
  });

  it("migrates an existing legacy SQLite job database without losing queued jobs", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-legacy-store-"));
    const databasePath = join(directory, "state.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, status TEXT NOT NULL, project_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL,
        head_sha TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL, request TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE job_trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO jobs
        (id,idempotency_key,event_id,type,status,project_id,mr_iid,head_sha,actor_id,request,created_at,updated_at)
      VALUES
        ('legacy-job','legacy-key','legacy-event','review','queued',9,5,'${"c".repeat(40)}',12,'','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z'),
        ('legacy-failed','legacy-failed-key','legacy-failed-event','review','failed',9,5,'${"d".repeat(40)}',12,'','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
    `);
    legacy.close();

    store = await JobStore.open(databasePath);
    expect(store.getJob("legacy-job")).toMatchObject({
      projectId: 9,
      mrIid: 5,
      status: "queued",
      attemptCount: 0,
      leaseToken: "",
      cancellationRequested: false,
    });
    expect(() => store.retryFailedJob("legacy-failed")).toThrow("failure stage is unknown");
    const traceId = store.startJobTrace("legacy-job", 1, "llm", "review", "test/model", "legacy prompt");
    store.finishJobTrace(traceId, "failed", 10, undefined, undefined, "legacy trace error");
    expect(store.getJobDetails("legacy-job")?.trajectory[0]?.rawContent).toBe("legacy prompt");
    expect(store.getJobDetails("legacy-job")?.trajectory[0]?.errorDetail).toBe("legacy trace error");
    expect(store.claimNextWithLease(30_000)?.id).toBe("legacy-job");
  });
});
