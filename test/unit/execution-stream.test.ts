import { describe, expect, it } from "vitest";
import { LocalExecutionBackend } from "../../src/agent/execution/local.js";
import { USER_STOPPED_REASON } from "../../src/agent/execution/types.js";
import { parseSseFrames } from "../../src/app/ui/stream.js";

describe("execution stream", () => {
  it("emits redacted chunks incrementally and a terminal event", async () => {
    const backend = new LocalExecutionBackend();
    const chunks: Array<{ stream: string; text: string }> = [];
    const result = await backend.run(
      { command: "printf 'hello\\n'", cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 1_024 },
      undefined,
      (stream, text) => chunks.push({ stream, text }),
    );
    expect(result.exitCode).toBe(0);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.text).join("")).toContain("hello");
  });

  it("stops a command without aborting the whole turn and records the reason", async () => {
    const backend = new LocalExecutionBackend();
    const controller = new AbortController();
    const pending = backend.run(
      { command: "node -e 'setTimeout(() => {}, 5000)'", cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 1_024 },
      controller.signal,
    );
    controller.abort(USER_STOPPED_REASON);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe(USER_STOPPED_REASON);
  });

  it("parser accepts exec events from SSE frames", () => {
    const frame = `data: ${JSON.stringify({ type: "exec", execId: "call-1", stream: "stdout", chunk: "hi" })}\n\n` +
      `data: ${JSON.stringify({ type: "exec", execId: "call-1", stream: "stdout", chunk: "", done: true, exitCode: 0 })}\n\n`;
    const { events } = parseSseFrames(frame);
    expect(events).toEqual([
      { type: "exec", execId: "call-1", stream: "stdout", chunk: "hi" },
      { type: "exec", execId: "call-1", stream: "stdout", chunk: "", done: true, exitCode: 0 },
    ]);
  });
});
