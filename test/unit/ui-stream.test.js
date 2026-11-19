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
