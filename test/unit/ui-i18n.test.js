import { describe, expect, it } from "vitest";
import { en, resolveLocale, resolveLocaleMode, zhCN } from "../../src/app/ui/i18n.ts";

describe("operations UI locale", () => {
  it("uses Simplified Chinese when it is the browser language", () => {
    expect(resolveLocale(["zh-CN", "en-US"])).toBe("zh-CN");
  });

  it("falls back to English when the browser language is unsupported", () => {
    expect(resolveLocale(["fr-FR", "de-DE"])).toBe("en");
  });

  it("defaults to following the system and migrates an old explicit choice", () => {
    expect(resolveLocaleMode("", "")).toBe("system");
    expect(resolveLocaleMode("", "zh-CN")).toBe("zh-CN");
    expect(resolveLocaleMode("system", "en")).toBe("system");
    expect(resolveLocaleMode("fr", "en")).toBe("en");
    expect(resolveLocaleMode("fr", "de")).toBe("system");
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
    expect(en.languageSystem).toBe("Follow system");
    expect(zhCN.languageSystem).toBe("跟随系统");
    expect(en.themeLabel).toBe("Theme");
    expect(zhCN.themeLabel).toBe("主题");
    expect(en.themeSystem).toBe("Follow system");
    expect(zhCN.themeDark).toBe("深色");
    expect(en.filePanelImageOpen).toBe("Open original");
    expect(zhCN.filePanelImageError).toBe("图片无法预览（格式不支持或文件过大）。");
    expect(en.filePanelSourceTemplate).toBe("Source: {value}");
    expect(zhCN.filePanelSourceLocal).toBe("本地工作区");
    expect(en.scrollToBottom).toBe("Scroll to latest");
    expect(zhCN.fileMenuCopyPath).toBe("复制路径");
    expect(en.fileMenuDelete).toBe("Delete");
    expect(zhCN.scrollToBottom).toBe("滚动到最新");
    expect(en.codeCopied).toBe("Copied");
    expect(zhCN.codeCopyFailed).toBe("复制失败");
    expect(en.filePanelReadOnlyMessage).toBe("Cannot edit in read-only editor");
    expect(zhCN.filePanelReadOnlyMessage).toBe("无法在只读编辑器中编辑");
    expect(en.filePanelImageFit).toBe("Fit");
    expect(zhCN.filePanelImageHint).toBe("滚轮缩放，拖拽平移，双击复位");
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(zhCN.statuses).sort()).toEqual(Object.keys(en.statuses).sort());
    expect(Object.keys(zhCN.types).sort()).toEqual(Object.keys(en.types).sort());
    expect(Object.keys(zhCN.outcomes).sort()).toEqual(Object.keys(en.outcomes).sort());
  });
});
