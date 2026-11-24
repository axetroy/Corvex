import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createMicrocompactExtension,
  microcompactMessages,
  resolveMicrocompactPolicy,
} from "../../src/agent/microcompact.ts";

function toolResult(text: string, index: number): Record<string, unknown> {
  return {
    role: "toolResult",
    toolName: "read_file",
    toolCallId: `call-${index}`,
    content: [{ type: "text", text: `${index}:${text}` }],
  };
}

function extensionHarness(options: Parameters<typeof createMicrocompactExtension>[0]) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    on: (event: string, callback: (event: unknown) => unknown) => {
      handlers.set(event, callback);
      return () => undefined;
    },
  } as unknown as ExtensionAPI;
  createMicrocompactExtension(options)(pi);
  return (messages: Record<string, unknown>[]) => handlers.get("context")?.({ messages }) as
    | { messages: Record<string, unknown>[] }
    | undefined;
}

describe("microcompact messages", () => {
  it("keeps recent tool results intact and shortens older ones", () => {
    const messages = [
      { role: "user", content: "question" },
      toolResult("x".repeat(1000), 0),
      toolResult("y".repeat(1000), 1),
      toolResult("z".repeat(1000), 2),
    ];
    const result = microcompactMessages(messages, { keepRecent: 2, maxKeptChars: 100 });
    expect(result.changed).toBe(true);
    expect(result.pruned).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.identity).toBe("call-0");
    expect(result.messages[1]?.content).not.toEqual(messages[1]?.content);
    expect(result.messages[2]).toBe(messages[2]);
    expect(result.messages[3]).toBe(messages[3]);
    expect(result.savedChars).toBeGreaterThan(0);
  });

  it("leaves small results untouched", () => {
    const messages = [toolResult("short", 0)];
    const result = microcompactMessages(messages, { keepRecent: 0, maxKeptChars: 100 });
    expect(result.changed).toBe(false);
    expect(result.messages[0]).toBe(messages[0]);
  });
});

describe("microcompact policy", () => {
  it("scales keep-recent and raises the trigger with the context window", () => {
    const small = resolveMicrocompactPolicy(32_768, 85);
    const large = resolveMicrocompactPolicy(524_288, 85);
    expect(small.keepRecent).toBeLessThan(large.keepRecent);
    expect(large.maxKeptChars).toBeGreaterThan(small.maxKeptChars);
    expect(large.triggerTokens).toBe(Math.floor(524_288 * 0.7));
    expect(small.triggerTokens).toBe(Math.floor(32_768 * 0.7));
  });

  it("stays below the compaction threshold", () => {
    const policy = resolveMicrocompactPolicy(524_288, 85);
    expect(policy.triggerTokens).toBeLessThan(524_288 * 0.85);
  });
});

describe("microcompact extension", () => {
  it("does not rewrite anything below the pressure threshold", () => {
    const onPruned = vi.fn();
    const context = extensionHarness({
      onPruned,
      keepRecent: 0,
      maxKeptChars: 10,
      triggerTokens: 1_000,
      estimateTokens: () => 500,
    });
    const messages = [toolResult("x".repeat(100), 0)];
    expect(context(messages)).toBeUndefined();
    expect(onPruned).not.toHaveBeenCalled();
  });

  it("reports only newly pruned results and keeps rewriting each request", () => {
    const onPruned = vi.fn();
    const context = extensionHarness({ onPruned, keepRecent: 1, maxKeptChars: 10 });
    const messages = [toolResult("x".repeat(100), 0), toolResult("y".repeat(100), 1)];

    const first = context(messages);
    expect(first?.messages).toHaveLength(2);
    expect(first?.messages[0]?.content).not.toEqual(messages[0]?.content);
    expect(onPruned).toHaveBeenCalledOnce();
    expect(onPruned.mock.calls[0]?.[2]).toBe("call-0");

    // SDK 不写回会话历史，后续请求仍要返回改写后的列表，但不能重复计数。
    context(messages);
    context(messages);
    expect(onPruned).toHaveBeenCalledTimes(1);

    // 新增一条工具结果后，最早那条已经是已知项，第二次通知只包含真正新增的 call-1。
    context([...messages, toolResult("z".repeat(100), 2)]);
    expect(onPruned).toHaveBeenCalledTimes(2);
    expect(onPruned.mock.calls[1]?.[0]).toBe(1);
    expect(onPruned.mock.calls[1]?.[2]).toBe("call-1");
  });
});
