import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../../src/app/ui/i18n.ts";
import { TraceField } from "../../src/app/ui/components/common.tsx";
import { ConversationToolCalls } from "../../src/app/ui/components/ConversationToolCalls.tsx";
import { TraceSession } from "../../src/app/ui/components/TraceSession.tsx";
import {
  anchoredScrollLeft,
  buildTimelineLayout,
  calculateAverageFirstTokenMs,
  calculateGenerationTokensPerSecond,
  clampZoom,
  reconstructLlmInput,
  timelineTickCount,
  traceTurnId,
  wheelZoomFactor,
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

  it("renders tool calls in the chat transcript with readable descriptions", () => {
    const markup = renderToStaticMarkup(createElement(ConversationToolCalls, {
      copy: en,
      calls: [
        { name: "read_file", status: "succeeded", input: JSON.stringify({ path: "src/app/ui/App.tsx" }), durationMs: 42 },
        { name: "git_grep", status: "failed", input: JSON.stringify({ query: "createHash", path: "src" }), durationMs: 7 },
        { name: "web_fetch", status: "running", input: null, durationMs: null },
      ],
    }));

    expect(markup).toContain("3 tool calls");
    expect(markup).toContain("Read file src/app/ui/App.tsx (lines 1-200)");
    expect(markup).toContain("Search &quot;createHash&quot; in src");
    expect(markup).toContain("Read webpage unknown path");
    expect(markup).toContain("Succeeded");
    expect(markup).toContain("Failed");
    expect(markup).toContain("Running");
    expect(markup).toContain("42 ms");
    expect(markup).toContain("7 ms");
  });

  it("uses the singular summary for a single tool call", () => {
    const markup = renderToStaticMarkup(createElement(ConversationToolCalls, {
      copy: en,
      calls: [{ name: "read_file", status: "succeeded", input: JSON.stringify({ path: "src/app/ui/App.tsx" }), durationMs: 42 }],
    }));
    expect(markup).toContain("1 tool call<");
    expect(markup).not.toContain("1 tool calls");
  });

  it("renders nothing when a turn recorded no tool calls", () => {
    const markup = renderToStaticMarkup(createElement(ConversationToolCalls, { copy: en, calls: [] }));
    expect(markup).toBe("");
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

  it("renders request start and response header timing for model turns", () => {
    const markup = renderToStaticMarkup(createElement(TraceSession, {
      traces: [{
        id: 1,
        attempt: 1,
        round: 1,
        kind: "llm",
        name: "chat",
        status: "succeeded",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:02.000Z",
        durationMs: 2000,
        requestStartedAt: "2026-01-01T00:00:00.010Z",
        responseHeadersMs: 40,
        firstTokenMs: 75,
        generationDurationMs: 1925,
        model: "test-model",
        inputTokens: 10,
        outputTokens: 20,
        input: null,
        output: JSON.stringify({ content: [{ type: "text", text: "Timed response." }] }),
        schema: null,
        rawContent: null,
        errorDetail: null,
      }],
      userRequest: "",
      copy: en,
      locale: "en",
    }));

    expect(markup).toContain("Request started:");
    expect(markup).toContain("Response headers: 40 ms");
    expect(markup).toContain("TTFT: 75 ms");
    expect(markup).toContain("Timed response.");
  });

  it("hides a failed model turn when a later turn in the same attempt succeeds", () => {
    const failedTrace = {
      id: 1,
      attempt: 1,
      round: 101,
      kind: "llm",
      name: "chat",
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      firstTokenMs: null,
      generationDurationMs: null,
      model: "test-model",
      inputTokens: null,
      outputTokens: null,
      input: null,
      output: JSON.stringify({ content: [], stopReason: "error" }),
      schema: null,
      rawContent: null,
      errorDetail: "Connection error.",
    };
    const recoveredTrace = {
      ...failedTrace,
      id: 2,
      round: 102,
      status: "succeeded",
      startedAt: "2026-01-01T00:00:02.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z",
      output: JSON.stringify({ content: [{ type: "text", text: "Recovered response." }] }),
      errorDetail: null,
    };
    const markup = renderToStaticMarkup(createElement(TraceSession, {
      traces: [failedTrace, recoveredTrace],
      userRequest: "Please inspect this",
      copy: en,
      locale: "en",
    }));

    expect(markup).toContain("Recovered response.");
    expect(markup).not.toContain("Connection error.");
    expect(markup).toContain("Errors: 1");

    const unrecoveredMarkup = renderToStaticMarkup(createElement(TraceSession, {
      traces: [failedTrace],
      userRequest: "",
      copy: en,
      locale: "en",
    }));
    expect(unrecoveredMarkup).toContain("Connection error.");
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

  it("clamps the timeline zoom to the supported range", () => {
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1000)).toBe(32);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("maps wheel deltas to zoom factors and leaves Shift+scroll for panning", () => {
    expect(wheelZoomFactor(0, false, false)).toBe(1);
    expect(wheelZoomFactor(Number.NaN, false, false)).toBe(1);
    expect(wheelZoomFactor(-100, false, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, false, false)).toBeLessThan(1);
    // 未按 Ctrl 的 Shift 滚轮用于平移，不缩放；Ctrl 捏合（触控板）仍缩放。
    expect(wheelZoomFactor(-100, true, false)).toBe(1);
    expect(wheelZoomFactor(-100, true, true)).toBeGreaterThan(1);
  });

  it("keeps the time under the cursor anchored while zooming", () => {
    // 视口 400px、滚动 0、光标在正中：放大两倍后锚点仍在正中。
    expect(anchoredScrollLeft(0, 400, 200, 2)).toBe(200);
    // 光标在最左侧时滚动位置保持不变。
    expect(anchoredScrollLeft(0, 400, 0, 2)).toBe(0);
    // 缩小不会产生负的滚动位置。
    expect(anchoredScrollLeft(50, 400, 100, 0.5)).toBe(0);
    // 视口无效时保持原值。
    expect(anchoredScrollLeft(120, 0, 10, 2)).toBe(120);
  });

  it("grows the timeline tick count with zoom within bounds", () => {
    expect(timelineTickCount(0.5)).toBe(5);
    expect(timelineTickCount(1)).toBe(9);
    expect(timelineTickCount(4)).toBe(33);
    expect(timelineTickCount(32)).toBe(33);
    expect(timelineTickCount(Number.NaN)).toBe(9);
  });

  it("segments a merged conversation trace by turn and compresses idle gaps", () => {
    const entry = (id, turnId, startedAt, finishedAt) => ({
      id,
      turnId,
      startedAt,
      finishedAt,
    });
    const layout = buildTimelineLayout([
      entry(1, "turn-a", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:10.000Z"),
      entry(2, "turn-a", "2026-01-01T00:00:05.000Z", "2026-01-01T00:00:06.000Z"),
      // 两轮之间隔了一小时：只保留被压缩后的有限空档，不会撑爆时间轴。
      entry(3, "turn-b", "2026-01-01T01:00:00.000Z", "2026-01-01T01:00:01.000Z"),
    ], (value) => value.turnId, { minWidth: 100, maxWidth: 400, perEntry: 100, segmentGap: 24 });

    expect(layout.segments.map((segment) => segment.key)).toEqual(["turn-a", "turn-b"]);
    // 每段独立测量时间跨度：第一段 10s，第二段 1s。
    expect(layout.segments[0].duration).toBe(10_000);
    expect(layout.segments[1].duration).toBe(1_000);
    // 段内位置按该段自己的时间比例换算。
    expect(layout.segments[0].positions[1].startRatio).toBeCloseTo(0.5);
    // 第二段起点 = 第一段宽度 + 固定像素间隔；一小时的间隔不会撑出巨量空白。
    expect(layout.segments[1].offset).toBe(200 + 24);
    expect(layout.width).toBe(200 + 24 + 100);
  });

  it("keeps a single ungrouped timeline as one segment", () => {
    const layout = buildTimelineLayout([
      { id: 1, startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:01.000Z" },
      { id: 2, startedAt: "2026-01-01T00:00:02.000Z", finishedAt: "2026-01-01T00:00:03.000Z" },
    ], traceTurnId, { minWidth: 320, maxWidth: 1400, perEntry: 22 });

    expect(layout.segments).toHaveLength(1);
    expect(layout.segments[0].key).toBe("");
    expect(layout.segments[0].offset).toBe(0);
    expect(layout.segments[0].duration).toBe(3_000);
    expect(layout.width).toBe(320);
  });

  it("renders every turn of a merged conversation in one session view", () => {
    const trace = (id, turnId, startedAt, output) => ({
      id,
      turnId,
      attempt: 1,
      round: 1,
      kind: "llm",
      name: "conversation",
      status: "succeeded",
      startedAt,
      finishedAt: startedAt,
      durationMs: 10,
      firstTokenMs: null,
      generationDurationMs: null,
      model: "test-model",
      inputTokens: null,
      outputTokens: null,
      input: null,
      output: JSON.stringify({ content: [{ type: "text", text: output }] }),
      schema: null,
      rawContent: null,
      errorDetail: null,
    });
    const markup = renderToStaticMarkup(createElement(TraceSession, {
      traces: [
        trace(1, "turn-a", "2026-01-01T00:00:00.000Z", "First answer."),
        trace(2, "turn-b", "2026-01-01T01:00:00.000Z", "Second answer."),
      ],
      turns: [
        { turnId: "turn-a", status: "completed", request: "First question", headSha: "a".repeat(40), attemptCount: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:10.000Z", lastError: "" },
        { turnId: "turn-b", status: "completed", request: "Second question", headSha: "a".repeat(40), attemptCount: 1, createdAt: "2026-01-01T01:00:00.000Z", updatedAt: "2026-01-01T01:00:01.000Z", lastError: "" },
      ],
      copy: en,
      locale: "en",
    }));

    expect(markup).toContain("Turn 1");
    expect(markup).toContain("Turn 2");
    expect(markup).toContain("First question");
    expect(markup).toContain("Second question");
    expect(markup).toContain("First answer.");
    expect(markup).toContain("Second answer.");
  });
});