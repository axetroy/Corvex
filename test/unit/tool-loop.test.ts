import { describe, expect, it } from "vitest";
import {
  createToolLoopState,
  recordToolCall,
  toolSignature,
} from "../../src/agent/tool-loop.js";

describe("tool loop detection", () => {
  it("builds stable argument signatures regardless of key order", () => {
    expect(toolSignature("read_file", { path: "a", startLine: 1 }))
      .toBe(toolSignature("read_file", { startLine: 1, path: "a" }));
    expect(toolSignature("read_file", { path: "a" })).not.toBe(toolSignature("read_file", { path: "b" }));
  });

  it("detects consecutive identical calls and notifies once", () => {
    const state = createToolLoopState();
    const notices = [];
    for (let i = 0; i < 10; i += 1) {
      const notice = recordToolCall(state, "read_file", { path: "a" }, false);
      if (notice) notices.push(notice);
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ reason: "consecutive", count: 4 });
  });

  it("resets consecutive count when a different call intervenes", () => {
    const state = createToolLoopState();
    for (let i = 0; i < 3; i += 1) recordToolCall(state, "read_file", { path: "a" }, false);
    recordToolCall(state, "read_file", { path: "b" }, false);
    expect(recordToolCall(state, "read_file", { path: "a" }, false)).toBeUndefined();
  });

  it("detects repeated calls even when interleaved", () => {
    const state = createToolLoopState();
    const notices = [];
    for (let i = 0; i < 8; i += 1) {
      recordToolCall(state, "search_text", { query: "x" }, false);
      const notice = recordToolCall(state, "read_file", { path: "y" }, false);
      if (notice) notices.push(notice);
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ reason: "repeated", count: 8 });
  });

  it("detects consecutive failures by tool name", () => {
    const state = createToolLoopState();
    const notices = [];
    for (let i = 0; i < 3; i += 1) {
      const notice = recordToolCall(state, "git_push", { sha: `sha-${i}` }, true);
      if (notice) notices.push(notice);
    }
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ reason: "failures", count: 3 });
  });
});
