import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMicrocompactExtension, microcompactMessages } from "../../src/agent/microcompact.ts";

function toolResult(text: string, index: number): Record<string, unknown> {
  return { role: "toolResult", toolName: "read_file", content: [{ type: "text", text: `${index}:${text}` }] };
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

describe("microcompact extension", () => {
  it("returns rewritten messages and notifies when results were pruned", () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: (event: string, callback: (event: unknown) => unknown) => {
        handlers.set(event, callback);
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    const onPruned = vi.fn();
    createMicrocompactExtension({ onPruned, keepRecent: 0, maxKeptChars: 10 })(pi);
    const result = handlers.get("context")?.({ messages: [toolResult("x".repeat(100), 0)] }) as
      | { messages: Record<string, unknown>[] }
      | undefined;
    expect(result?.messages).toHaveLength(1);
    expect(onPruned).toHaveBeenCalledOnce();
  });
});
