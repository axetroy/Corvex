import { describe, expect, it } from "vitest";
import { fitMiddleEllipsis } from "../../src/app/ui/truncate.ts";

/** 测试用的简化字宽：ASCII 1，中文 2。 */
function measure(text: string): number {
  return [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 127 ? 2 : 1), 0);
}

describe("operations UI fitted middle ellipsis", () => {
  it("keeps short text whole", () => {
    expect(fitMiddleEllipsis("Read file a.ts", measure, 100)).toEqual({ head: "Read file a.ts", tail: "" });
  });

  it("splits long text into balanced head and tail that fit the width", () => {
    const text = `读取 packages/preview-hook/src/feature/DisableContextMenu.js 文件（第 1-200 行）`;
    const { head, tail } = fitMiddleEllipsis(text, measure, 20);
    expect(head.length).toBeGreaterThan(0);
    expect(tail.length).toBeGreaterThan(0);
    expect(Math.abs(head.length - tail.length)).toBeLessThanOrEqual(3);
    expect(head + "..." + tail).not.toBe(text);
  });

  it("never returns an empty head or tail for text that needs truncation", () => {
    const { head, tail } = fitMiddleEllipsis("abcdefghij", measure, 7);
    expect(head).not.toBe("");
    expect(tail).not.toBe("");
  });
});
