import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "../../src/app/ui/i18n.ts";

const uiDirectory = fileURLToPath(new URL("../../src/app/ui/", import.meta.url));

/** 递归收集运维台源码文件，跳过文案定义本身。 */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && entry.name !== "i18n.ts") files.push(path);
  }
  return files;
}

describe("operations UI copy catalog", () => {
  it("does not keep unused interface strings", () => {
    const sources = sourceFiles(uiDirectory).map((path) => readFileSync(path, "utf8")).join("\n");
    const unused = Object.keys(en).filter((key) => !new RegExp(`\\b${key}\\b`).test(sources));
    expect(unused).toEqual([]);
  });
});
