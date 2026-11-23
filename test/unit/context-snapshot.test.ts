import { describe, expect, it, vi } from "vitest";
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
  function fakePi() {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: (event: string, callback: (event: unknown) => unknown) => {
        handlers.set(event, callback);
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    return { pi, handlers };
  }

  const preparation = {
    firstKeptEntryId: "entry-1",
    tokensBefore: 99,
    settings: { reserveTokens: 20 },
    messagesToSummarize: [message("user", "before compaction")],
  };

  it("captures messages scheduled for compaction and notifies the start", async () => {
    const observation: { before?: ReturnType<typeof buildContextSnapshot> } = {};
    const onBeforeCompact = vi.fn();
    const { pi, handlers } = fakePi();
    createContextObserveExtension(observation, { onBeforeCompact })(pi);

    const result = await handlers.get("session_before_compact")?.({ preparation, reason: "threshold" });
    expect(result).toBeUndefined();
    expect(onBeforeCompact).toHaveBeenCalledOnce();
    expect(onBeforeCompact).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: 99 }),
      { reason: "threshold", tokens: 99, reserveTokens: 20 },
    );
    expect(observation.before).toMatchObject({ tokens: 99 });
    expect(observation.before?.messages).toEqual([{ role: "user", text: "before compaction" }]);
  });

  it("uses a deterministic summary after a summarization failure instead of looping", async () => {
    const observation: { before?: ReturnType<typeof buildContextSnapshot>; failures?: number } = {};
    const { pi, handlers } = fakePi();
    createContextObserveExtension(observation)(pi);

    handlers.get("session_compact_failed")?.({ errorMessage: "token cap" });
    const result = await handlers.get("session_before_compact")?.({ preparation, reason: "threshold" }) as
      | { compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number } }
      | undefined;
    expect(result?.compaction).toMatchObject({ firstKeptEntryId: "entry-1", tokensBefore: 99 });
    expect(result?.compaction.summary).toContain("user: before compaction");
  });

  it("resets the failure counter after a successful compaction", async () => {
    const observation: { failures?: number } = {};
    const { pi, handlers } = fakePi();
    createContextObserveExtension(observation)(pi);
    handlers.get("session_compact_failed")?.({});
    handlers.get("session_compact")?.({});
    const result = await handlers.get("session_before_compact")?.({ preparation, reason: "threshold" });
    expect(result).toBeUndefined();
  });
});

describe("context observe with real token counting", () => {
  it("reports the provider token count in the compaction trigger", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: (event: string, callback: (event: unknown) => unknown) => {
        handlers.set(event, callback);
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    const onBeforeCompact = vi.fn();
    const counter = { count: vi.fn(async () => 321) };
    createContextObserveExtension({}, { onBeforeCompact }, counter)(pi);
    await handlers.get("session_before_compact")?.({
      preparation: {
        firstKeptEntryId: "entry-1",
        tokensBefore: 99,
        settings: { reserveTokens: 20 },
        messagesToSummarize: [message("user", "some context")],
      },
      reason: "threshold",
      signal: new AbortController().signal,
    });
    expect(onBeforeCompact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tokens: 321 }),
    );
  });
});

describe("domain compaction summary", () => {
  it("prefers the supplied summarizer over the deterministic fallback", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: (event: string, callback: (event: unknown) => unknown) => {
        handlers.set(event, callback);
        return () => undefined;
      },
    } as unknown as ExtensionAPI;
    const summarize = vi.fn(async () => ({
      summary: "domain summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 99,
      estimatedTokensAfter: 12,
    }));
    createContextObserveExtension({}, {}, undefined, summarize)(pi);
    handlers.get("session_compact_failed")?.({ errorMessage: "first failure" });
    const result = await handlers.get("session_before_compact")?.({
      preparation: {
        firstKeptEntryId: "entry-1",
        tokensBefore: 99,
        settings: { reserveTokens: 20 },
        messagesToSummarize: [message("user", "context")],
      },
      reason: "threshold",
      signal: new AbortController().signal,
    }) as { compaction?: { summary: string } } | undefined;
    expect(summarize).toHaveBeenCalledOnce();
    expect(result?.compaction?.summary).toBe("domain summary");
  });
});
