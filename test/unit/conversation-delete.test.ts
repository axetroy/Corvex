import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationRunner } from "../../src/app/conversation-runner.js";
import { CorvexServer } from "../../src/app/server.js";
import {
  callAsyncHook,
  createCorvexHooks,
  type ConversationDeleteContext,
  type StorageCleanupContext,
} from "../../src/app/hooks.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { AppStore } from "../../src/store.js";

let config: CorvexConfig;
let storageRoot = "";

beforeEach(async () => {
  // 用临时目录作 storage root，避免 Server/清理钩子在仓库里留下 data/mirrors、data/workspaces。
  storageRoot = await mkdtemp(join(tmpdir(), "corvex-delete-"));
  config = {
    server: { listen: "127.0.0.1:0" },
    storage: { root: storageRoot, database: join(storageRoot, "state.db") },
    gitlab: { baseUrl: "https://gitlab.example.com" },
    agent: { responseLanguage: "en", model: "test-model", contextWindow: 131_072 },
  } as unknown as CorvexConfig;
});

function deleteContext(conversationId: string, projectId = 7): ConversationDeleteContext {
  return {
    conversationId,
    projectId,
    reason: "delete",
    turnIds: ["turn-1", "turn-2"],
    errors: [],
  };
}

describe("conversation delete cleanup hook", () => {
  let store: AppStore | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
    storageRoot = "";
  });

  it("runs the default git tap and plugin taps for every cleanup reason", async () => {
    store = await AppStore.open(":memory:");
    const hooks = createCorvexHooks();
    const runner = new ConversationRunner(config, store, hooks);
    const discard = vi.spyOn(runner, "discardConversationChanges").mockResolvedValue(undefined);
    const seen: string[] = [];
    hooks.conversationDelete.tap({ name: "test-plugin", stage: 500 }, (context) => {
      seen.push(`${context.conversationId}:${context.reason}:${context.turnIds.length}`);
    });

    for (const reason of ["delete", "changes", "retention"] as const) {
      const context = deleteContext("conv-1");
      context.reason = reason;
      await callAsyncHook(hooks.conversationDelete, context);
      expect(context.errors).toEqual([]);
    }
    expect(discard).toHaveBeenCalledTimes(3);
    expect(discard).toHaveBeenCalledWith("conv-1", 7);
    expect(seen).toEqual([
      "conv-1:delete:2",
      "conv-1:changes:2",
      "conv-1:retention:2",
    ]);
  });

  it("isolates a failing default tap without blocking later taps", async () => {
    store = await AppStore.open(":memory:");
    const hooks = createCorvexHooks();
    const runner = new ConversationRunner(config, store, hooks);
    vi.spyOn(runner, "discardConversationChanges").mockRejectedValue(new Error("git cleanup failed"));
    const pluginTap = vi.fn();
    hooks.conversationDelete.tap({ name: "test-plugin", stage: 500 }, pluginTap);

    const context = deleteContext("conv-2", 9);
    await callAsyncHook(hooks.conversationDelete, context);

    expect(context.errors).toEqual(["git cleanup failed"]);
    expect(pluginTap).toHaveBeenCalledOnce();
    expect(pluginTap.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "conv-2",
      projectId: 9,
      errors: ["git cleanup failed"],
    });
  });
});

