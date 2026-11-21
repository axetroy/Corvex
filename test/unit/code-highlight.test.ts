import { describe, expect, it } from "vitest";
import { highlightCode } from "../../src/app/ui/codeHighlight.ts";

describe("file code highlighting", () => {
  it("highlights a known language", () => {
    const html = highlightCode("const value: number = 1;", "a.ts");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("value");
  });

  it("escapes raw HTML in file content", () => {
    const html = highlightCode("<script>alert(1)</script>", "a.unknown");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;");
  });

  it("falls back to auto detection without throwing", () => {
    expect(() => highlightCode("SELECT * FROM users", "query.unknown")).not.toThrow();
  });
});
