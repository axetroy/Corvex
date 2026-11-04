import { describe, expect, it } from "vitest";
import { calculateOutputTokensPerSecond, reconstructLlmInput } from "../../src/app/ui/trace.ts";

describe("operations UI trace reconstruction", () => {
  it("calculates output TPS weighted by model call duration", () => {
    expect(calculateOutputTokensPerSecond([
      { outputTokens: 30, durationMs: 1000 },
      { outputTokens: 20, durationMs: 3000 },
    ])).toBe(12.5);
  });

  it("ignores traces without valid output token counts or durations", () => {
    expect(calculateOutputTokensPerSecond([
      { outputTokens: 10, durationMs: 0 },
      { outputTokens: null, durationMs: 1000 },
    ])).toBeNull();
  });

  it("reconstructs the selected model turn from incremental entries and resets", () => {
    const userMessage = { id: "user-1", type: "message", message: { role: "user", content: "Review this" } };
    const toolMessage = { id: "tool-1", type: "message", message: { role: "toolResult", content: "File contents" } };
    const compactedContext = { id: "compact-1", type: "compaction", summary: "Earlier context" };
    const traces = [
      {
        id: 1,
        kind: "llm",
        input: JSON.stringify({
          contextMode: "delta",
          contextReset: true,
          systemPrompt: "System prompt",
          messages: [userMessage],
        }),
      },
      { id: 2, kind: "tool", input: "{}" },
      {
        id: 3,
        kind: "llm",
        input: JSON.stringify({ contextMode: "delta", contextReset: false, messages: [toolMessage] }),
      },
      {
        id: 4,
        kind: "llm",
        input: JSON.stringify({
          contextMode: "delta",
          contextReset: true,
          systemPrompt: "System prompt",
          messages: [compactedContext],
        }),
      },
    ];

    expect(JSON.parse(reconstructLlmInput(traces, traces[2]))).toEqual({
      systemPrompt: "System prompt",
      messages: [userMessage, toolMessage],
    });
    expect(JSON.parse(reconstructLlmInput(traces, traces[3]))).toEqual({
      systemPrompt: "System prompt",
      messages: [compactedContext],
    });
  });

  it("returns legacy full-context inputs unchanged", () => {
    const input = JSON.stringify({ systemPrompt: "Legacy prompt", messages: [] });
    const entry = { id: 1, input, rawContent: null };

    expect(reconstructLlmInput([entry], entry)).toBe(input);
  });
});