import { describe, expect, it } from "vitest";
import { buildToolCatalogSection } from "../../src/agent/tool-catalog.ts";

describe("tool catalog section", () => {
  it("lists every active tool with its description", () => {
    const section = buildToolCatalogSection({
      activeNames: ["web_fetch", "git_status", "record_plan"],
      allTools: [
        { name: "web_fetch", description: "Fetch a public webpage" },
        { name: "git_status", description: "Show worktree status" },
        { name: "record_plan", description: "Record a short plan" },
        { name: "disabled_tool", description: "Should not appear" },
      ],
      language: "en",
    });
    expect(section).toContain("- web_fetch: Fetch a public webpage");
    expect(section).toContain("- git_status: Show worktree status");
    expect(section).toContain("- record_plan: Record a short plan");
    expect(section).not.toContain("disabled_tool");
  });

  it("falls back to names only when descriptions would exceed the cap", () => {
    const names = Array.from({ length: 100 }, (_, index) => `tool_${index}`);
    const section = buildToolCatalogSection({
      activeNames: names,
      allTools: names.map((name) => ({ name, description: "A long description ".repeat(20) })),
      language: "en",
    });
    expect(section).toContain("- tool_99");
    expect(section).not.toContain("A long description");
  });

  it("renders the empty case in the configured language", () => {
    expect(buildToolCatalogSection({ activeNames: [], allTools: [], language: "zh-CN" })).toContain("（无）");
    expect(buildToolCatalogSection({ activeNames: [], allTools: [], language: "en" })).toContain("(none)");
  });

  it("mentions web tools in Chinese when they are active", () => {
    const section = buildToolCatalogSection({
      activeNames: ["web_search", "web_fetch"],
      allTools: [
        { name: "web_search", description: "Search the public web" },
        { name: "web_fetch", description: "Read a webpage" },
      ],
      language: "zh-CN",
    });
    expect(section).toContain("web_search");
    expect(section).toContain("web_fetch");
    expect(section).toContain("判断自身能力时以本节为准");
  });
});
