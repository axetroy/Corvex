import { getOverflowPatterns } from "@earendil-works/pi-ai/utils/overflow";
import type { CorvexConfig } from "../config/config.js";

/**
 * 提示词 token 预算与裁剪。
 *
 * 模型上下文窗口是硬限制，超出后服务端直接返回 400；与其让请求失败，不如在
 * 出站前按保守估算把输入裁到预算内。估算采用 chars/4 的经验值，与 Pi SDK 的
 * `estimateTokens` 一致：宁可高估（少注入一点历史），也不要低估导致请求超限。
 */

/** 每条消息注入时保留的最大字符数，避免单条历史吞掉整个预算。 */
const maxHistoryMessageCharacters = 20_000;
/** 估算用的固定开销：system 提示、工具定义与消息框架。 */
const framingOverheadTokens = 2_000;

/** 保守估算文本占用的 token 数（chars/4 向上取整）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 单次请求可用的输入 token 上限：优先取配置，否则由窗口减输出与固定开销推导。 */
export function resolveMaxInputTokens(
  config: Pick<CorvexConfig["agent"], "maxInputTokens" | "contextWindow" | "maxOutputTokens">,
): number {
  if (config.maxInputTokens > 0) return config.maxInputTokens;
  const derived = config.contextWindow - config.maxOutputTokens - framingOverheadTokens;
  return Math.max(1_024, derived);
}

/**
 * 判定错误文本是否为上下文超限。模式直接复用 Pi SDK 的规范列表
 * （`getOverflowPatterns`），再补充 SDK 未覆盖的服务端措辞，避免与上游漂移。
 * 命中后可以收缩输入重试一次。
 */
const sdkOverflowPatterns = getOverflowPatterns();
/** SDK 未覆盖的额外超限措辞。 */
const extraOverflowPatterns = [
  /exceed[_ ]?context[_ ]size/i, // 阿里云百炼 / DashScope: exceed_context_size_error
  /context (?:size|window) exceeded/i,
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras 无响应体的 400/413
];
/** 明确不属于超限的错误，避免把限流、服务不可用误判为超限而触发无谓重试。 */
const nonOverflowPatterns = [
  /^(Throttling error|Service unavailable):/i,
  /rate limit/i,
  /too many requests/i,
];

/** 错误文本是否表明请求超出模型上下文窗口。 */
export function isContextOverflowError(message: string): boolean {
  if (nonOverflowPatterns.some((pattern) => pattern.test(message))) return false;
  return sdkOverflowPatterns.some((pattern) => pattern.test(message)) ||
    extraOverflowPatterns.some((pattern) => pattern.test(message));
}

export interface HistoryMessage {
  /** 消息 ID；摘要边界需要它，纯文本注入时可省略。 */
  id?: string;
  role: "user" | "assistant";
  content: string;
}

export interface TrimmedHistory<T extends HistoryMessage> {
  /** 裁剪后保留的历史消息，按时间升序。 */
  messages: T[];
  /** 因预算被丢弃的较早历史，按时间升序；用于生成滚动摘要。 */
  dropped: T[];
}

/**
 * 按 token 预算裁剪历史：从最旧开始丢弃，直到剩余历史落在预算内。
 * 单条消息先按字符上限截断，避免一条超长消息把预算全部吃掉。
 * 最近一条消息即使超出预算也保留（截断后），否则对话无法继续。
 */
export function trimHistory<T extends HistoryMessage>(history: readonly T[], budgetTokens: number): TrimmedHistory<T> {
  const normalized = history.map((message) => ({
    ...message,
    content: message.content.length > maxHistoryMessageCharacters
      ? `${message.content.slice(0, maxHistoryMessageCharacters)}\n[truncated]`
      : message.content,
  }));
  const kept: T[] = [];
  let used = 0;
  let cutIndex = normalized.length;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index]!;
    const cost = estimateTokens(message.content) + 4;
    if (kept.length > 0 && used + cost > budgetTokens) break;
    kept.unshift(message);
    used += cost;
    cutIndex = index;
  }
  return { messages: kept, dropped: normalized.slice(0, cutIndex) };
}

/**
 * 组装对话请求的 user 提示词：仓库快照、可选的滚动摘要与当前请求。
 * 历史不作为文本嵌入，而是由 `ModelRequest.history` 以独立消息注入，避免重复。
 */
export function buildConversationPrompt(options: {
  repository: { project: string; branch: string; headSha: string };
  summary: string | null;
  currentRequest: string;
}): string {
  return JSON.stringify({
    repository: options.repository,
    ...(options.summary ? { summary: options.summary } : {}),
    currentRequest: options.currentRequest,
  });
}
