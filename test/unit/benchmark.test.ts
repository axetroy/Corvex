import { describe, expect, it } from "vitest";
import { scoreReviewBenchmark } from "../../src/review/benchmark.js";

describe("review benchmark scoring", () => {
  it("calculates precision, recall, and F1 from labeled findings", () => {
    expect(
      scoreReviewBenchmark(
        [
          { filePath: "src/users.ts", line: 12, severity: "high" },
          { filePath: "src/query.ts", line: 4, severity: "critical" },
        ],
        [
          { filePath: "src/users.ts", line: 12, severity: "high" },
          { filePath: "src/other.ts", line: 8, severity: "low" },
        ],
      ),
    ).toEqual({ truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5, f1: 0.5 });
  });
});
