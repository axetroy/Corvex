import { describe, expect, it } from "vitest";
import {
  defaultSkillSeeds,
  expandSkillTemplate,
  isValidSkillName,
  localizeSkillText,
  validateSkillInput,
} from "../../src/agent/skills.ts";
import type { ConversationSkillInput } from "../../src/model.ts";

const validInput: ConversationSkillInput = {
  name: "my-skill",
  description: "Do a thing",
  descriptionZh: "做件事",
  content: "Do $ARGUMENTS carefully.",
  contentZh: "仔细处理 $ARGUMENTS。",
  argumentHint: "[target]",
  license: "MIT",
  compatibility: "Requires network access",
  metadata: { author: "example" },
  allowedTools: "read_file",
  enabled: true,
};

describe("conversation skill templates", () => {
  it("expands $ARGUMENTS or appends arguments when there is no placeholder", () => {
    expect(expandSkillTemplate("Do $ARGUMENTS carefully.", " auth ")).toBe("Do auth carefully.");
    expect(expandSkillTemplate("Review the changes", "src/auth.ts"))
      .toBe("Review the changes\n\nsrc/auth.ts");
    expect(expandSkillTemplate("Review the changes", "")).toBe("Review the changes");
  });

  it("localizes skill copy with a fallback", () => {
    expect(localizeSkillText("English", "中文", "zh-CN")).toBe("中文");
    expect(localizeSkillText("English", "中文", "en")).toBe("English");
    expect(localizeSkillText("English", "", "zh-CN")).toBe("English");
  });

  it("seeds the seven legacy commands with bilingual content", () => {
    expect(defaultSkillSeeds.map((seed) => seed.name)).toEqual([
      "review", "explain", "fix", "test", "docs", "commit", "create-mr",
    ]);
    for (const seed of defaultSkillSeeds) {
      expect(isValidSkillName(seed.name)).toBe(true);
      expect(seed.content.trim()).not.toBe("");
      expect(seed.contentZh.trim()).not.toBe("");
      expect(validateSkillInput({ ...validInput, ...seed, argumentHint: "", enabled: true })).toEqual([]);
    }
  });

  it("validates command names and rejects empty or oversized templates", () => {
    expect(isValidSkillName("create-mr")).toBe(true);
    expect(isValidSkillName("Docs")).toBe(false);
    expect(isValidSkillName("-docs")).toBe(false);
    expect(isValidSkillName("has space")).toBe(false);
    expect(validateSkillInput({ ...validInput, name: "Bad Name" }).length).toBeGreaterThan(0);
    expect(validateSkillInput({ ...validInput, content: "", contentZh: "" }).length).toBeGreaterThan(0);
    expect(validateSkillInput({ ...validInput, content: "x".repeat(8_001) }).length).toBeGreaterThan(0);
  });
});