describe("conversation snapshot retention", () => {
  let store: AppStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("deletes context snapshots with an explicitly deleted conversation", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "delete me",
    });
    store.saveContextSnapshot({
      conversationId: created.conversationId,
      turnId: created.turnId,
      requestSeq: 1,
      createdAt: new Date().toISOString(),
      contextWindow: 8000,
      reservedOutput: 1024,
      threshold: 85,
      estimatedTokens: 10,
      breakdown: { system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 0 },
      counts: { system: 1, tools: 1, user: 1, inject: 0, assistant: 1, tool: 0 },
      items: [],
      truncated: false,
    });
    expect(store.contextSnapshots(created.conversationId)).toHaveLength(1);

    expect(store.deleteConversation(created.conversationId)).toBe(true);
    expect(store.contextSnapshots(created.conversationId)).toEqual([]);
  });

  it("returns pruned conversation targets and removes their snapshots", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      store = await AppStore.open(":memory:");
      const base = {
        projectId: 7,
        projectName: "group/project",
        targetBranch: "main",
        headSha: "a".repeat(40),
        actorId: 0,
      };
      const old = store.createConversation({ ...base, request: "old" });
      store.claimConversationTurn(old.turnId);
      store.finishConversationTurn(old.turnId, "done", "test-model");
      store.saveContextSnapshot({
        conversationId: old.conversationId,
        turnId: old.turnId,
        requestSeq: 1,
        createdAt: new Date().toISOString(),
        contextWindow: 8000,
        reservedOutput: 1024,
        threshold: 85,
        estimatedTokens: 10,
        breakdown: { system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 0 },
        counts: { system: 1, tools: 1, user: 1, inject: 0, assistant: 1, tool: 0 },
        items: [],
        truncated: false,
      });

      vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
      const keep = store.createConversation({ ...base, request: "keep" });
      store.claimConversationTurn(keep.turnId);
      store.finishConversationTurn(keep.turnId, "done", "test-model");
      store.saveContextSnapshot({
        conversationId: keep.conversationId,
        turnId: keep.turnId,
        requestSeq: 1,
        createdAt: new Date().toISOString(),
        contextWindow: 8000,
        reservedOutput: 1024,
        threshold: 85,
        estimatedTokens: 10,
        breakdown: { system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 0 },
        counts: { system: 1, tools: 1, user: 1, inject: 0, assistant: 1, tool: 0 },
        items: [],
        truncated: false,
      });

      const targets = store.pruneHistory(
        new Date("2026-01-15T00:00:00Z"),
        new Date("2026-03-01T00:00:00Z"),
      );

      expect(targets).toEqual([{
        conversationId: old.conversationId,
        projectId: 7,
        turnIds: [old.turnId],
      }]);
      expect(store.contextSnapshots(old.conversationId)).toEqual([]);
      expect(store.contextSnapshots(keep.conversationId)).toHaveLength(1);
      expect(store.getConversation(old.conversationId)).toBeUndefined();
      expect(store.getConversation(keep.conversationId)).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires the delete hook for every conversation pruned by retention", async () => {
    vi.spyOn(ConversationRunner.prototype, "discardConversationChanges").mockResolvedValue(undefined);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      store = await AppStore.open(":memory:");
      const old = store.createConversation({
        projectId: 7,
        projectName: "group/project",
        targetBranch: "main",
        headSha: "a".repeat(40),
        actorId: 0,
        request: "old",
      });
      store.claimConversationTurn(old.turnId);
      store.finishConversationTurn(old.turnId, "done", "test-model");
      vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));

      const hooks = createCorvexHooks();
      // 只构造 Server 以注册默认清理 taps，不启动监听。
      new CorvexServer(config, store, undefined, hooks);
      const seen: ConversationDeleteContext[] = [];
      hooks.conversationDelete.tap("test", (context) => { seen.push({ ...context }); });

      const context: StorageCleanupContext = {
        source: "retention",
        startedAt: new Date().toISOString(),
        retentionDays: 30,
        pruneHistory: true,
        historyBefore: new Date("2026-02-01T00:00:00Z"),
        auditBefore: new Date("2026-03-01T00:00:00Z"),
        removedWorkspaces: 0,
        removedRefs: 0,
        gcCount: 0,
        errors: [],
      };
      await callAsyncHook(hooks.storageCleanup, context);

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        conversationId: old.conversationId,
        projectId: 7,
        reason: "retention",
        turnIds: [old.turnId],
      });
      expect(context.errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
