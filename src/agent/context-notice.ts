import type { ResponseLanguage } from "../config/config.js";

/** 一次上下文变化的阶段；`trim` 是 Corvex 自己裁掉历史后的重试。 */
export type ContextChangePhase = "start" | "end" | "failed" | "trim";

function formatTokens(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

/** 把 SDK 的压缩事件或本地裁剪转成用户可见的中文/英文提示。 */
export function contextNoticeText(
  language: ResponseLanguage,
  phase: ContextChangePhase,
  tokensBefore?: number,
  tokensAfter?: number,
): string {
  const before = formatTokens(tokensBefore);
  const after = formatTokens(tokensAfter);
  if (language === "zh-CN") {
    if (phase === "start") return "正在压缩上下文…";
    if (phase === "failed") return "上下文压缩失败，继续尝试。";
    if (phase === "trim") return "历史上下文过长，已裁剪后重试。";
    return `上下文已压缩：${before} → ${after} token`;
  }
  if (phase === "start") return "Compacting context…";
  if (phase === "failed") return "Context compaction failed; continuing.";
  if (phase === "trim") return "History was too long; retried with trimmed context.";
  return `Context compacted: ${before} → ${after} tokens`;
}
