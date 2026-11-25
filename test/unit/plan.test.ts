import { describe, expect, it } from "vitest";
import { normalizePlanSteps } from "../../src/agent/plan.js";
import { parseDisplayPlanSteps, parsePlanSteps } from "../../src/app/ui/lib/planDisplay.js";

describe("plan steps", () => {
  it("normalizes untrusted step lists", () => {
    expect(normalizePlanSteps([" a ", "", "b".repeat(200)])).toEqual(["a", "b".repeat(160)]);
  });

  it("parses status-aware plans from tool input", () => {
    const input = JSON.stringify({
      steps: [
        { text: "read code", status: "completed" },
        { text: "edit file", status: "in_progress" },
        { text: "verify", status: "pending" },
      ],
    });
    expect(parseDisplayPlanSteps(input)).toEqual([
      { text: "read code", status: "completed" },
      { text: "edit file", status: "in_progress" },
      { text: "verify", status: "pending" },
    ]);
  });

  it("stays compatible with legacy string plans", () => {
    const input = JSON.stringify({ steps: ["first", "second"] });
    expect(parsePlanSteps(input)).toEqual(["first", "second"]);
    expect(parseDisplayPlanSteps(input).every((step) => step.status === "pending")).toBe(true);
  });

  it("parses status lines from tool output as fallback", () => {
    const text = "Plan:\n1. [completed] read code\n2. [in_progress] edit file\nnot a step";
    expect(parseDisplayPlanSteps(text)).toEqual([
      { text: "read code", status: "completed" },
      { text: "edit file", status: "in_progress" },
    ]);
  });
});
