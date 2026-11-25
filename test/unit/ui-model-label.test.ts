import { describe, expect, it } from "vitest";
import { displayModelName } from "../../src/app/ui/lib/modelLabel";

describe("operations UI model label", () => {
  it("keeps the provider and model written by the server", () => {
    expect(displayModelName("OpenAI/gpt-4.1")).toBe("OpenAI/gpt-4.1");
  });

  it("drops the legacy internal provider prefix", () => {
    expect(displayModelName("corvex-openai-compatible/gpt-4.1")).toBe("gpt-4.1");
  });

  it("trims whitespace and passes through empty values", () => {
    expect(displayModelName("  OpenAI/gpt-4.1  ")).toBe("OpenAI/gpt-4.1");
    expect(displayModelName("   ")).toBe("");
  });
});
