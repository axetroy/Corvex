import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** 页面与组件分目录后，源码读取要在两个目录里查找。 */
const read = (name: string) => {
  const found = ["components", "pages"]
    .map((dir) => new URL(`../../src/app/ui/${dir}/${name}`, import.meta.url))
    .find((url) => existsSync(fileURLToPath(url)));
  if (!found) throw new Error(`missing UI source: ${name}`);
  return readFileSync(fileURLToPath(found), "utf8");
};

describe("conversation markdown rendering", () => {
  it("renders mermaid fences as lazy-loaded diagrams instead of highlighted code", () => {
    const code = read("MarkdownCode.tsx");
    expect(code).toContain('lazy(() => import("./MarkdownDiagram.js"))');
    expect(code).toContain('language === "mermaid"');
    expect(code).toContain('language === "flowchart"');
    // 流式未完成时不能直接渲染半成品图表。
    expect(code).toContain('streamStatus === "loading"');
  });

  it("stamps the CSP nonce on Mermaid's inline SVG style before injection", () => {
    const diagram = read("MarkdownDiagram.tsx");
    expect(diagram).toContain('securityLevel: "strict"');
    expect(diagram).toContain('svg.replace(/<style\\b/g');
    expect(diagram).toContain("data-theme");
  });

  it("applies GitHub-style table borders, header background and zebra rows", () => {
    const css = read("ConversationsPage.css");
    expect(css).toContain("table:not(pre)");
    expect(css).toContain("border: 1px solid var(--border)");
    expect(css).toContain("background: var(--bg-subtle)");
    expect(css).toContain("tbody tr:nth-child(2n)");
    expect(css).toContain("6px 13px");
  });
});
