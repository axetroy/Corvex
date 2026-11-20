import { describe, expect, it } from "vitest";
import { parsePlanSteps } from "../../src/app/ui/planDisplay.ts";

describe("operations UI plan display", () => {
  it("extracts recorded steps from the tool input", () => {
    expect(parsePlanSteps('{"steps":["read files","write patch"]}')).toEqual(["read files", "write patch"]);
  });

  it("ignores malformed or empty inputs", () => {
    expect(parsePlanSteps(null)).toEqual([]);
    expect(parsePlanSteps("not json")).toEqual([]);
    expect(parsePlanSteps('{"steps":[1," valid ", ""]}')).toEqual(["valid"]);
  });
});
