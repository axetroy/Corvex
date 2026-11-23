import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSettingsPayload } from "../../src/app/ui/settingsPayload.ts";
import { settingGroups } from "../../src/app/ui/types.ts";

const settingsPage = readFileSync(
  fileURLToPath(new URL("../../src/app/ui/components/SettingsPage.tsx", import.meta.url)),
  "utf8",
);

describe("settings save payload", () => {
  it("only submits keys the connected server actually manages", () => {
    const draft = {
      web_enabled: false,
      project_agents_md: true,
      project_agents_md_max_bytes: 65_536,
    };
    const payload = buildSettingsPayload(settingGroups, draft, new Set(["web_enabled"]));
    expect(payload).toEqual({ web_enabled: false });
    expect(payload).not.toHaveProperty("project_agents_md_max_bytes");
  });

  it("submits all known changed keys on a current server", () => {
    const draft = { project_agents_md: true, project_agents_md_max_bytes: 65_536 };
    const known = new Set(Object.keys(draft));
    expect(buildSettingsPayload(settingGroups, draft, known)).toEqual(draft);
  });

  it("validates with the displayed value and skips keys the server does not manage", () => {
    // 不可见的校验错误会让保存按钮静默禁用：校验必须和输入框用同一个回退值，
    // 且不能对服务端不认识的键报错。
    expect(settingsPage).toContain("fieldError(field, draft[field.key] ?? field.defaultValue, copy)");
    expect(settingsPage).toContain(".filter((field) => serverKeys.has(field.key))");
  });

  it("submits known keys present in the draft (all editable keys on a current server)", () => {
    expect(buildSettingsPayload(settingGroups, { web_enabled: true }, new Set(["web_enabled"]))).toEqual({ web_enabled: true });
  });
});
