import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../../src/app/ui/components/ModelManager.tsx", import.meta.url)),
  "utf8",
);

describe("model manager table", () => {
  it("uses a fixed layout with explicit column widths so system and user provider cards align", () => {
    expect(source).toContain('tableLayout="fixed"');
    // 六列都必须给出宽度，否则 antd 会按各表内容自动分配，导致两张表列宽不一致。
    expect(source.match(/width: "\d+%"/g)).toHaveLength(6);
  });
});
