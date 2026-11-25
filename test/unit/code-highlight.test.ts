import { describe, expect, it } from "vitest";
import { escapeHtml, highlightCode } from "../../src/app/ui/lib/codeHighlight";

describe("chat code highlighting", () => {
  it("highlights a known language from a fenced code info string", () => {
    const html = highlightCode("const value: number = 1;", "ts");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("value");
  });

  it("maps common aliases to highlight.js language names", () => {
    expect(highlightCode("SELECT * FROM users", "sql")).toContain("hljs-keyword");
    expect(highlightCode("def hello(): pass", "py")).toContain("hljs-keyword");
    expect(highlightCode("<div>x</div>", "xml")).toContain("hljs-name");
  });

  it("escapes raw HTML and never emits a script tag", () => {
    const html = highlightCode("<script>alert(1)</script>", "unknown");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
    expect(escapeHtml(`<&"`)).toBe("&lt;&amp;&quot;");
  });

  it("falls back to auto detection without throwing", () => {
    expect(() => highlightCode("SELECT * FROM users", "")).not.toThrow();
    expect(() => highlightCode("plain text", "not-a-language")).not.toThrow();
  });
});
