import { afterEach, describe, expect, it, vi } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { AppStore } from "../../src/store.js";
import { ConversationRunner } from "../../src/app/conversation-runner.js";
import { ScheduledTasksScheduler } from "../../src/app/scheduled-tasks.js";
import type { GitLabClient } from "../../src/gitlab/client.js";

describe("ScheduledTasksScheduler", () => {
  let store: AppStore | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
  });

  async function makeScheduler(options: {
    now: () => number;
    clientForUser: (userId: string) => Promise<GitLabClient | undefined>;
  }) {
    const realStore = await AppStore.open(":memory:");
    store = realStore;
    const created = realStore.createConversation({
      ownerUserId: "u1", projectId: 7, projectName: "g/p", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "owner",
    });
    // 会话初始轮次先收尾，否则定时任务会被“已有活动轮次”挡住。
    realStore.claimConversationTurn(created.turnId);
    realStore.finishConversationTurn(created.turnId, "owner answer", "test-model");
    const config = {
      agent: { responseLanguage: "en" },
    } as unknown as CorvexConfig;
    const runTurn = vi.fn(async () => true);
    const conversations = { runTurn } as unknown as ConversationRunner;
    const scheduler = new ScheduledTasksScheduler({
      config, store: realStore, conversations,
      clientForUser: options.clientForUser, now: options.now,
    });
    return { scheduler, store: realStore, created, runTurn };
  }

  const dueAt = (): number => Date.parse("2026-11-27T09:00:00.000Z");

  function fakeClient(): GitLabClient {
    return {
      getBranch: vi.fn(async () => ({ commit: { id: "b".repeat(40) } })),
    } as unknown as GitLabClient;
  }

  it("runs a due task as a turn with a fresh branch snapshot", async () => {
    const nowMs = dueAt();
    const { scheduler, store: s, created, runTurn } = await makeScheduler({
      now: () => nowMs,
      clientForUser: async () => fakeClient(),
    });
    const task = s.createScheduledTask({
      ownerUserId: "u1", conversationId: created.conversationId, prompt: "check CI",
      kind: "cron", cron: "0 9 * * *", runAt: "", nextRunAt: "2026-11-27T09:00:00.000Z",
      expiresAt: "2026-12-27T09:00:00.000Z",
    });
    scheduler.tick();
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1));
    const [turnId, signal, client, language, drain] = runTurn.mock.calls[0]!;
    expect(turnId).toBeTruthy();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(client).toBeTruthy();
    expect(language).toBe("en");
    expect(drain).toBe(false);
    // 同一轮 tick 内不重复触发；next_run_at 已推进。
    scheduler.tick();
    expect(runTurn).toHaveBeenCalledTimes(1);
    const after = s.getScheduledTask(task.id)!;
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(Date.parse("2026-11-28T09:00:00.000Z"));
    expect(Date.parse(after.nextRunAt)).toBeLessThanOrEqual(Date.parse("2026-11-28T09:30:00.000Z"));
    expect(after.lastStatus).toBe("succeeded");
  });

  it("skips a task when the owner token is unavailable", async () => {
    const nowMs = dueAt();
    const { scheduler, store: s, created, runTurn } = await makeScheduler({
      now: () => nowMs,
      clientForUser: async () => undefined,
    });
    const task = s.createScheduledTask({
      ownerUserId: "u1", conversationId: created.conversationId, prompt: "check CI",
      kind: "once", cron: "", runAt: "2026-11-27T09:00:00.000Z", nextRunAt: "2026-11-27T09:00:00.000Z", expiresAt: "",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    scheduler.tick();
    await vi.waitFor(() => expect(s.getScheduledTask(task.id)).toBeUndefined());
    expect(runTurn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("runNow executes once without changing the recurring schedule", async () => {
    const nowMs = dueAt();
    const { scheduler, store: s, created, runTurn } = await makeScheduler({
      now: () => nowMs,
      clientForUser: async () => fakeClient(),
    });
    const task = s.createScheduledTask({
      ownerUserId: "u1", conversationId: created.conversationId, prompt: "check CI",
      kind: "cron", cron: "0 9 * * *", runAt: "", nextRunAt: "2026-11-28T09:00:00.000Z",
      expiresAt: "2026-12-27T09:00:00.000Z",
    });
    expect(await scheduler.runNow(task.id)).toBe(true);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(s.getScheduledTask(task.id)!.nextRunAt).toBe("2026-11-28T09:00:00.000Z");
    expect(s.listScheduledTaskRuns(task.id)).toHaveLength(1);
    // 重复触发被 inFlight 之外的状态检查拦截（任务仍 active，但这里验证不会并发重复启动模型轮）。
    expect(await scheduler.runNow("missing")).toBe(false);
  });

  it("recover advances overdue tasks without executing them", async () => {
    const nowMs = dueAt() + 12 * 60 * 60_000; // 触发时间过了 12 小时
    const { scheduler, store: s, created, runTurn } = await makeScheduler({
      now: () => nowMs,
      clientForUser: async () => fakeClient(),
    });
    const task = s.createScheduledTask({
      ownerUserId: "u1", conversationId: created.conversationId, prompt: "check CI",
      kind: "cron", cron: "0 9 * * *", runAt: "", nextRunAt: "2026-11-27T09:00:00.000Z",
      expiresAt: "2026-12-27T09:00:00.000Z",
    });
    scheduler.recover();
    expect(runTurn).not.toHaveBeenCalled();
    expect(s.getScheduledTask(task.id)!.nextRunAt).not.toBe("2026-11-27T09:00:00.000Z");
    scheduler.tick();
    expect(runTurn).not.toHaveBeenCalled();
  });
});
