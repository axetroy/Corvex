import { describe, expect, it } from "vitest";
import { parseFixResponse } from "../../src/fix/workflow.js";
import type { DiffResult } from "../../src/git/types.js";
import { parseAndValidateReview } from "../../src/review/workflow.js";

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

  it("reports which top-level review field has an invalid shape", () => {
    expect(() =>
      parseAndValidateReview(JSON.stringify({ summary: "Review complete", findings: "none" }), diff, 10),
    ).toThrow("findings must be an array");
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
