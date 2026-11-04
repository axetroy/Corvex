import { describe, expect, it } from "vitest";
import {
  calculateAverageFirstTokenMs,
  calculateGenerationTokensPerSecond,
  reconstructLlmInput,
} from "../../src/app/ui/trace.ts";

describe("operations UI trace reconstruction", () => {
  it("calculates generation TPS weighted by generation duration", () => {
    expect(calculateGenerationTokensPerSecond([
      { status: "succeeded", outputTokens: 30, firstTokenMs: 400, generationDurationMs: 1000 },
      { status: "succeeded", outputTokens: 20, firstTokenMs: 800, generationDurationMs: 3000 },
    ])).toBe(12.5);
  });

  it("ignores failures and traces without valid token counts or generation durations", () => {
    expect(calculateGenerationTokensPerSecond([
      { status: "succeeded", outputTokens: 10, firstTokenMs: 10, generationDurationMs: 0 },
      { status: "succeeded", outputTokens: null, firstTokenMs: 10, generationDurationMs: 1000 },
      { status: "failed", outputTokens: 100, firstTokenMs: 10, generationDurationMs: 100 },
    ])).toBeNull();
  });

  it("calculates average time to first token from successful samples only", () => {
    expect(calculateAverageFirstTokenMs([
      { status: "succeeded", outputTokens: 30, firstTokenMs: 200, generationDurationMs: 500 },
      { status: "succeeded", outputTokens: 20, firstTokenMs: 600, generationDurationMs: 500 },
      { status: "failed", outputTokens: 10, firstTokenMs: 5000, generationDurationMs: 100 },
    ])).toBe(400);
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