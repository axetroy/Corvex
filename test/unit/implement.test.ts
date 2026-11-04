import { describe, expect, it, vi } from "vitest";
import { getPromptTemplates } from "../../src/agent/prompts.js";
import type { PiAgent } from "../../src/agent/pi.js";
import { ImplementWorkflow, parseImplementationResponse } from "../../src/implement/workflow.js";

describe("Issue implementation responses", () => {
  it("keeps the system prompt stable across per-issue settings", async () => {
    const generate = vi.fn<PiAgent["generate"]>(async () => ({
      content: '{"action":"reply","reply":"Need more detail."}',
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const workflow = new ImplementWorkflow({ generate } as unknown as PiAgent, 1024, 1024);
    const baseContext = {
      projectId: 1,
      issueIid: 2,
      title: "Update settings",
      description: "",
      baseSha: "a".repeat(40),
      comments: [],
    };

    await workflow.implement({ ...baseContext, defaultBranch: "main", implementationEnabled: true }, "Please implement this", process.cwd());
    await workflow.implement({ ...baseContext, defaultBranch: "trunk", implementationEnabled: false }, "Please analyze this", process.cwd());

    const firstCall = generate.mock.calls[0]![0];
    const secondCall = generate.mock.calls[1]![0];
    expect(firstCall.systemPrompt).toBe(getPromptTemplates("en").implementSystem);
    expect(secondCall.systemPrompt).toBe(firstCall.systemPrompt);
    expect(JSON.parse(firstCall.userPrompt)).toMatchObject({
      issue: { defaultBranch: "main" },
      implementation_enabled: true,
    });
    expect(JSON.parse(secondCall.userPrompt)).toMatchObject({
      issue: { defaultBranch: "trunk" },
      implementation_enabled: false,
    });
  });

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