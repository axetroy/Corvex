import { describe, expect, it } from "vitest";
import { domainSummaryInstructions } from "../../src/agent/domain-summary.ts";

describe("domain summary instructions", () => {
  it("asks for files, decisions, pending work and rejected approaches", () => {
    const en = domainSummaryInstructions("en");
    expect(en).toContain("Files and paths");
    expect(en).toContain("Confirmed findings");
    expect(en).toContain("Pending work");
    expect(en).toContain("Rejected approaches");
  });

  it("uses Chinese sections for Chinese responses", () => {
    const zh = domainSummaryInstructions("zh-CN");
    expect(zh).toContain("文件与路径");
    expect(zh).toContain("待办");
    expect(zh).toContain("已排除方案");
  });
});
