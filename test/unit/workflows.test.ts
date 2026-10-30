import { describe, expect, it, vi } from "vitest";
import type { PiAgent } from "../../src/agent/pi.js";
import { parseFixResponse } from "../../src/fix/workflow.js";
import type { DiffResult } from "../../src/git/types.js";
import { parseAndValidateReview, ReviewWorkflow } from "../../src/review/workflow.js";

const diff: DiffResult = {
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  skippedFiles: 0,
  changes: [
    {
      path: "src/app.ts",
      status: "M",
      addedLines: 1,
      removedLines: 0,
      skipped: "",
      patch: "@@ -2,0 +3 @@\n+const value = user.input;\n",
    },
  ],
};

describe("review and fix response validation", () => {
  it("accepts only review evidence present on the exact added line", () => {
    const raw = JSON.stringify({
      summary: "One concrete defect.",
      findings: [
        {
          severity: "high",
          title: "Unchecked input",
          file_path: "src/app.ts",
          line: 3,
          evidence: "user.input",
          explanation: "The value is used without validation.",
        },
        {
          severity: "critical",
          title: "Unsupported evidence",
          file_path: "src/app.ts",
          line: 3,
          evidence: "not present",
          explanation: "This is not supported by the added line.",
        },
      ],
    });
    const result = parseAndValidateReview(raw, diff, 10);
    expect(result.result.findings).toHaveLength(1);
    expect(result.result.findings[0]?.line).toBe(3);
    expect(result.rejected).toBe(1);
  });

  it("accepts review JSON wrapped in a Markdown code fence", () => {
    const raw = JSON.stringify({ summary: "Review complete", findings: [] });
    const result = parseAndValidateReview(`\`\`\`json\n${raw}\n\`\`\``, diff, 10);
    expect(result.result.summary).toBe("Review complete");
    expect(result.result.findings).toEqual([]);
  });

  it("recovers a single trailing quote after a complete review JSON object", () => {
    const raw = `${JSON.stringify({ summary: "Review complete", findings: [] })}"`;
    const result = parseAndValidateReview(raw, diff, 10);
    expect(result.result.summary).toBe("Review complete");
    expect(result.result.findings).toEqual([]);
  });

  it("retries once with format-only guidance after malformed review JSON", async () => {
    const validResponse = JSON.stringify({ summary: "Review complete", findings: [] });
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: `${validResponse}\nThe response is complete.`,
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .mockResolvedValueOnce({
        content: validResponse,
        model: "test/model",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      });
    const workflow = new ReviewWorkflow({ generate } as unknown as PiAgent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, diff, process.cwd());

    expect(outcome.result.summary).toBe("Review complete");
    expect(outcome.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("previous response was not valid JSON");
  });

  it("retries once when a valid JSON response does not match the review schema", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({ reviews: [{ path: "src/app.ts", line: 3, severity: "warning", comment: "Review" }] }),
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ summary: "Review complete", findings: [] }),
        model: "test/model",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      });
    const workflow = new ReviewWorkflow({ generate } as unknown as PiAgent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, diff, process.cwd());

    expect(outcome.result.summary).toBe("Review complete");
    expect(outcome.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("did not match the required review schema");
  });

  it("reports which top-level review field has an invalid shape", () => {
    expect(() =>
      parseAndValidateReview(JSON.stringify({ summary: "Review complete", findings: "none" }), diff, 10),
    ).toThrow("findings must be an array");
  });

  it("asks the agent to read changed files while preserving diff evidence", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({ summary: "Review complete", findings: [] }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const workflow = new ReviewWorkflow({ generate } as unknown as PiAgent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    await workflow.review(context, diff, process.cwd());

    const request = generate.mock.calls[0]?.[0];
    expect(request?.systemPrompt).toContain("complete contents of every changed file");
    expect(request?.systemPrompt).toContain("read_file tool");
    expect(request?.userPrompt).toContain('"path":"src/app.ts"');
    expect(request?.userPrompt).toContain("const value = user.input;");
  });

  it("logs the raw model response when review JSON is rejected", async () => {
    const raw = '["not", "an object"]';
    const agent = {
      generate: async () => ({
        content: raw,
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(workflow.review(context, diff, process.cwd())).rejects.toThrow(
        "top-level value must be an object",
      );
      expect(warning).toHaveBeenCalledWith(
        "model review response rejected",
        expect.objectContaining({ responseContent: raw }),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("validates fix JSON and enforces the patch byte limit", () => {
    expect(parseFixResponse('{"summary":"Safe change","patch":""}', 10)).toEqual({
      summary: "Safe change",
      patch: "",
    });
    expect(() => parseFixResponse('{"summary":"ok","patch":"12345"}', 4)).toThrow(
      "exceeds its configured size limit",
    );
    expect(() => parseFixResponse('{"summary":"ok","patch":"","extra":true}', 10)).toThrow(
      "invalid fix JSON",
    );
  });
});
