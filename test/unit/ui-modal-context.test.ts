import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const uiDirectory = fileURLToPath(new URL("../../src/app/ui/", import.meta.url));

/** 递归收集控制台源码，跳过文案与纯逻辑文件。 */
function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

// 静态调用会渲染在 ConfigProvider 之外，拿不到主题与 CSP nonce，
// 运行时注入的样式被浏览器拦截后弹窗不可见。必须用 hook 形式并渲染 contextHolder。
const forbidden = /\bModal\.(?:confirm|info|success|error|warning)\(|\b(?:message|notification)\.(?:open|success|error|info|warning|loading)\(/;

describe("operations UI feedback components", () => {
  it("never uses static Modal or message helpers outside ConfigProvider", () => {
    const offenders = sourceFiles(uiDirectory)
      .filter((path) => forbidden.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(uiDirectory.length));
    expect(offenders).toEqual([]);
  });
});
