import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sectionGroups } from "../../src/app/ui/pages/SettingsPage.js";
import { settingGroups } from "../../src/app/ui/lib/types.js";

const settingsPage = fileURLToPath(new URL("../../src/app/ui/pages/SettingsPage.tsx", import.meta.url));

/** 设置分组一旦定义就必须被某个标签页渲染，否则字段在界面上不可见。 */
describe("operations UI settings groups", () => {
  it("renders every declared setting group", () => {
    const source = readFileSync(settingsPage, "utf8");
    const missing = settingGroups
      .filter((group) => !source.includes(`renderGroup("${group.titleKey}")`))
      .map((group) => group.titleKey);
    expect(missing).toEqual([]);
  });

  it("keeps the validated field groups in sync with the rendered groups", () => {
    const declared = new Set(settingGroups.map((group) => group.titleKey));
    const validated = new Set(Object.values(sectionGroups).flat());
    expect([...validated].filter((key) => !declared.has(key))).toEqual([]);
    expect([...declared].filter((key) => !validated.has(key))).toEqual([]);
  });
});
