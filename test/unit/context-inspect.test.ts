import { describe, expect, it, vi } from "vitest";
import { buildContextSnapshotData, createContextInspectExtension } from "../../src/agent/context-inspect.ts";
import { ConversationRunner } from "../../src/app/conversation-runner.ts";
import { callAsyncHook, createCorvexHooks } from "../../src/app/hooks.ts";
import type { CorvexConfig } from "../../src/config/config.ts";
import { AppStore } from "../../src/store.ts";

const counter = (tokens: number | undefined = 1200) => ({
  available: tokens !== undefined,
  count: vi.fn(async () => tokens),
});

function message(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { role, content: [{ type: "text", text }], ...extra };
}

async function build(messages: Record<string, unknown>[]) {
  return buildContextSnapshotData(messages, {
    conversationId: "conv-1",
    turnId: "turn-1",
    requestSeq: 1,
    contextWindow: 8000,
    reservedOutput: 1024,
    threshold: 85,
    tokenCounter: counter(),
  });
}

describe("context inspection", () => {
  it("splits messages into categories and counts tokens", async () => {
    const snapshot = await build([
      message("system", "You are Corvex.", { tools: [{ name: "read_file" }] }),
      message("user", "Review the repo"),
      message("assistant", "I will inspect it."),
      message("toolResult", "file contents", { toolName: "read_file" }),
    ]);
    expect(snapshot.breakdown.system).toBeGreaterThan(0);
    expect(snapshot.breakdown.tools).toBeGreaterThan(0);
    expect(snapshot.breakdown.user).toBeGreaterThan(0);
    expect(snapshot.breakdown.assistant).toBeGreaterThan(0);
    expect(snapshot.breakdown.tool).toBeGreaterThan(0);
    expect(snapshot.counts.tool).toBe(1);
    expect(snapshot.estimatedTokens).toBe(1200);
    expect(snapshot.items.map((item) => item.name)).toContain("read_file");
  });

  it("redacts previews and caps item count", async () => {
    const tokenCounter = counter(5000);
    const result = await buildContextSnapshotData(
      Array.from({ length: 120 }, (_, index) => message("user", `token=secret-${index} ${"x".repeat(50)}`)),
      {
        conversationId: "conv-1", turnId: "turn-1", requestSeq: 3,
        contextWindow: 8000, reservedOutput: 1024, threshold: 85,
        tokenCounter, maxItems: 10, maxPreviewChars: 40,
      },
    );
    expect(result.items).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result.items)).not.toContain("secret-0");
    expect(result.items[0]?.preview.length).toBeLessThanOrEqual(40);
  });

  it("keeps the newest items and passes the abort signal to the token counter", async () => {
    const tokenCounter = counter(5000);
    const controller = new AbortController();
    const result = await buildContextSnapshotData(
      Array.from({ length: 6 }, (_, index) => message("user", `message-${index}`)),
      {
        conversationId: "conv-1", turnId: "turn-1", requestSeq: 1,
        contextWindow: 8000, reservedOutput: 1024, threshold: 85,
        tokenCounter, maxItems: 2, signal: controller.signal,
      },
    );
    expect(result.items.map((item) => item.preview)).toEqual(["message-4", "message-5"]);
    expect(result.truncated).toBe(true);
    expect(tokenCounter.count).toHaveBeenCalledWith(expect.any(String), controller.signal);
  });

  it("flows from the SDK extension through the hook into the store", async () => {
    const store = await AppStore.open(":memory:");
    try {
      const created = store.createConversation({
        projectId: 7, projectName: "group/project", targetBranch: "main",
        headSha: "a".repeat(40), actorId: 0, request: "hook chain",
      });
      const hooks = createCorvexHooks();
      const config = {
        storage: { root: "data" },
        gitlab: { baseUrl: "https://gitlab.example.com" },
        agent: { responseLanguage: "en", model: "test" },
      } as unknown as CorvexConfig;
      new ConversationRunner(config, store, hooks);

      let handler: ((event: { messages: unknown[] }) => Promise<void> | void) | undefined;
      const extension = createContextInspectExtension({
        conversationId: created.conversationId, turnId: created.turnId,
        contextWindow: 8000, reservedOutput: 1024, threshold: 85,
        tokenCounter: counter(),
        onSnapshot: (snapshot) => callAsyncHook(hooks.contextSnapshot, snapshot),
      });
      extension({ on: (name: string, fn: typeof handler) => {
        if (name === "context_with_system") handler = fn;
      } } as never);
      await handler!({ messages: [message("user", "Review the repo")] });

      const snapshots = store.contextSnapshots(created.conversationId);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.breakdown.user).toBeGreaterThan(0);
      expect(store.contextSnapshot(created.conversationId, snapshots[0]!.requestSeq)?.items).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("falls back to conservative estimation when the provider counter fails", async () => {
    const result = await buildContextSnapshotData([message("user", "你好世界")], {
      conversationId: "conv-1", turnId: "turn-1", requestSeq: 1,
      contextWindow: 8000, reservedOutput: 1024, threshold: null,
      tokenCounter: counter(undefined),
    });
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("emits one snapshot per request through a Pi extension", async () => {
    const snapshots: number[] = [];
    let handler: ((event: { messages: unknown[] }) => Promise<void> | void) | undefined;
    const pi = {
      on: (name: string, fn: typeof handler) => {
        if (name === "context_with_system") handler = fn;
      },
    };
    const extension = createContextInspectExtension({
      conversationId: "conv-1", turnId: "turn-1",
      contextWindow: 8000, reservedOutput: 1024, threshold: 85,
      tokenCounter: counter(),
      onSnapshot: (snapshot) => { snapshots.push(snapshot.requestSeq); },
    });
    extension(pi as never);
    expect(handler).toBeDefined();
    await handler!({ messages: [message("user", "hello")] });
    await handler!({ messages: [message("user", "again")] });
    expect(snapshots).toEqual([1, 2]);
  });
});
