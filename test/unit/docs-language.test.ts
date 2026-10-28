import { describe, expect, it } from "vitest";
import { getPreferredLocale } from "../../docs/.vitepress/theme/language.js";

describe("getPreferredLocale", () => {
  it("uses the first supported language in the browser preference list", () => {
    expect(getPreferredLocale(["fr-FR", "zh-TW", "en-US"])).toBe("zh-CN");
    expect(getPreferredLocale(["fr-FR", "en-US", "zh-CN"])).toBe("en");
  });

  it("falls back to English when no supported language is present", () => {
    expect(getPreferredLocale(["fr-FR", "de-DE"])).toBe("en");
  });
});
