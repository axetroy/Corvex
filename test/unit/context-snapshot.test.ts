import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildContextSnapshot, createContextObserveExtension } from "../../src/agent/context-snapshot.ts";

function message(role: string, content: unknown): unknown {
  return { role, content };
}

describe("context snapshot", () => {
  it("extracts user text, assistant text and thinking, and drops image/tool-call parts", () => {
    const snapshot = buildContextSnapshot([
      message("user", "what is this repo?"),
      message("assistant", [
        { type: "thinking", thinking: "let me check", redacted: false },
        { type: "thinking", thinking: "[hidden]", redacted: true },
        { type: "text", text: "here" },
        { type: "toolCall", name: "read_file", arguments: {} },
      ]),
      message("toolResult", [{ type: "text", text: "file content" }]),
      message("custom", "ignored role"),
    ], 1234);

    expect(snapshot.tokens).toBe(1234);
    expect(snapshot.messages).toEqual([
      { role: "user", text: "what is this repo?" },
      { role: "assistant", text: "let me check\nhere" },
      { role: "toolResult", text: "file content" },
    ]);
    expect(snapshot.truncated).toBe(false);
  });

  it("caps the number of messages and total characters with a marker", () => {
    const snapshot = buildContextSnapshot(
      Array.from({ length: 5 }, (_, index) => message("user", "x".repeat(20) + index)),
      42,
      { maxMessages: 2, maxChars: 30 },
    );
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.messages.some((entry) => entry.text.includes("…"))).toBe(true);
  });
});

describe("context observe extension", () => {
  it("captures messages scheduled for compaction without changing the result", () => {
    const observation: { before?: ReturnType<typeof buildContextSnapshot> } = {};
    let handler: ((event: unknown) => void) | undefined;
    const pi = {
      on: (event: string, callback: (event: unknown) => void) => {
        if (event === "session_before_compact") handler = callback;
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    createContextObserveExtension(observation)(pi);

    handler?.({
      preparation: { messagesToSummarize: [message("user", "before compaction")], tokensBefore: 99 },
    });
    expect(observation.before).toMatchObject({ tokens: 99 });
    expect(observation.before?.messages).toEqual([{ role: "user", text: "before compaction" }]);
  });
});
