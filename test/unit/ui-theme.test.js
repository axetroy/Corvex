import { describe, expect, it } from "vitest";
import { resolveTheme, resolveThemeMode } from "../../src/app/ui/theme.ts";

describe("operations UI theme", () => {
  it("treats missing or unknown preferences as system", () => {
    expect(resolveThemeMode("")).toBe("system");
    expect(resolveThemeMode("auto")).toBe("system");
  });

  it("keeps explicit light and dark preferences", () => {
    expect(resolveThemeMode("light")).toBe("light");
    expect(resolveThemeMode("dark")).toBe("dark");
  });

  it("follows the browser preference only in system mode", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});
