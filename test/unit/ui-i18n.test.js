import { describe, expect, it } from "vitest";
import { en, resolveLocale, zhCN } from "../../src/app/ui/i18n.ts";

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
    expect(en.age).toBe("Event duration");
    expect(zhCN.age).toBe("事件耗时");
    expect(en.conversationTurnActive).toBe("A response is already in progress for this conversation.");
    expect(zhCN.conversationTurnActive).toBe("该对话已有回复正在处理中。");
    expect(zhCN.traceFirstToken).toBe("Time to First Token (TTFT)");
    expect(zhCN.traceGenerationDuration).toBe("Generation duration");
    expect(zhCN.traceTps).toBe("Generation TPS");
    expect(zhCN.traceTpsTemplate).toBe("{value} tokens/s");
    expect(zhCN.executionSteps).toBe("执行步骤");
    expect(en.requester).toBe("Requester");
    expect(zhCN.requester).toBe("发起人");
    expect(en.triggerComment).toBe("Original comment");
    expect(zhCN.triggerComment).toBe("触发评论");
    expect(zhCN.executionStatuses.interrupted).toBe("已中断");
    expect(en.branchPickerHint).toBe("Type to search, or scroll to browse every branch.");
    expect(zhCN.branchPickerHint).toBe("输入关键字搜索，或滚动浏览全部分支。");
    expect(zhCN.pickerClear).toBe("清除选择");
    expect(zhCN.commitMinutesTemplate).toBe("{value} 分钟前");
    expect(zhCN.traceToolReadFileRangeTemplate).toBe("读取 {path} 文件（第 {start}-{end} 行）");
    expect(en.conversationModes.read_only).toBe("Read-only");
    expect(zhCN.conversationModes.read_only).toBe("只读");
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zhCN.statuses).sort()).toEqual(Object.keys(en.statuses).sort());
    expect(Object.keys(zhCN.types).sort()).toEqual(Object.keys(en.types).sort());
    expect(Object.keys(zhCN.outcomes).sort()).toEqual(Object.keys(en.outcomes).sort());
    expect(Object.keys(zhCN.conversationModes).sort()).toEqual(Object.keys(en.conversationModes).sort());
  });
});
