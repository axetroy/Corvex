import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPlanExtension, normalizePlanSteps } from "../../src/agent/plan.ts";

describe("plan steps", () => {
  it("caps count and length and drops empty entries", () => {
    expect(normalizePlanSteps([
      "  read files  ",
      "",
      "x".repeat(500),
      ...Array.from({ length: 12 }, (_, index) => `step ${index}`),
    ])).toEqual([
      "read files",
      "x".repeat(160),
      ...Array.from({ length: 6 }, (_, index) => `step ${index}`),
    ]);
  });
});

describe("plan extension", () => {
  it("registers a record_plan tool", () => {
    const names: string[] = [];
    const pi = {
      registerTool: (tool: { name: string }) => names.push(tool.name),
    } as unknown as ExtensionAPI;
    createPlanExtension()(pi);
    expect(names).toEqual(["record_plan"]);
  });
});
