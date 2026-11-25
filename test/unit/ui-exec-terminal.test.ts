import { describe, expect, it } from "vitest";
import { createExecDisplay, applyExecDelta } from "../../src/app/ui/components/ConversationExecTerminal.js";

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
