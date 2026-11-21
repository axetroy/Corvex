import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import nesting from "postcss-nesting";

const viteConfig = fileURLToPath(new URL("../../src/app/ui/vite.config.ts", import.meta.url));
const postcssConfig = fileURLToPath(new URL("../../postcss.config.mjs", import.meta.url));

/** 控制台样式必须经 PostCSS 嵌套插件编译，避免 & 选择器直接进产物。 */
describe("operations UI PostCSS", () => {
  it("enables CSS nesting in both Vite and the standalone PostCSS config", () => {
    expect(readFileSync(viteConfig, "utf8")).toContain("postcss-nesting");
    expect(readFileSync(postcssConfig, "utf8")).toContain("postcss-nesting");
  });

  it("flattens & rules back to the original specificity", async () => {
    const source = ".detail-item { padding: 4px; & dt { color: red; } &.active { color: blue; } }";
    const result = await postcss([nesting()]).process(source, { from: undefined });
    expect(result.css).toBe(
      ".detail-item { padding: 4px; }\n.detail-item dt { color: red; }\n.detail-item.active { color: blue; }",
    );
  });
});
