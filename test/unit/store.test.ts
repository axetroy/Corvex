import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../../src/events/store.js";
import { traceExecutionStep } from "../../src/events/execution.js";

describe("EventStore", () => {
  let directory = "";
  let store: EventStore | undefined;

  afterEach(async () => {
    store?.close();
    store = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("persists idempotent events and enforces leased status transitions", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-"));
    store = await EventStore.open(join(directory, "state.db"));
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

    const event = store.claimNextWithLease(30_000);
    expect(event?.status).toBe("preparing");
    expect(event?.attemptCount).toBe(1);
    expect(event).toMatchObject({ targetType: "merge_request", targetIid: 3 });
    expect(() =>
      store!.updateLeasedStatus(event!.id, event!.leaseToken, "preparing", "publishing"),
    ).toThrow("invalid event transition");
    store.updateLeasedStatus(event!.id, event!.leaseToken, "preparing", "analyzing");
    expect(store.getEvent(event!.id).status).toBe("analyzing");
    expect(store.eventCounts().analyzing).toBe(1);
  });

  it("leases webhook response delivery to one concurrent sender", async () => {
    store = await EventStore.open(":memory:");
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

  it("queues chat events with their full request text", async () => {
    store = await EventStore.open(":memory:");
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

  it("creates a repository conversation and its first pinned message event atomically", async () => {
    store = await EventStore.open(":memory:");
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
      turnCount: 1,
      lastTurnStatus: "queued",
      messages: [
        { role: "user", content: "Explain the routing module", status: "completed", turnId: null },
        { role: "assistant", content: "", status: "queued", turnId: result.turnId, headSha: "a".repeat(40) },
      ],
    });
    // 对话轮次不再进入 Worker 队列，只由 Server 内联领取。
    expect(store.claimNextWithLease(30_000)).toBeUndefined();
    expect(store.claimConversationTurn(result.turnId)).toMatchObject({
      conversationId: result.conversationId,
      turnId: result.turnId,
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      request: "Explain the routing module",
      attempt: 1,
    });
  });

  it("serializes conversation turns and reflects retry and cancellation states", async () => {
    store = await EventStore.open(":memory:");
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
    })).toThrow("conversation already has an active turn");

    expect(store.claimConversationTurn(created.turnId)).toMatchObject({ turnId: created.turnId, attempt: 1 });
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({ status: "running" });
    store.cancelConversationTurn(created.turnId, "This turn was cancelled.");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      status: "failed",
      content: "This turn was cancelled.",
      turnStatus: "cancelled",
    });
    expect(store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Try again after cancellation",
    }).turnId).toBeTruthy();
  });

  it("keeps a failed conversation turn out of the event retry path", async () => {
    store = await EventStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Retry this conversation turn",
    });
    expect(store.claimConversationTurn(created.turnId)).toBeTruthy();
    store.failConversationTurn(created.turnId, "failed", "temporary failure");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      status: "failed",
      turnStatus: "failed",
    });

    // 对话轮次已从 Worker 队列移除，重试只通过再次发送消息完成。
    expect(store.listEvents("queued", 10)).toEqual([]);
    expect(store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Do not overlap the retry",
    }).turnId).toBeTruthy();
  });

  it("exposes each conversation turn's own trajectory and execution records", async () => {
    store = await EventStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Explain the routing module",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    const traceId = store.startEventTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "llm",
      "conversation",
      "test/model",
      JSON.stringify({ systemPrompt: "Answer read-only.", userPrompt: "Explain routing." }),
      { round: 1, input: "conversation context" },
    );
    store.finishEventTrace(traceId, "succeeded", 80, 40, 20, undefined, "assistant response");
    store.recordExecutionStep({
      turnId: claimed.turnId,
      attempt: claimed.attempt,
      step: "workflow.read_only_conversation",
      status: "succeeded",
      input: { requestCharacters: 24 },
      output: { textBytes: 18 },
    });
    store.finishConversationTurn(claimed.turnId, "Routing lives in routing.ts.");

    const turn = store.getConversationTurn(created.conversationId, created.turnId);
    expect(turn).toMatchObject({
      conversationId: created.conversationId,
      messageId: expect.any(String),
      turnId: created.turnId,
      status: "completed",
      request: "Explain the routing module",
      headSha: "a".repeat(40),
      attemptCount: 1,
    });
    expect(turn?.trajectory).toHaveLength(1);
    expect(turn?.trajectory[0]).toMatchObject({ kind: "llm", status: "succeeded", output: "assistant response" });
    expect(turn?.events.some((step) => step.step === "workflow.read_only_conversation")).toBe(true);
    expect(turn?.timeline.some((transition) => transition.to === "completed")).toBe(true);
    // 轮次记录必须绑定到该对话，跨对话或未知轮次返回 undefined。
    expect(store.getConversationTurn("other-conversation", created.turnId)).toBeUndefined();
    expect(store.getConversationTurn(created.conversationId, "missing-turn")).toBeUndefined();
  });

  it("merges every turn of a conversation into one ordered timeline", async () => {
    store = await EventStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First question",
    });
    const first = store.claimConversationTurn(created.turnId);
    if (!first) throw new Error("expected the first turn to be claimed");
    const firstTrace = store.startEventTrace(
      { kind: "conversation", turnId: first.turnId },
      first.attempt,
      "llm",
      "conversation",
      "test/model",
      null,
      { round: 1, input: "first context" },
    );
    store.finishEventTrace(firstTrace, "succeeded", 50, 10, 5, undefined, "First answer.");
    store.recordExecutionStep({
      turnId: first.turnId,
      attempt: first.attempt,
      step: "workflow.read_only_conversation",
      status: "succeeded",
    });
    store.finishConversationTurn(first.turnId, "First answer.");

    const added = store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Second question",
    });
    const second = store.claimConversationTurn(added.turnId);
    if (!second) throw new Error("expected the second turn to be claimed");
    const secondTrace = store.startEventTrace(
      { kind: "conversation", turnId: second.turnId },
      second.attempt,
      "llm",
      "conversation",
      "test/model",
      null,
      { round: 1, input: "second context" },
    );
    store.finishEventTrace(secondTrace, "succeeded", 70, 12, 6, undefined, "Second answer.");
    store.recordExecutionStep({
      turnId: second.turnId,
      attempt: second.attempt,
      step: "workflow.read_only_conversation",
      status: "succeeded",
    });
    store.finishConversationTurn(second.turnId, "Second answer.");

    const merged = store.getConversationTurns(created.conversationId);
    expect(merged?.conversationId).toBe(created.conversationId);
    // 轮次按创建时间升序，轨迹条目各自带回所属轮次，前端据此分段。
    expect(merged?.turns.map((turn) => turn.turnId)).toEqual([first.turnId, second.turnId]);
    expect(merged?.turns.map((turn) => turn.request)).toEqual(["First question", "Second question"]);
    expect(merged?.trajectory.map((entry) => entry.output)).toEqual(["First answer.", "Second answer."]);
    expect(merged?.trajectory.map((entry) => entry.turnId)).toEqual([first.turnId, second.turnId]);
    expect(merged?.events).toHaveLength(2);
    // 未注册的对话返回 undefined，端点据此给出 404。
    expect(store.getConversationTurns("missing-conversation")).toBeUndefined();
  });

  it("counts conversation turns and surfaces the latest turn status", async () => {
    store = await EventStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ turnCount: 1, lastTurnStatus: "queued" });
    const first = store.claimConversationTurn(created.turnId);
    if (!first) throw new Error("expected the first conversation turn to be claimed");
    store.finishConversationTurn(first.turnId, "First answer");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      turnStatus: "completed",
      traceCount: 0,
      stepCount: 0,
      toolCalls: [],
    });
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ turnCount: 1, lastTurnStatus: "completed" });
  });

  it("fails queued and running conversation turns left behind by a Server restart", async () => {
    store = await EventStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    // 一个对话的轮次置为运行中、另一个保持排队，模拟进程退出时的残留状态。
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected the first conversation turn to be claimed");
    const queued = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Second turn",
    });

    expect(store.recoverInterruptedConversationTurns()).toBe(2);
    expect(store.getConversationTurn(created.conversationId, created.turnId)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("restarted"),
    });
    // 排队但尚未领取的轮次同样无法跨进程恢复。
    expect(store.getConversationTurn(queued.conversationId, queued.turnId)).toMatchObject({ status: "failed" });
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({ status: "failed" });
    // 再次运行没有残留可恢复，避免重复写审计。
    expect(store.recoverInterruptedConversationTurns()).toBe(0);
    // 失败的轮次不再阻塞同一对话发送新消息。
    expect(() => store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Third turn",
    })).not.toThrow();
  });

  it("surfaces each assistant turn's tool calls in the conversation listing", async () => {
    store = await EventStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Where is routing implemented?",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    const readTrace = store.startEventTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "tool",
      "read_file",
      "",
      null,
      { round: 1, input: JSON.stringify({ path: "src/routing.ts" }) },
    );
    store.finishEventTrace(readTrace, "succeeded", 42);
    const grepTrace = store.startEventTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "tool",
      "git_grep",
      "",
      null,
      { round: 1, input: JSON.stringify({ query: "createHash", path: "src" }) },
    );
    store.finishEventTrace(grepTrace, "failed", 7, undefined, undefined, "boom");
    store.finishConversationTurn(claimed.turnId, "Routing lives in routing.ts.");

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
    store = await EventStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    const first = store.claimConversationTurn(created.turnId);
    if (!first) throw new Error("expected the first conversation turn to be claimed");
    const llmTrace = store.startEventTrace(
      { kind: "conversation", turnId: first.turnId }, first.attempt, "llm", "conversation", "test/model", "{}", { round: 1 },
    );
    store.finishEventTrace(llmTrace, "succeeded", 120, 30, 12);
    const toolTrace = store.startEventTrace(
      { kind: "conversation", turnId: first.turnId }, first.attempt, "tool", "read_file", "test/model", "{}",
    );
    store.finishEventTrace(toolTrace, "succeeded", 40, 0, 0);
    store.finishConversationTurn(first.turnId, "First answer");

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

  it("queues Issue assistant events with a distinct issue target", async () => {
    store = await EventStore.open(":memory:");
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
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });

    const overview = store.operationsOverview();

    expect(overview.counts.queued).toBe(1);
    expect(overview.counts.completed).toBe(0);
    expect(overview.oldestQueuedAt).toBe(store.listEvents("queued", 10)[0]?.createdAt);
  });

  it("reports recent worker heartbeats in the operations overview", async () => {
    store = await EventStore.open(":memory:");
    store.heartbeatWorker("worker-1");

    const overview = store.operationsOverview();

    expect(overview.workers.onlineCount).toBe(1);
    expect(overview.workers.lastSeenAt).toEqual(expect.any(String));
  });

  it("filters and paginates operations events with a matching total", async () => {
    store = await EventStore.open(":memory:");
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

    const firstPage = store.listOperationsEvents({ projectId: 7, limit: 1, offset: 0 });
    const secondPage = store.listOperationsEvents({ projectId: 7, limit: 1, offset: 1 });

    expect(firstPage.total).toBe(2);
    expect(firstPage.items).toHaveLength(1);
    expect(secondPage.total).toBe(2);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  });

  it("reports queue and execution start times for operations event ages", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });

    const queued = store.listOperationsEvents({ limit: 10, offset: 0 }).items[0];
    expect(queued?.activityStartedAt).toBe(queued?.createdAt);

    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    const running = store.listOperationsEvents({ limit: 10, offset: 0 }).items[0];

    expect(running?.activityStartedAt).toBe(store.getEventDetails(event.id)?.attempts[0]?.startedAt);

    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "failed", "temporary failure");
    const retried = store.retryFailedEvent(event.id);
    const queuedAgain = store.listOperationsEvents({ limit: 10, offset: 0 }).items[0];

    expect(queuedAgain?.activityStartedAt).toBe(retried.updatedAt);
  });

  it("returns event details with the persisted attempt timeline", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "failed", "provider unavailable");

    const details = store.getEventDetails(event.id);

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
    expect(store.getEventDetails("missing-event")).toBeUndefined();
  });

  it("persists model and tool activity in the event trajectory", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");

    const modelCall = store.startEventTrace(
      { kind: "event", eventId: event.id },
      event.attemptCount,
      "llm",
      "review",
      "test/model",
      JSON.stringify({ systemPrompt: "Review safely.", userPrompt: "Inspect the diff." }),
      { round: 2, input: "review context" },
    );
    store.finishEventTrace(
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
    const toolCall = store.startEventTrace(
      { kind: "event", eventId: event.id },
      event.attemptCount,
      "tool",
      "read_file",
      "",
      '{"path":"README.md"}',
      { round: 2, input: '{"path":"README.md"}', schema: '{"type":"object"}' },
    );
    store.finishEventTrace(
      toolCall,
      "failed",
      18,
      undefined,
      undefined,
      "Error: ENOENT: file not found",
      "tool result",
    );

    expect(store.getEventDetails(event.id)?.trajectory).toEqual([
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

  it("persists redacted execution events before and after event creation", async () => {
    store = await EventStore.open(":memory:");
    const webhookEventId = store.startExecutionStep({
      deliveryId: "delivery-1",
      webhookEventId: "1:2",
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
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.finishExecutionStep(webhookEventId, "succeeded", 12, { accepted: true, token: "another-secret" });
    store.recordExecutionStep({
      eventId: event.id,
      attempt: event.attemptCount,
      step: "gitlab.get_project",
      status: "succeeded",
      input: { projectId: 7 },
      output: { id: 7, http_url_to_repo: "https://gitlab.example.com/project.git" },
    });

    const details = store.getEventDetails(event.id);
    const webhookEvent = details?.events.find((event) => event.step === "webhook.decode");
    expect(webhookEvent).toMatchObject({
      deliveryId: "delivery-1",
      webhookEventId: "1:2",
      eventId: event.id,
      attempt: null,
      status: "succeeded",
      output: JSON.stringify({ accepted: true, token: "[REDACTED]" }),
    });
    expect(webhookEvent?.input).not.toContain("must-not-be-persisted");
    expect(webhookEvent?.input).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(details?.events.find((event) => event.step === "gitlab.get_project")).toMatchObject({
      deliveryId: null,
      eventId: event.id,
      attempt: 1,
      status: "succeeded",
    });
    const boundedEventId = store.recordExecutionStep({
      eventId: event.id,
      attempt: event.attemptCount,
      step: "webhook.sanitize",
      status: "succeeded",
      input: {
        repositoryUrl: "https://user:pass@gitlab.example/project?private_token=private-value",
        note: "🧪".repeat(30_000),
      },
    });
    const boundedEvent = store.getEventDetails(event.id)?.events.find((event) => event.id === boundedEventId);
    expect(boundedEvent?.input).not.toContain("user:pass");
    expect(boundedEvent?.input).not.toContain("private-value");
    expect(Buffer.byteLength(boundedEvent?.input ?? "")).toBeLessThanOrEqual(64 << 10);
  });

  it("marks in-flight execution events interrupted when a worker lease expires", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const firstAttempt = store.claimNextWithLease(10);
    if (!firstAttempt) throw new Error("expected a queued event to be claimed");
    const webhookEventId = store.startExecutionStep({
      eventId: firstAttempt.id,
      attempt: firstAttempt.attemptCount,
      step: "gitlab.post_note",
      input: { body: "comment text" },
    });

    await sleep(20);
    const retry = store.claimNextWithLease(30_000);

    expect(retry).toMatchObject({ id: firstAttempt.id, attemptCount: 2 });
    expect(store.getEventDetails(firstAttempt.id)?.events).toEqual([
      expect.objectContaining({ id: webhookEventId, status: "interrupted", errorDetail: expect.stringContaining("lease expired") }),
    ]);
  });

  it("records execution step outputs and failures", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");

    await traceExecutionStep(
      store,
      { eventId: event.id, attempt: event.attemptCount },
      "gitlab.get_project",
      { projectId: 7 },
      async () => ({ id: 7, http_url_to_repo: "https://gitlab.example.com/project.git" }),
    );
    await expect(traceExecutionStep(
      store,
      { eventId: event.id, attempt: event.attemptCount },
      "gitlab.get_mr",
      { projectId: 7, mrIid: 3 },
      async () => {
        throw new Error("GitLab unavailable");
      },
    )).rejects.toThrow("GitLab unavailable");
    await expect(traceExecutionStep(
      store,
      { eventId: event.id, attempt: event.attemptCount },
      "gitlab.post_note",
      { body: "comment text" },
      async () => {
        throw new Error("connection closed before response");
      },
      undefined,
      () => "unknown",
    )).rejects.toThrow("connection closed before response");

    expect(store.getEventDetails(event.id)?.events).toMatchObject([
      { step: "gitlab.post_note", status: "unknown" },
      { step: "gitlab.get_mr", status: "failed", errorDetail: "GitLab unavailable" },
      { step: "gitlab.get_project", status: "succeeded", output: JSON.stringify({ id: 7, http_url_to_repo: "https://gitlab.example.com/project.git" }) },
    ]);
  });

  it("lists events and requeues a failed event that stopped before publishing", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "analyzing");
    store.updateLeasedStatus(event.id, event.leaseToken, "analyzing", "failed", "temporary API error");

    expect(store.retryFailedEvent(event.id).status).toBe("queued");
    expect(store.listEvents("queued", 10)).toHaveLength(1);
    expect(store.listEvents("failed", 10)).toHaveLength(0);
  });

  it("persists automatic retry availability and attempt history across restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-retry-"));
    const databasePath = join(directory, "state.db");
    store = await EventStore.open(databasePath);
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "analyzing");
    const availableAt = Date.now() + 60_000;

    expect(store.retryLeasedEvent(event.id, event.leaseToken, "analyzing", availableAt, "temporary API failure")).toBe(true);
    expect(store.claimNextWithLease(30_000)).toBeUndefined();
    store.close();
    store = await EventStore.open(databasePath);

    expect(store.claimNextWithLease(30_000)).toBeUndefined();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE events SET available_at=0 WHERE id=?").run(event.id);
    database.close();

    const retry = store.claimNextWithLease(30_000);
    expect(retry).toMatchObject({ id: event.id, attemptCount: 2, status: "preparing" });
    expect(store.getEventDetails(event.id)?.attempts).toMatchObject([
      { attempt: 1, error: "temporary API failure", finishedAt: expect.any(String) },
      { attempt: 2, error: "", finishedAt: null },
    ]);
    expect(store.getEventDetails(event.id)?.timeline.map(({ from, to }) => [from, to])).toEqual([
      ["queued", "preparing"],
      ["preparing", "analyzing"],
      ["analyzing", "queued"],
      ["queued", "preparing"],
    ]);
  });

  it("does not automatically retry beyond the maximum attempt count", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      const event = store.claimNextWithLease(30_000);
      if (!event) throw new Error("expected a queued event to be claimed");
      store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "analyzing");
      expect(store.retryLeasedEvent(event.id, event.leaseToken, "analyzing", Date.now(), `failure ${attempt}`))
        .toBe(attempt < 3);
      if (attempt === 3) {
        expect(store.getEvent(event.id).status).toBe("analyzing");
      }
    }
  });

  it("does not allow an operator retry after entering publishing", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "analyzing");
    store.updateLeasedStatus(event.id, event.leaseToken, "analyzing", "publishing");
    store.updateLeasedStatus(event.id, event.leaseToken, "publishing", "failed", "GitLab request failed");

    expect(() => store.retryFailedEvent(event.id)).toThrow("publishing failures cannot be retried");
  });

  it("prunes terminal event history using a valid parameterized status filter", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "failed", "test failure");

    expect(() => store.pruneHistory(new Date(Date.now() + 86_400_000), new Date(Date.now() + 86_400_000))).not.toThrow();
    expect(store.eventCounts().failed ?? 0).toBe(0);
  });

  it("prunes idle conversations with their messages but keeps conversations with an active reply", async () => {
    store = await EventStore.open(":memory:");
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
    expect(store.claimConversationTurn(idle.turnId)).toBeTruthy();
    store.finishConversationTurn(idle.turnId, "The repository has a src and test tree.");

    store.pruneHistory(new Date(Date.now() + 86_400_000), new Date(Date.now() + 86_400_000));

    expect(store.getConversation(idle.conversationId)).toBeUndefined();
    const kept = store.getConversation(active.conversationId);
    expect(kept?.messages).toHaveLength(2);
    expect(kept?.messages[1]).toMatchObject({ id: activeResponseId, status: "queued" });
  });

  it("checks token reservations and records model call metrics", async () => {
    store = await EventStore.open(":memory:");
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
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(30_000);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "analyzing");
    expect(store.cancel("event-2", 7, 3, 11).response).toContain("Cancellation requested");
    expect(store.cancellationRequested(event.id, event.leaseToken)).toBe(true);
    expect(() =>
      store.updateLeasedStatus(event.id, event.leaseToken, "analyzing", "publishing"),
    ).toThrow("event cancellation requested");
    store.updateLeasedStatus(event.id, event.leaseToken, "analyzing", "cancelled");
    expect(store.getEvent(event.id).status).toBe("cancelled");
  });

  it("records cancellation of a queued task in its lifecycle timeline", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.listEvents("queued", 1)[0];
    if (!event) throw new Error("expected a queued event");

    store.cancel("event-2", 7, 3, 11);

    expect(store.getEventDetails(event.id)).toMatchObject({
      status: "cancelled",
      timeline: [{ from: "queued", to: "cancelled", at: expect.any(String) }],
    });
  });

  it("does not retry after an expired publishing lease", async () => {
    store = await EventStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const event = store.claimNextWithLease(250);
    if (!event) throw new Error("expected a queued event to be claimed");
    store.updateLeasedStatus(event.id, event.leaseToken, "preparing", "analyzing");
    store.updateLeasedStatus(event.id, event.leaseToken, "analyzing", "publishing");
    await sleep(300);
    expect(store.claimNextWithLease(30_000)).toBeUndefined();
    expect(store.getEvent(event.id).status).toBe("failed");
    expect(store.getEvent(event.id).lastError).toContain("outcome is uncertain");
  });

  it("migrates an existing legacy SQLite event database without losing queued events", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-legacy-store-"));
    const databasePath = join(directory, "state.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, webhook_event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, status TEXT NOT NULL, project_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL,
        head_sha TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL, request TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE event_trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER
      );
      INSERT INTO events
        (id,idempotency_key,webhook_event_id,type,status,project_id,mr_iid,head_sha,actor_id,request,created_at,updated_at)
      VALUES
        ('legacy-event','legacy-key','legacy-event','review','queued',9,5,'${"c".repeat(40)}',12,'','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z'),
        ('legacy-failed','legacy-failed-key','legacy-failed-event','review','failed',9,5,'${"d".repeat(40)}',12,'','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
    `);
    legacy.close();

    store = await EventStore.open(databasePath);
    expect(store.getEvent("legacy-event")).toMatchObject({
      projectId: 9,
      mrIid: 5,
      status: "queued",
      attemptCount: 0,
      leaseToken: "",
      cancellationRequested: false,
    });
    expect(() => store.retryFailedEvent("legacy-failed")).toThrow("failure stage is unknown");
    const traceId = store.startEventTrace(
      { kind: "event", eventId: "legacy-event" }, 1, "llm", "review", "test/model", "legacy prompt",
    );
    store.finishEventTrace(traceId, "failed", 10, undefined, undefined, "legacy trace error");
    expect(store.getEventDetails("legacy-event")?.trajectory[0]?.rawContent).toBe("legacy prompt");
    expect(store.getEventDetails("legacy-event")?.trajectory[0]?.errorDetail).toBe("legacy trace error");
    expect(store.getEventDetails("legacy-event")?.trajectory[0]).toMatchObject({
      firstTokenMs: null,
      generationDurationMs: null,
    });
    expect(store.claimNextWithLease(30_000)?.id).toBe("legacy-event");
  });

  it("renames legacy session tables and columns while keeping conversations readable", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-legacy-session-"));
    const databasePath = join(directory, "state.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, webhook_event_id TEXT NOT NULL UNIQUE,
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
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, event_id TEXT,
        head_sha TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO chat_sessions
        (id,project_id,project_name,target_type,target_iid,target_branch,target_title,created_at,updated_at)
      VALUES
        ('legacy-session',7,'group/project','merge_request',5,'feature/session','Old MR title','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
      INSERT INTO chat_session_messages
        (id,session_id,role,content,status,event_id,head_sha,created_at,updated_at)
      VALUES
        ('legacy-message','legacy-session','user','Hello','completed',NULL,'a','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
    `);
    legacy.close();

    store = await EventStore.open(databasePath);
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

  it("migrates the legacy job-named tables so conversations and metrics stay readable", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-legacy-jobs-"));
    const databasePath = join(directory, "state.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, status TEXT NOT NULL, project_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'merge_request', target_iid INTEGER NOT NULL DEFAULT 0,
        target_branch TEXT NOT NULL DEFAULT '', head_sha TEXT NOT NULL DEFAULT '',
        actor_id INTEGER NOT NULL, request TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, failure_stage TEXT NOT NULL DEFAULT '',
        available_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, project_name TEXT NOT NULL,
        target_branch TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE conversation_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, job_id TEXT,
        head_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE job_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, error TEXT NOT NULL DEFAULT '', UNIQUE(job_id,attempt)
      );
      CREATE TABLE job_trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL, round INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, trace_input TEXT, trace_output TEXT, trace_schema TEXT,
        raw_content TEXT, error_detail TEXT, request_started_at TEXT, response_headers_ms INTEGER
      );
      CREATE TABLE execution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT, event_id TEXT,
        job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
        attempt INTEGER, step TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        duration_ms INTEGER, input_json TEXT, output_json TEXT, error_detail TEXT
      );
      CREATE TABLE webhook_events (
        event_id TEXT PRIMARY KEY, response TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL
      );
      CREATE TABLE model_call_metrics (
        task_type TEXT NOT NULL, outcome TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_type,outcome)
      );
      INSERT INTO jobs
        (id,idempotency_key,event_id,type,status,project_id,mr_iid,actor_id,request,created_at,updated_at)
      VALUES
        ('legacy-job','key-legacy','wh-legacy','conversation','completed',7,3,11,'','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
      INSERT INTO conversations VALUES
        ('legacy-conversation',7,'group/project','main','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
      INSERT INTO conversation_messages VALUES
        ('legacy-msg','legacy-conversation','assistant','Answer','completed','legacy-job','${"a".repeat(40)}','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
      INSERT INTO job_trace
        (job_id,attempt,round,kind,name,status,started_at,finished_at,duration_ms,model)
      VALUES
        ('legacy-job',1,1,'llm','chat','succeeded','2025-01-01T00:00:00.000Z','2025-01-01T00:00:01.000Z',1000,'test-model');
      INSERT INTO execution_events (event_id,job_id,attempt,step,status,started_at)
      VALUES ('wh-legacy','legacy-job',1,'prepare','succeeded','2025-01-01T00:00:00.000Z');
      INSERT INTO model_call_metrics (task_type,outcome,calls) VALUES ('session','success',3);
    `);
    legacy.close();

    store = await EventStore.open(databasePath);
    const conversation = store.getConversation("legacy-conversation");
    expect(conversation?.messages[0]).toMatchObject({ id: "legacy-msg", content: "Answer", turnId: "legacy-job" });
    expect(conversation?.messages[0]?.traceCount).toBe(1);
    expect(conversation?.messages[0]?.stepCount).toBe(1);
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ id: "legacy-conversation", turnCount: 1 });
    expect(store.modelCallMetrics()).toContainEqual(
      expect.objectContaining({ taskType: "conversation", calls: 3 }),
    );
    const inspector = new DatabaseSync(databasePath);
    const tableNames = (inspector.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((row) => row.name);
    const eventColumns = (inspector.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((c) => c.name);
    const traceColumns = (inspector.prepare("PRAGMA table_info(event_trace)").all() as { name: string }[]).map((c) => c.name);
    const stepColumns = (inspector.prepare("PRAGMA table_info(execution_steps)").all() as { name: string }[]).map((c) => c.name);
    const messageColumns = (inspector.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[]).map((c) => c.name);
    inspector.close();
    expect(tableNames).toContain("events");
    expect(tableNames).toContain("event_trace");
    expect(tableNames).toContain("execution_steps");
    expect(tableNames).toContain("webhook_deliveries");
    expect(tableNames).not.toContain("jobs");
    expect(tableNames).not.toContain("job_trace");
    expect(tableNames).not.toContain("execution_events");
    expect(tableNames).not.toContain("webhook_events");
    expect(eventColumns).toContain("webhook_event_id");
    expect(eventColumns).not.toContain("event_id");
    expect(traceColumns).toContain("turn_id");
    expect(stepColumns).toContain("turn_id");
    expect(messageColumns).toContain("turn_id");
    expect(messageColumns).not.toContain("job_id");
  });
});
