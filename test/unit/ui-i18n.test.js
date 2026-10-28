import { describe, expect, it } from "vitest";
import { en, resolveLocale, zhCN } from "../../src/app/ui/i18n.js";

describe("operations UI locale", () => {
  it("uses Simplified Chinese when it is the browser language", () => {
    expect(resolveLocale("", ["zh-CN", "en-US"])).toBe("zh-CN");
  });

  it("uses a saved language preference ahead of the browser language", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
  });

  it("falls back to English when the browser language is unsupported", () => {
    expect(resolveLocale("", ["fr-FR", "de-DE"])).toBe("en");
  });

  it("provides matching English and Simplified Chinese dashboard catalogs", () => {
    expect(zhCN.overviewTitle).toBe("概览");
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zhCN.statuses).sort()).toEqual(Object.keys(en.statuses).sort());
    expect(Object.keys(zhCN.types).sort()).toEqual(Object.keys(en.types).sort());
    expect(Object.keys(zhCN.outcomes).sort()).toEqual(Object.keys(en.outcomes).sort());
  });
});
