import { describe, expect, it } from "vitest";
import { parseSseFrames } from "../../src/app/ui/stream.ts";

describe("operations UI conversation stream", () => {
  it("parses cumulative text events from partial SSE frames", () => {
    const first = parseSseFrames(
      'data: {"type":"text","reset":true,"text":""}\n\n: ping\n\ndata: {"type":"text","reset":false,"text":"Hel',
    );
    expect(first.events).toEqual([{ type: "text", reset: true, text: "" }]);
    expect(first.rest).toBe('data: {"type":"text","reset":false,"text":"Hel');

    const second = parseSseFrames(`${first.rest}lo"}\n\ndata: {"type":"done","status":"completed"}\n\n`);
    expect(second.events).toEqual([
      { type: "text", reset: false, text: "Hello" },
      { type: "done", status: "completed" },
    ]);
    expect(second.rest).toBe("");
  });

  it("parses cumulative thinking events alongside the answer text", () => {
    const parsed = parseSseFrames(
      'data: {"type":"thinking","reset":true,"text":""}\n\n' +
      'data: {"type":"thinking","reset":false,"text":"先读代码"}\n\n' +
      'data: {"type":"text","reset":true,"text":""}\n\n' +
      'data: {"type":"text","reset":false,"text":"答案"}\n\n',
    );
    expect(parsed.events).toEqual([
      { type: "thinking", reset: true, text: "" },
      { type: "thinking", reset: false, text: "先读代码" },
      { type: "text", reset: true, text: "" },
      { type: "text", reset: false, text: "答案" },
    ]);
  });

  it("parses tool start and end events with their call id", () => {
    const parsed = parseSseFrames(
      'data: {"type":"tool","tool":{"id":"call-1","name":"read_file","input":"{\\"path\\":\\"a.ts\\"}","status":"running","durationMs":null}}\n\n' +
      'data: {"type":"tool","tool":{"id":"call-1","name":"read_file","input":"{\\"path\\":\\"a.ts\\"}","status":"succeeded","durationMs":12}}\n\n',
    );
    expect(parsed.events).toEqual([
      {
        type: "tool",
        tool: { id: "call-1", name: "read_file", input: '{"path":"a.ts"}', status: "running", durationMs: null },
      },
      {
        type: "tool",
        tool: { id: "call-1", name: "read_file", input: '{"path":"a.ts"}', status: "succeeded", durationMs: 12 },
      },
    ]);
  });

  it("accepts CRLF framing and keeps the done error message", () => {
    const parsed = parseSseFrames('data: {"type":"done","status":"failed","error":"boom"}\r\n\r\n');
    expect(parsed.events).toEqual([{ type: "done", status: "failed", error: "boom" }]);
  });

  it("skips malformed frames and unknown statuses instead of breaking the stream", () => {
    const parsed = parseSseFrames(
      "data: not-json\n\n" +
      'data: {"type":"text","text":"missing reset"}\n\n' +
      'data: {"type":"done","status":"unknown"}\n\n' +
      'data: {"type":"text","reset":false,"text":"ok"}\n\n',
    );
    expect(parsed.events).toEqual([{ type: "text", reset: false, text: "ok" }]);
    expect(parsed.rest).toBe("");
  });
});
