import { describe, expect, it } from "vitest";
import {
  defaultSkillDocuments,
  expandSkillTemplate,
  isValidSkillName,
  parseSkillDocument,
  validateSkillDocument,
} from "../../src/agent/skills.ts";

const sample = `---
name: my-skill
description: Do a thing when asked.
metadata:
  corvex-quick-action: "true"
  corvex-quick-label: "Do it"
---

Do $ARGUMENTS carefully.
`;

describe("SKILL.md skills", () => {
  it("parses frontmatter, body and Corvex metadata", () => {
    const parsed = parseSkillDocument(sample);
    expect(parsed).toMatchObject({
      name: "my-skill",
      description: "Do a thing when asked.",
      content: "Do $ARGUMENTS carefully.",
      quickAction: true,
      quickLabel: "Do it",
      enabled: true,
    });
  });

  it("rejects invalid SKILL.md documents", () => {
    expect(() => parseSkillDocument("no frontmatter")).toThrow();
    expect(() => parseSkillDocument("---\nname: [broken\n---\nbody")).toThrow();
    const parsed = parseSkillDocument("---\nname: Bad Name\ndescription: x\n---\nbody");
    expect(validateSkillDocument(parsed).length).toBeGreaterThan(0);
    const missing = parseSkillDocument("---\nname: ok\n---\nbody");
    expect(validateSkillDocument(missing)).toContain("description must not be empty");
  });

  it("seeds the seven legacy commands as valid documents", () => {
    expect(defaultSkillDocuments).toHaveLength(7);
    const names = defaultSkillDocuments.map((document) => parseSkillDocument(document).name);
    expect(names).toEqual(["review", "explain", "fix", "test", "docs", "commit", "create-mr"]);
    for (const document of defaultSkillDocuments) {
      const parsed = parseSkillDocument(document);
      expect(validateSkillDocument(parsed)).toEqual([]);
      expect(parsed.quickAction).toBe(true);
    }
  });

  it("follows the mainstream bundled-skill structure", () => {
    for (const document of defaultSkillDocuments) {
      const parsed = parseSkillDocument(document);
      // description 说明做什么 + 何时用，便于自动触发与菜单展示。
      expect(parsed.description).toMatch(/Use when/i);
      expect(parsed.quickLabel.length).toBeGreaterThan(0);
      // 正文是可执行的工作流，而不是一句笼统指令。
      expect(parsed.content).toMatch(/^# /);
      expect(parsed.content).toMatch(/## When to use this skill/);
      expect(parsed.content).toMatch(/## Workflow/);
      expect(parsed.content).toMatch(/## Constraints/);
      expect(parsed.content).toContain("$ARGUMENTS");
      expect(parsed.content.length).toBeGreaterThan(500);
    }
  });

  it("validates names against the specification", () => {
    expect(isValidSkillName("create-mr")).toBe(true);
    expect(isValidSkillName("a")).toBe(true);
    expect(isValidSkillName("Docs")).toBe(false);
    expect(isValidSkillName("-docs")).toBe(false);
    expect(isValidSkillName("docs-")).toBe(false);
    expect(isValidSkillName("doc--s")).toBe(false);
    expect(isValidSkillName("a b")).toBe(false);
  });

  it("expands $ARGUMENTS or appends arguments", () => {
    expect(expandSkillTemplate("Do $ARGUMENTS carefully.", " auth ")).toBe("Do auth carefully.");
    expect(expandSkillTemplate("Review the changes", "src/auth.ts"))
      .toBe("Review the changes\n\nsrc/auth.ts");
    expect(expandSkillTemplate("Review the changes", "")).toBe("Review the changes");
  });
});
