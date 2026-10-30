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
    expect(zhCN.traceTabSession).toBe("会话");
    expect(zhCN.traceTabTrace).toBe("轨迹");
    expect(zhCN.traceSessionUser).toBe("用户");
    expect(zhCN.traceSessionAssistant).toBe("助手");
    expect(zhCN.traceToolReadFileRangeTemplate).toBe("读取 {path} 文件（第 {start}-{end} 行）");
    expect(zhCN.traceToolDetails).toBe("查看调用详情");
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zhCN.statuses).sort()).toEqual(Object.keys(en.statuses).sort());
    expect(Object.keys(zhCN.types).sort()).toEqual(Object.keys(en.types).sort());
    expect(Object.keys(zhCN.outcomes).sort()).toEqual(Object.keys(en.outcomes).sort());
  });
});
