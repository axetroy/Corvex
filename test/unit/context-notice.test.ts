import { describe, expect, it } from "vitest";
import { contextNoticeText } from "../../src/agent/context-notice.ts";

describe("context change notices", () => {
  it("describes a finished compaction with token counts in both languages", () => {
    expect(contextNoticeText("zh-CN", "end", 42_000, 12_000)).toBe("上下文已压缩：42000 → 12000 token");
    expect(contextNoticeText("en", "end", 42_000, 12_000)).toBe("Context compacted: 42000 → 12000 tokens");
  });

  it("describes an in-progress compaction and a failure", () => {
    expect(contextNoticeText("zh-CN", "start")).toBe("正在压缩上下文…");
    expect(contextNoticeText("en", "failed")).toBe("Context compaction failed; continuing.");
  });

  it("describes the history-trimming retry", () => {
    expect(contextNoticeText("zh-CN", "trim")).toBe("历史上下文过长，已裁剪后重试。");
    expect(contextNoticeText("en", "trim")).toBe("History was too long; retried with trimmed context.");
  });
});
