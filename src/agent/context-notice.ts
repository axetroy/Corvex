import type { ResponseLanguage } from "../config/config.js";

/** 一次上下文变化的阶段；`trim` 是 Corvex 自己裁掉历史后的重试。 */
export type ContextChangePhase = "start" | "end" | "failed" | "trim";

/** 触发压缩的原因和窗口信息，用来向用户解释「为什么现在压缩」。 */
export interface ContextTriggerInfo {
  reason?: string;
  tokens?: number | null;
  window?: number;
  threshold?: number;
}

function formatTokens(value: number | undefined | null): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function percent(tokens: number | undefined | null, window: number | undefined): number | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || !window || window <= 0) return null;
  return Math.round(tokens * 100 / window);
}

function reasonLabel(language: ResponseLanguage, reason: string | undefined): string {
  if (reason === "overflow") return language === "zh-CN" ? "上下文已超出窗口" : "context exceeded the window";
  if (reason === "manual") return language === "zh-CN" ? "手动触发压缩" : "manual compaction requested";
  return language === "zh-CN" ? "达到压缩阈值" : "reached the compaction threshold";
}

/** 把 SDK 的压缩事件或本地裁剪转成用户可见的中文/英文提示。 */
export function contextNoticeText(
  language: ResponseLanguage,
  phase: ContextChangePhase,
  tokensBefore?: number,
  tokensAfter?: number,
  info?: ContextTriggerInfo,
): string {
  const before = formatTokens(tokensBefore);
  const after = formatTokens(tokensAfter);
  if (phase === "start" && info && typeof info.tokens === "number" && info.window) {
    const ratio = percent(info.tokens, info.window);
    const share = language === "zh-CN"
      ? `${formatTokens(info.tokens)}/${formatTokens(info.window)} token${ratio === null ? "" : `（${ratio}%）`}`
      : `${formatTokens(info.tokens)}/${formatTokens(info.window)} tokens${ratio === null ? "" : ` (${ratio}%)`}`;
    const trigger = typeof info.threshold === "number" && info.reason === "threshold"
      ? `${language === "zh-CN" ? "达到压缩阈值" : "reached the compaction threshold"} ${formatTokens(info.threshold)}`
      : reasonLabel(language, info.reason);
    return language === "zh-CN"
      ? `上下文已达 ${share}，${trigger}，正在压缩…`
      : `Context is at ${share}, ${trigger}; compacting...`;
  }
  if (language === "zh-CN") {
    if (phase === "start") return "正在压缩上下文…";
    if (phase === "failed") return "上下文压缩失败，继续尝试。";
    if (phase === "trim") return "历史上下文过长，已裁剪后重试。";
    return `上下文已压缩：${before} → ${after} token`;
  }
  if (phase === "start") return "Compacting context...";
  if (phase === "failed") return "Context compaction failed; continuing.";
  if (phase === "trim") return "History was too long; retried with trimmed context.";
  return `Context compacted: ${before} → ${after} tokens`;
}

/** 本轮从 worktree 加载项目指导后的可见提示。 */
export function projectGuidanceNoticeText(language: ResponseLanguage, bytes: number, truncated: boolean): string {
  const suffix = truncated
    ? (language === "zh-CN" ? "（已按预算截断）" : " (truncated to the size budget)")
    : "";
  return language === "zh-CN"
    ? `已加载项目 AGENTS.md（${bytes} 字节）作为本轮指导${suffix}。`
    : `Loaded project AGENTS.md (${bytes} bytes) as guidance for this turn${suffix}.`;
}

/** 等待模型首响应期间，每隔一段时间显示的进度提示。 */
export function responseWaitNoticeText(language: ResponseLanguage, waitedSeconds: number, stallSeconds: number): string {
  return language === "zh-CN"
    ? `模型响应较慢，已等待 ${waitedSeconds} 秒；超过 ${stallSeconds} 秒无输出将自动中止。`
    : `The model is taking longer than usual (${waitedSeconds}s); the turn aborts after ${stallSeconds}s without output.`;
}

/** 旧工具结果被裁剪时的通知文本。 */
export function microcompactNoticeText(language: ResponseLanguage, pruned: number, savedChars: number): string {
  return language === "zh-CN"
    ? `已裁剪 ${pruned} 条旧工具结果，节省约 ${savedChars} 字符。`
    : `Pruned ${pruned} older tool results (~${savedChars} chars).`;
}
