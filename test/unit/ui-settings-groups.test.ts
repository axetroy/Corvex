import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { settingGroups } from "../../src/app/ui/types.js";

const settingsPage = fileURLToPath(new URL("../../src/app/ui/components/SettingsPage.tsx", import.meta.url));

/** 设置分组一旦定义就必须被某个标签页渲染，否则字段在界面上不可见。 */
describe("operations UI settings groups", () => {
  it("renders every declared setting group", () => {
    const source = readFileSync(settingsPage, "utf8");
    const missing = settingGroups
      .filter((group) => !source.includes(`renderGroup("${group.titleKey}")`))
      .map((group) => group.titleKey);
    expect(missing).toEqual([]);
  });
});
