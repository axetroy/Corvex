import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../../src/app/ui/i18n.ts";
import { TraceField } from "../../src/app/ui/components/common.tsx";
import { TraceSession } from "../../src/app/ui/components/TraceSession.tsx";
import {
  calculateAverageFirstTokenMs,
  calculateGenerationTokensPerSecond,
  reconstructLlmInput,
} from "../../src/app/ui/trace.ts";

describe("operations UI trace reconstruction", () => {
  it("renders a conversation with compact tool call tips and no activity filters", () => {
    const toolTrace = {
      id: 2,
      attempt: 1,
      round: 1,
      kind: "tool",
      name: "read_file",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.030Z",
      durationMs: 30,
      model: null,
      input: JSON.stringify({ path: "README.md" }),
      output: JSON.stringify({ content: [{ type: "text", text: "Contents" }] }),
      rawContent: null,
      errorDetail: null,
      schema: null,
      inputTokens: null,
      outputTokens: null,
      firstTokenMs: null,
      generationDurationMs: null,
    };
    const assistantTrace = {
      ...toolTrace,
      id: 1,
      kind: "llm",
      name: "implement",
      model: "test-model",
      input: JSON.stringify({
        contextMode: "delta",
        systemPrompt: "System instructions for the assistant",
        messages: [{
          id: "user-1",
          type: "message",
          message: { role: "user", content: "#attachment:Pasted text #1 {\"merge_request\":{\"title\":\"private detail\"}}" },
        }],
      }),
      output: JSON.stringify({ content: [
        { type: "toolCall", name: "read_file", arguments: { path: "README.md" } },
      ] }),
      rawContent: JSON.stringify({ systemPrompt: "System instructions for the assistant" }),
    };
    const finalAssistantTrace = {
      ...assistantTrace,
      id: 3,
      round: 2,
      startedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: "2026-01-01T00:01:00.030Z",
      output: JSON.stringify({ content: [{ type: "text", text: "I found one issue." }] }),
      rawContent: null,
    };
    const markup = renderToStaticMarkup(createElement(TraceSession, {
      traces: [assistantTrace, toolTrace, finalAssistantTrace],
      userRequest: "Please inspect this",
      copy: en,
      locale: "en",
    }));

    expect(markup).toContain("Please inspect this");
    expect(markup).toContain("System Prompt");
    expect(markup).toContain("System instructions for the assistant");
    expect(markup.match(/class="trace-session-system-prompt"/g)).toHaveLength(1);
    expect(markup).not.toContain("#attachment:Pasted text #1");
    expect(markup).not.toContain("private detail");
    expect(markup).toContain("Requested 1 tool call(s)");
    expect(markup).toContain("I found one issue.");
    expect(markup).toContain("Read file README.md (lines 1-200)");
    expect(markup).toContain('<details class="trace-session-tool-details" aria-label="View call details">');
    expect(markup.match(/Read file README\.md \(lines 1-200\)/g)).toHaveLength(1);
    expect(markup).not.toContain("All activity");
    expect(markup).not.toContain("Conversation</button>");
  });

  it("opens trace payload fields when selected by the inspector", () => {
    const markup = renderToStaticMarkup(createElement(TraceField, {
      label: "Input",
      value: "request payload",
      emptyLabel: "None",
      defaultOpen: true,
    }));

    expect(markup).toContain('<details class="trace-payload" open="">');
  });

  it("renders an Issue reply envelope as the assistant's readable reply", () => {
    const reply = "你好！请确认“客户端直接打开浏览器”的具体场景。";
    const markup = renderToStaticMarkup(createElement(TraceSession, {
      traces: [{
        id: 1,
        attempt: 1,
        round: 1,
        kind: "llm",
        name: "implement",
        status: "succeeded",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        firstTokenMs: null,
        generationDurationMs: null,
        model: "test-model",
        inputTokens: 10,
        outputTokens: 20,
        input: null,
        output: JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ action: "reply", reply }) }],
        }),
        schema: null,
        rawContent: null,
        errorDetail: null,
      }],
      userRequest: "",
      copy: en,
      locale: "en",
    }));

    expect(markup).toContain(reply);
    expect(markup).not.toContain("action");
  });

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