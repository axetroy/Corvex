import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationRunner } from "../../src/app/conversation-runner.js";
import { createCorvexHooks } from "../../src/app/hooks.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { AppStore } from "../../src/store.js";
import type { GitLabClient } from "../../src/gitlab/client.js";

const config = {
  storage: { root: "data", database: "data/state.db" },
  gitlab: { baseUrl: "https://gitlab.example.com", readToken: "read", writeToken: "write" },
  agent: { responseLanguage: "en", model: "test-model", contextWindow: 131_072 },
} as unknown as CorvexConfig;

describe("queued conversation follow-ups", () => {
  let store: AppStore | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
  });

  it("starts queued messages in FIFO order with a fresh branch snapshot", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Original turn",
    });
    // 模拟首轮已经结束，排队项才具备启动条件。
    store.claimConversationTurn(created.turnId);
    store.finishConversationTurn(created.turnId, "Original answer", "test-model");
    store.enqueueFollowUp(created.conversationId, "first follow-up");
    store.enqueueFollowUp(created.conversationId, "second follow-up");
    const runner = new ConversationRunner(config, store, {} as GitLabClient, createCorvexHooks());
    const db = store;
    const started: string[] = [];
    const runTurn = vi.spyOn(runner, "runTurn").mockImplementation(async (turnId) => {
      started.push(turnId);
      db.claimConversationTurn(turnId);
      db.finishConversationTurn(turnId, "Follow-up answer", "test-model");
      return true;
    });
    const gitlab = {
      getBranch: vi.fn().mockResolvedValue({ name: "main", commit: { id: "b".repeat(40) } }),
    } as unknown as GitLabClient;

    await runner.drainFollowUps(created.conversationId, gitlab);

    expect(started).toHaveLength(2);
    expect(store.listFollowUps(created.conversationId)).toEqual([]);
    const turns = store.getConversation(created.conversationId)?.messages
      .filter((message) => message.role === "user")
      .map((message) => ({ content: message.content, headSha: message.headSha }));
    expect(turns).toEqual([
      { content: "Original turn", headSha: "a".repeat(40) },
      { content: "first follow-up", headSha: "b".repeat(40) },
      { content: "second follow-up", headSha: "b".repeat(40) },
    ]);
    expect(runTurn).toHaveBeenCalledTimes(2);
  });

  it("restores the item and stops draining when the branch cannot be resolved", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Original turn",
    });
    store.enqueueFollowUp(created.conversationId, "retry me");
    const runner = new ConversationRunner(config, store, {} as GitLabClient, createCorvexHooks());
    const runTurn = vi.spyOn(runner, "runTurn").mockResolvedValue(true);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gitlab = {
      getBranch: vi.fn().mockRejectedValue(new Error("GitLab is down")),
    } as unknown as GitLabClient;

    await runner.drainFollowUps(created.conversationId, gitlab);

    expect(runTurn).not.toHaveBeenCalled();
    expect(store.listFollowUps(created.conversationId).map((item) => item.content)).toEqual(["retry me"]);
    expect(warning).toHaveBeenCalledWith("queued conversation follow-up could not start", expect.anything());
  });
});
