import { describe, expect, it } from "vitest";
import { parseImplementationResponse } from "../../src/implement/workflow.js";

describe("Issue implementation responses", () => {
  it("accepts a bounded implementation response", () => {
    expect(parseImplementationResponse(JSON.stringify({
      action: "implement",
      summary: "Add the requested setting.",
      patch: "diff --git a/config.ts b/config.ts\n",
    }), 100)).toEqual({
      action: "implement",
      summary: "Add the requested setting.",
      patch: "diff --git a/config.ts b/config.ts\n",
    });
  });

  it("accepts reply-only decisions and validates implementation fields", () => {
    expect(parseImplementationResponse('{"action":"reply","reply":"This is feasible."}', 100)).toEqual({
      action: "reply",
      reply: "This is feasible.",
    });
    expect(() => parseImplementationResponse('{"action":"reply","reply":"ok","patch":"x"}', 100)).toThrow("invalid Issue reply");
    expect(() => parseImplementationResponse('{"action":"implement","summary":"ok","patch":"","other":true}', 100)).toThrow("invalid Issue decision JSON");
    expect(() => parseImplementationResponse('{"action":"implement","summary":" ","patch":"x"}', 100)).toThrow("invalid Issue implementation");
    expect(() => parseImplementationResponse('{"action":"implement","summary":"ok","patch":"12345"}', 4)).toThrow("size limit");
  });

  it("accepts only target branches explicitly named in the current request", () => {
    expect(parseImplementationResponse(
      '{"action":"implement","summary":"Update release","patch":"diff","target_branch":"release/2.0"}',
      100,
      "Please target branch release/2.0",
    )).toMatchObject({ targetBranch: "release/2.0" });
    expect(() => parseImplementationResponse(
      '{"action":"implement","summary":"Update main","patch":"diff","target_branch":"main"}',
      100,
      "Please remain on the default branch",
    )).toThrow("not explicitly named");
  });
});