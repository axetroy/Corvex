import type { DiffResult } from "../git/types.js";
import type { Finding, ReviewContext } from "./workflow.js";

export interface ExpectedFinding {
  filePath: string;
  line: number;
  severity: Finding["severity"];
}

export interface ReviewBenchmarkCase {
  name: string;
  context: ReviewContext;
  diff: DiffResult;
  expected: ExpectedFinding[];
}

export interface ReviewBenchmarkScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function benchmarkCase(
  name: string,
  path: string,
  patch: string,
  expected: ExpectedFinding[],
): ReviewBenchmarkCase {
  return {
    name,
    context: {
      projectId: 1,
      mrIid: 1,
      title: name,
      description: "",
      sourceBranch: "benchmark",
      targetBranch: "main",
      baseSha,
      headSha,
    },
    diff: {
      baseSha,
      headSha,
      skippedFiles: 0,
      changes: [
        {
          path,
          status: "M",
          addedLines: patch.split("\n").filter((line) => line.startsWith("+")).length,
          removedLines: 0,
          skipped: "",
          patch,
        },
      ],
    },
    expected,
  };
}

export const reviewBenchmarkCases: ReviewBenchmarkCase[] = [
  benchmarkCase(
    "missing-user-null-dereference",
    "src/users.ts",
    [
      "@@ -0,0 +1,4 @@",
      "+export function getUser(id: number) {",
      "+  const user = users.find((item) => item.id === id);",
      "+  return user.name;",
      "+}",
    ].join("\n"),
    [{ filePath: "src/users.ts", line: 3, severity: "high" }],
  ),
  benchmarkCase(
    "untrusted-query-concatenation",
    "src/query.ts",
    [
      "@@ -0,0 +1,3 @@",
      "+export async function findUser(userId: string) {",
      '+  return db.query("SELECT * FROM users WHERE id = " + userId);',
      "+}",
    ].join("\n"),
    [{ filePath: "src/query.ts", line: 2, severity: "critical" }],
  ),
  benchmarkCase(
    "safe-formatting-change",
    "src/format.ts",
    [
      "@@ -0,0 +1,3 @@",
      "+export function formatName(first: string, last: string) {",
      "+  return `${first} ${last}`.trim();",
      "+}",
    ].join("\n"),
    [],
  ),
];

export function scoreReviewBenchmark(
  expected: ExpectedFinding[],
  actual: Pick<Finding, "filePath" | "line" | "severity">[],
): ReviewBenchmarkScore {
  const expectedKeys = new Set(
    expected.map((finding) => `${finding.filePath}\0${finding.line}\0${finding.severity}`),
  );
  const actualKeys = actual.map(
    (finding) => `${finding.filePath}\0${finding.line}\0${finding.severity}`,
  );
  const matched = new Set(actualKeys.filter((key) => expectedKeys.has(key)));
  const truePositives = Math.min(matched.size, expectedKeys.size);
  const falsePositives = actual.length - truePositives;
  const falseNegatives = expectedKeys.size - truePositives;
  const precision =
    actual.length === 0 ? (expectedKeys.size === 0 ? 1 : 0) : truePositives / actual.length;
  const recall =
    expectedKeys.size === 0 ? 1 : truePositives / expectedKeys.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
  };
}
