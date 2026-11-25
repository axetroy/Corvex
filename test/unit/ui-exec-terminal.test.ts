import { describe, expect, it } from "vitest";
import { createExecDisplay, applyExecDelta, replayExecsFromProcess, commandFromToolInput } from "../../src/app/ui/components/execDisplay.js";

describe("operations UI exec terminal", () => {
  it("creates a running display and appends stdout/stderr chunks by exec id", () => {
    let entry = createExecDisplay("call-1", "npm test", 1_000);
    expect(entry).toMatchObject({ execId: "call-1", command: "npm test", done: false });
    entry = applyExecDelta(entry, { stream: "stdout", chunk: "hello " }, 1_100);
    entry = applyExecDelta(entry, { stream: "stdout", chunk: "world" }, 1_200);
    entry = applyExecDelta(entry, { stream: "stderr", chunk: "warn" }, 1_300);
    expect(entry.stdout).toBe("hello world");
    expect(entry.stderr).toBe("warn");
    expect(entry.done).toBe(false);
  });

  it("restores terminals from persisted process output", () => {
    const displays = replayExecsFromProcess([{
      kind: "tool",
      id: "call-1",
      name: "run_command",
      input: JSON.stringify({ command: "npm test" }),
      status: "succeeded",
      durationMs: 10,
      execOutput: { stdout: "ok\n", stderr: "", exitCode: 0 },
    }]);
    const entry = displays.get("call-1");
    expect(entry).toMatchObject({ command: "npm test", stdout: "ok\n", done: true, exitCode: 0 });
    expect(commandFromToolInput(null)).toBe("");
  });

  it("records the terminal state including a user-stop reason", () => {
    let entry = createExecDisplay("call-2", "node server.js", 1_000);
    entry = applyExecDelta(entry, {
      stream: "stdout",
      chunk: "",
      done: true,
      exitCode: null,
      aborted: true,
      reason: "user manually stopped this command",
      truncated: false,
    }, 2_000);
    expect(entry).toMatchObject({
      done: true,
      aborted: true,
      reason: "user manually stopped this command",
      finishedAt: 2_000,
    });
    expect(entry.stdout).toBe("");
  });
});
