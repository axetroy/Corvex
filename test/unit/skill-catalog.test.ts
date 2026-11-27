import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSkillCatalogSection, createSkillCatalogExtension, type SkillCatalogEntry } from "../../src/agent/skill-catalog.ts";

const entries: SkillCatalogEntry[] = [
  {
    name: "review",
    description: "Review <changes> & code",
    location: "skill://managed/review/SKILL.md",
    baseDir: "skill://managed/review",
  },
];

describe("managed skill catalog", () => {
  it("advertises only metadata and virtual skill:// URIs", () => {
    const section = buildSkillCatalogSection(entries, "en");
    expect(section).toContain("<available_skills>");
    expect(section).toContain("<name>review</name>");
    expect(section).toContain("&lt;changes&gt; &amp; code");
    expect(section).toContain("skill://managed/review/SKILL.md");
    expect(section).toContain("read_file");
    // 不暴露宿主绝对路径。
    expect(section).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });

  it("writes the section into the system prompt", () => {
    let captured = "";
    // 直接验证扩展写入的 section key，避免依赖 Pi 的事件总线。
    const api = {
      on: (_event: string, handler: (event: { systemPromptOptions: { sections: Record<string, string> } }) => void) => {
        const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
        handler(event);
        captured = event.systemPromptOptions.sections.skills ?? "";
      },
    } as unknown as ExtensionAPI;
    createSkillCatalogExtension(buildSkillCatalogSection(entries, "en"))(api);
    expect(captured).toContain("<available_skills>");
  });

  it("caps single descriptions and falls back to names when the catalog grows too large", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, "0")}`,
      description: "x".repeat(2_000),
      location: `skill://managed/skill-${index}/SKILL.md`,
      baseDir: `skill://managed/skill-${index}`,
    }));
    const section = buildSkillCatalogSection(many, "en");
    expect(section.length).toBeLessThanOrEqual(8_000 + 600);
    expect(section).toContain("Too many skills to list descriptions");
    expect(section).not.toContain("<description>");
    const one = buildSkillCatalogSection([many[0]!], "en");
    expect(one).toContain("<description>");
    expect(one).not.toContain("x".repeat(600));
  });

  it("returns an empty section when there are no model-invocable skills", () => {
    expect(buildSkillCatalogSection([], "zh-CN")).toBe("");
  });
});
