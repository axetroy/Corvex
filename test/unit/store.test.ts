import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/jobs/store.js";
import { traceExecutionStep } from "../../src/jobs/execution.js";

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
    expect(job).toMatchObject({ targetType: "merge_request", targetIid: 3 });
    expect(() =>
      store!.updateLeasedStatus(job!.id, job!.leaseToken, "preparing", "publishing"),
    ).toThrow("invalid job transition");
    store.updateLeasedStatus(job!.id, job!.leaseToken, "preparing", "analyzing");
    expect(store.getJob(job!.id).status).toBe("analyzing");
    expect(store.jobCounts().analyzing).toBe(1);
  });

  it("leases webhook response delivery to one concurrent sender", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-delivery", "key-delivery", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });

    const first = store.claimWebhookDelivery("event-delivery", 10_000);
    expect(first.status).toBe("claimed");
    expect(store.claimWebhookDelivery("event-delivery", 10_000)).toEqual({ status: "in_progress" });
    if (first.status !== "claimed") throw new Error("expected a delivery lease");
    store.releaseWebhookDelivery("event-delivery", first.token);

    const retry = store.claimWebhookDelivery("event-delivery", 10_000);
    expect(retry.status).toBe("claimed");
    if (retry.status !== "claimed") throw new Error("expected a replacement delivery lease");
    store.markDelivered("event-delivery", retry.token);
    expect(store.claimWebhookDelivery("event-delivery", 10_000)).toEqual({ status: "delivered" });
  });

  it("queues chat jobs with their full request text", async () => {
    store = await JobStore.open(":memory:");
    const request = "总结这个 PR\n\n请给出一个标题";
    const result = store.createChat("event-chat", "key-chat", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
      request,
    });

    expect(result.response).toContain("Queued chat task");
    expect(store.claimNextWithLease(30_000)).toMatchObject({
      type: "chat",
      request,
      status: "preparing",
    });
  });

  it("creates a repository conversation and its first pinned message job atomically", async () => {
    store = await JobStore.open(":memory:");
    const result = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Explain the routing module",
    });

    const conversation = store.getConversation(result.conversationId);
    expect(conversation).toMatchObject({
      id: result.conversationId,
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      messages: [
        { role: "user", content: "Explain the routing module", status: "completed" },
        { role: "assistant", content: "", status: "queued", jobId: result.jobId, headSha: "a".repeat(40) },
      ],
    });
    expect(store.claimNextWithLease(30_000)).toMatchObject({
      id: result.jobId,
      type: "conversation",
      targetBranch: "main",
      conversationId: result.conversationId,
      conversationResponseId: conversation?.messages[1]?.id,
      headSha: "a".repeat(40),
    });
  });

  it("serializes conversation turns and reflects retry and cancellation states", async () => {
    store = await JobStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    expect(() => store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Overlapping turn",
    })).toThrow("chat conversation already has an active message");

    const firstAttempt = store.claimNextWithLease(30_000);
    if (!firstAttempt) throw new Error("expected initial conversation turn to be claimed");
    expect(store.retryLeasedJob(firstAttempt.id, firstAttempt.leaseToken, "preparing", Date.now() - 1, "temporary failure"))
      .toBe(true);
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({ status: "queued" });

    const retry = store.claimNextWithLease(30_000);
    if (!retry) throw new Error("expected retried conversation turn to be claimed");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({ status: "running" });
    store.updateLeasedStatus(retry.id, retry.leaseToken, "preparing", "cancelled", "cancelled by test");
    store.finishConversationResponse(retry.id, "cancelled", "This turn was cancelled.");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      status: "failed",
      content: "This turn was cancelled.",
    });
    expect(store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Try again after cancellation",
    }).jobId).toBeTruthy();
  });

  it("requeues the assistant response when retrying a failed conversation job", async () => {
    store = await JobStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Retry this conversation turn",
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a conversation job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "failed", "temporary failure");
    expect(store.getConversation(created.conversationId)?.messages[1]?.status).toBe("failed");

    store.retryFailedJob(job.id);

    expect(store.getJob(job.id).status).toBe("queued");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      status: "queued",
      jobId: job.id,
    });
    expect(() => store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Do not overlap the retry",
    })).toThrow("chat conversation already has an active message");
  });

  it("exposes each conversation turn's own trajectory and execution records", async () => {
    store = await JobStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Explain the routing module",
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a conversation job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
    const traceId = store.startJobTrace(
      job.id,
      job.attemptCount,
      "llm",
      "conversation",
      "test/model",
      JSON.stringify({ systemPrompt: "Answer read-only.", userPrompt: "Explain routing." }),
      { round: 1, input: "conversation context" },
    );
    store.finishJobTrace(traceId, "succeeded", 80, 40, 20, undefined, "assistant response");
    store.recordExecutionEvent({
      jobId: job.id,
      attempt: job.attemptCount,
      step: "workflow.read_only_conversation",
      status: "succeeded",
      input: { requestCharacters: 24 },
      output: { textBytes: 18 },
    });
    store.updateLeasedStatus(job.id, job.leaseToken, "analyzing", "completed");
    store.finishConversationResponse(job.id, "completed", "Routing lives in routing.ts.");

    const turn = store.getConversationTurn(created.conversationId, job.id);
    expect(turn).toMatchObject({
      conversationId: created.conversationId,
      jobId: job.id,
      status: "completed",
      request: "Explain the routing module",
      headSha: "a".repeat(40),
      attemptCount: job.attemptCount,
    });
    expect(turn?.trajectory).toHaveLength(1);
    expect(turn?.trajectory[0]).toMatchObject({ kind: "llm", status: "succeeded", output: "assistant response" });
    expect(turn?.events.some((event) => event.step === "workflow.read_only_conversation")).toBe(true);
    expect(turn?.timeline.some((transition) => transition.to === "completed")).toBe(true);
    // 轮次记录必须绑定到该对话，跨对话或未知任务返回 undefined。
    expect(store.getConversationTurn("other-conversation", job.id)).toBeUndefined();
    expect(store.getConversationTurn(created.conversationId, "missing-job")).toBeUndefined();
  });

  it("counts conversation turns and surfaces the latest turn status", async () => {
    store = await JobStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ turnCount: 1, lastTurnStatus: "queued" });
    const first = store.claimNextWithLease(30_000);
    if (!first) throw new Error("expected the first conversation turn to be claimed");
    store.updateLeasedStatus(first.id, first.leaseToken, "preparing", "analyzing");
    store.updateLeasedStatus(first.id, first.leaseToken, "analyzing", "completed");
    store.finishConversationResponse(first.id, "completed", "First answer");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      jobStatus: "completed",
      traceCount: 0,
      eventCount: 0,
      toolCalls: [],
    });
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ turnCount: 1, lastTurnStatus: "completed" });
  });

  it("surfaces each assistant turn's tool calls in the conversation listing", async () => {
    store = await JobStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Where is routing implemented?",
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a conversation job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
    const readTrace = store.startJobTrace(
      job.id,
      job.attemptCount,
      "tool",
      "read_file",
      "",
      null,
      { round: 1, input: JSON.stringify({ path: "src/routing.ts" }) },
    );
    store.finishJobTrace(readTrace, "succeeded", 42);
    const grepTrace = store.startJobTrace(
      job.id,
      job.attemptCount,
      "tool",
      "git_grep",
      "",
      null,
      { round: 1, input: JSON.stringify({ query: "createHash", path: "src" }) },
    );
    store.finishJobTrace(grepTrace, "failed", 7, undefined, undefined, "boom");
    store.updateLeasedStatus(job.id, job.leaseToken, "analyzing", "completed");
    store.finishConversationResponse(job.id, "completed", "Routing lives in routing.ts.");

    const assistant = store.getConversation(created.conversationId)?.messages[1];
    expect(assistant).toMatchObject({
      role: "assistant",
      traceCount: 2,
      toolCalls: [
        { name: "read_file", status: "succeeded", durationMs: 42 },
        { name: "git_grep", status: "failed", durationMs: 7 },
      ],
    });
    // 用户消息不携带工具调用，避免把助手的活动挂到提问上。
    expect(store.getConversation(created.conversationId)?.messages[0]?.toolCalls).toEqual([]);
  });

  it("summarizes conversation usage and per-turn timings", async () => {
    store = await JobStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    const first = store.claimNextWithLease(30_000);
    if (!first) throw new Error("expected the first conversation turn to be claimed");
    store.updateLeasedStatus(first.id, first.leaseToken, "preparing", "analyzing");
    const llmTrace = store.startJobTrace(first.id, first.attemptCount, "llm", "conversation", "test/model", "{}", { round: 1 });
    store.finishJobTrace(llmTrace, "succeeded", 120, 30, 12);
    const toolTrace = store.startJobTrace(first.id, first.attemptCount, "tool", "read_file", "test/model", "{}");
    store.finishJobTrace(toolTrace, "succeeded", 40, 0, 0);
    store.updateLeasedStatus(first.id, first.leaseToken, "analyzing", "completed");
    store.finishConversationResponse(first.id, "completed", "First answer");

    // 未开始的轮次耗时不确定，统计里计为进行中且不计耗时。
    store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Second turn",
    });

    const stats = store.getConversationStats(created.conversationId);
    expect(stats).toMatchObject({
      conversationId: created.conversationId,
      turnCount: 2,
      completedTurns: 1,
      failedTurns: 0,
      activeTurns: 1,
      measuredTurns: 1,
      modelCalls: 1,
      toolCalls: 1,
      inputTokens: 30,
      outputTokens: 12,
    });
    expect(stats?.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats?.turns).toHaveLength(2);
    expect(stats?.turns[0]).toMatchObject({ status: "completed", modelCalls: 1, toolCalls: 1, inputTokens: 30, outputTokens: 12 });
    expect(stats?.turns[0]?.durationMs).not.toBeNull();
    expect(stats?.turns[1]).toMatchObject({ status: "queued", durationMs: null, modelCalls: 0, toolCalls: 0 });
    // 未知对话返回 undefined，由服务端转成 404。
    expect(store.getConversationStats("missing-conversation")).toBeUndefined();
  });

  it("queues Issue assistant jobs with a distinct issue target", async () => {
    store = await JobStore.open(":memory:");
    const result = store.createIssueImplementation("issue-event", "project:issue:17:note:9", {
      projectId: 7,
      issueIid: 17,
      actorId: 11,
      request: "Add the requested setting",
    });

    expect(result.response).toContain("Queued Issue assistant task");
    expect(store.claimNextWithLease(30_000)).toMatchObject({
      type: "implement",
      targetType: "issue",
      targetIid: 17,
      mrIid: 0,
      request: "Add the requested setting",
      status: "preparing",
    });
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

  it("reports queue and execution start times for operations job ages", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });

    const queued = store.listOperationsJobs({ limit: 10, offset: 0 }).items[0];
    expect(queued?.activityStartedAt).toBe(queued?.createdAt);

    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    const running = store.listOperationsJobs({ limit: 10, offset: 0 }).items[0];

    expect(running?.activityStartedAt).toBe(store.getJobDetails(job.id)?.attempts[0]?.startedAt);

    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "failed", "temporary failure");
    const retried = store.retryFailedJob(job.id);
    const queuedAgain = store.listOperationsJobs({ limit: 10, offset: 0 }).items[0];

    expect(queuedAgain?.activityStartedAt).toBe(retried.updatedAt);
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
      { round: 2, input: "review context" },
    );
    store.finishJobTrace(
      modelCall,
      "succeeded",
      125,
      70,
      25,
      undefined,
      "assistant response",
      40,
      85,
      "2026-01-01T00:00:00.010Z",
      12,
    );
    const toolCall = store.startJobTrace(
      job.id,
      job.attemptCount,
      "tool",
      "read_file",
      "",
      '{"path":"README.md"}',
      { round: 2, input: '{"path":"README.md"}', schema: '{"type":"object"}' },
    );
    store.finishJobTrace(
      toolCall,
      "failed",
      18,
      undefined,
      undefined,
      "Error: ENOENT: file not found",
      "tool result",
    );

    expect(store.getJobDetails(job.id)?.trajectory).toEqual([
      expect.objectContaining({
        kind: "tool",
        name: "read_file",
        status: "failed",
        durationMs: 18,
        rawContent: '{"path":"README.md"}',
        errorDetail: "Error: ENOENT: file not found",
        round: 2,
        input: '{"path":"README.md"}',
        output: "tool result",
        schema: '{"type":"object"}',
      }),
      expect.objectContaining({
        kind: "llm",
        name: "review",
        status: "succeeded",
        model: "test/model",
        durationMs: 125,
        firstTokenMs: 40,
        generationDurationMs: 85,
        requestStartedAt: "2026-01-01T00:00:00.010Z",
        responseHeadersMs: 12,
        inputTokens: 70,
        outputTokens: 25,
        rawContent: JSON.stringify({ systemPrompt: "Review safely.", userPrompt: "Inspect the diff." }),
        round: 2,
        input: "review context",
        output: "assistant response",
        schema: null,
      }),
    ]);
  });

  it("persists redacted execution events before and after job creation", async () => {
    store = await JobStore.open(":memory:");
    const eventId = store.startExecutionEvent({
      deliveryId: "delivery-1",
      eventId: "1:2",
      step: "webhook.decode",
      input: {
        project: { id: 7 },
        api_token: "must-not-be-persisted",
        note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      },
    });
    store.createReview("1:2", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.finishExecutionEvent(eventId, "succeeded", 12, { accepted: true, token: "another-secret" });
    store.recordExecutionEvent({
      jobId: job.id,
      attempt: job.attemptCount,
      step: "gitlab.get_project",
      status: "succeeded",
      input: { projectId: 7 },
      output: { id: 7, http_url_to_repo: "https://gitlab.example.com/project.git" },
    });

    const details = store.getJobDetails(job.id);
    const webhookEvent = details?.events.find((event) => event.step === "webhook.decode");
    expect(webhookEvent).toMatchObject({
      deliveryId: "delivery-1",
      eventId: "1:2",
      jobId: job.id,
      attempt: null,
      status: "succeeded",
      output: JSON.stringify({ accepted: true, token: "[REDACTED]" }),
    });
    expect(webhookEvent?.input).not.toContain("must-not-be-persisted");
    expect(webhookEvent?.input).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(details?.events.find((event) => event.step === "gitlab.get_project")).toMatchObject({
      deliveryId: null,
      jobId: job.id,
      attempt: 1,
      status: "succeeded",
    });
    const boundedEventId = store.recordExecutionEvent({
      jobId: job.id,
      attempt: job.attemptCount,
      step: "webhook.sanitize",
      status: "succeeded",
      input: {
        repositoryUrl: "https://user:pass@gitlab.example/project?private_token=private-value",
        note: "🧪".repeat(30_000),
      },
    });
    const boundedEvent = store.getJobDetails(job.id)?.events.find((event) => event.id === boundedEventId);
    expect(boundedEvent?.input).not.toContain("user:pass");
    expect(boundedEvent?.input).not.toContain("private-value");
    expect(Buffer.byteLength(boundedEvent?.input ?? "")).toBeLessThanOrEqual(64 << 10);
  });

  it("marks in-flight execution events interrupted when a worker lease expires", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const firstAttempt = store.claimNextWithLease(10);
    if (!firstAttempt) throw new Error("expected a queued job to be claimed");
    const eventId = store.startExecutionEvent({
      jobId: firstAttempt.id,
      attempt: firstAttempt.attemptCount,
      step: "gitlab.post_note",
      input: { body: "comment text" },
    });

    await sleep(20);
    const retry = store.claimNextWithLease(30_000);

    expect(retry).toMatchObject({ id: firstAttempt.id, attemptCount: 2 });
    expect(store.getJobDetails(firstAttempt.id)?.events).toEqual([
      expect.objectContaining({ id: eventId, status: "interrupted", errorDetail: expect.stringContaining("lease expired") }),
    ]);
  });

  it("records execution step outputs and failures", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");

    await traceExecutionStep(
      store,
      { jobId: job.id, attempt: job.attemptCount },
      "gitlab.get_project",
      { projectId: 7 },
      async () => ({ id: 7, http_url_to_repo: "https://gitlab.example.com/project.git" }),
    );
    await expect(traceExecutionStep(
      store,
      { jobId: job.id, attempt: job.attemptCount },
      "gitlab.get_mr",
      { projectId: 7, mrIid: 3 },
      async () => {
        throw new Error("GitLab unavailable");
      },
    )).rejects.toThrow("GitLab unavailable");
    await expect(traceExecutionStep(
      store,
      { jobId: job.id, attempt: job.attemptCount },
      "gitlab.post_note",
      { body: "comment text" },
      async () => {
        throw new Error("connection closed before response");
      },
      undefined,
      () => "unknown",
    )).rejects.toThrow("connection closed before response");

    expect(store.getJobDetails(job.id)?.events).toMatchObject([
      { step: "gitlab.post_note", status: "unknown" },
      { step: "gitlab.get_mr", status: "failed", errorDetail: "GitLab unavailable" },
      { step: "gitlab.get_project", status: "succeeded", output: JSON.stringify({ id: 7, http_url_to_repo: "https://gitlab.example.com/project.git" }) },
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

  it("persists automatic retry availability and attempt history across restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-retry-"));
    const databasePath = join(directory, "state.db");
    store = await JobStore.open(databasePath);
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
    const availableAt = Date.now() + 60_000;

    expect(store.retryLeasedJob(job.id, job.leaseToken, "analyzing", availableAt, "temporary API failure")).toBe(true);
    expect(store.claimNextWithLease(30_000)).toBeUndefined();
    store.close();
    store = await JobStore.open(databasePath);

    expect(store.claimNextWithLease(30_000)).toBeUndefined();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE jobs SET available_at=0 WHERE id=?").run(job.id);
    database.close();

    const retry = store.claimNextWithLease(30_000);
    expect(retry).toMatchObject({ id: job.id, attemptCount: 2, status: "preparing" });
    expect(store.getJobDetails(job.id)?.attempts).toMatchObject([
      { attempt: 1, error: "temporary API failure", finishedAt: expect.any(String) },
      { attempt: 2, error: "", finishedAt: null },
    ]);
    expect(store.getJobDetails(job.id)?.timeline.map(({ from, to }) => [from, to])).toEqual([
      ["queued", "preparing"],
      ["preparing", "analyzing"],
      ["analyzing", "queued"],
      ["queued", "preparing"],
    ]);
  });

  it("does not automatically retry beyond the maximum attempt count", async () => {
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = store.claimNextWithLease(30_000);
      if (!job) throw new Error("expected a queued job to be claimed");
      store.updateLeasedStatus(job.id, job.leaseToken, "preparing", "analyzing");
      expect(store.retryLeasedJob(job.id, job.leaseToken, "analyzing", Date.now(), `failure ${attempt}`))
        .toBe(attempt < 3);
      if (attempt === 3) {
        expect(store.getJob(job.id).status).toBe("analyzing");
      }
    }
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

  it("prunes idle conversations with their messages but keeps conversations with an active reply", async () => {
    store = await JobStore.open(":memory:");
    const base = {
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
    };
    const idle = store.createConversation({ ...base, request: "Summarize the repository layout" });
    const active = store.createConversation({ ...base, request: "Explain the worker loop" });
    const activeResponseId = store.getConversation(active.conversationId)?.messages[1]?.id;
    if (!activeResponseId) throw new Error("expected a queued conversation response");
    store.finishConversationResponse(idle.jobId, "completed", "The repository has a src and test tree.");

    store.pruneHistory(new Date(Date.now() + 86_400_000), new Date(Date.now() + 86_400_000));

    expect(store.getConversation(idle.conversationId)).toBeUndefined();
    const kept = store.getConversation(active.conversationId);
    expect(kept?.messages).toHaveLength(2);
    expect(kept?.messages[1]).toMatchObject({ id: activeResponseId, status: "queued" });
  });

  it("checks token reservations and records model call metrics", async () => {
    store = await JobStore.open(":memory:");
    const day = store.reserveModelTokens(1000, 100);
    expect(() => store.reserveModelTokens(100, 1)).toThrow("budget");
    store.settleModelTokens(day, 100, 25);
    store.recordModelCall("review", "success", 1250, 70, 25);
    store.recordModelCall("conversation", "success", 800, 40, 20);
    expect(store.modelCallMetrics()).toEqual([
      {
        taskType: "conversation",
        outcome: "success",
        calls: 1,
        durationMs: 800,
        inputTokens: 40,
        outputTokens: 20,
      },
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
    expect(store.getJobDetails("legacy-job")?.trajectory[0]).toMatchObject({
      firstTokenMs: null,
      generationDurationMs: null,
    });
    expect(store.claimNextWithLease(30_000)?.id).toBe("legacy-job");
  });

  it("renames legacy session tables and columns while keeping conversations readable", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-legacy-session-"));
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
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, project_name TEXT NOT NULL,
        target_type TEXT NOT NULL, target_iid INTEGER NOT NULL, target_branch TEXT NOT NULL,
        target_title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_session_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, job_id TEXT,
        head_sha TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO chat_sessions
        (id,project_id,project_name,target_type,target_iid,target_branch,target_title,created_at,updated_at)
      VALUES
        ('legacy-session',7,'group/project','merge_request',5,'feature/session','Old MR title','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
      INSERT INTO chat_session_messages
        (id,session_id,role,content,status,job_id,head_sha,created_at,updated_at)
      VALUES
        ('legacy-message','legacy-session','user','Hello','completed',NULL,'a','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
    `);
    legacy.close();

    store = await JobStore.open(databasePath);
    expect(store.listConversations(10, 0)).toEqual({
      items: [{
        id: "legacy-session",
        projectId: 7,
        projectName: "group/project",
        targetBranch: "feature/session",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        turnCount: 0,
        lastTurnStatus: null,
      }],
      total: 1,
    });
    expect(store.getConversation("legacy-session")?.messages[0]).toMatchObject({ id: "legacy-message", content: "Hello" });
    const inspector = new DatabaseSync(databasePath);
    const conversationColumns = inspector.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    const messageColumns = inspector.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[];
    inspector.close();
    expect(conversationColumns.map((column) => column.name)).not.toContain("target_type");
    expect(conversationColumns.map((column) => column.name)).not.toContain("target_iid");
    expect(conversationColumns.map((column) => column.name)).not.toContain("target_title");
    expect(messageColumns.map((column) => column.name)).toContain("conversation_id");
    expect(messageColumns.map((column) => column.name)).not.toContain("session_id");
  });
});
