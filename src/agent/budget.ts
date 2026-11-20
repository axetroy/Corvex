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

/**
 * 更保守的 token 估算：同时考虑字符数与 UTF-8 字节数。
 *
 * chars/4 对英文与代码大致准确，但对中文、压缩代码和 JSON 转义会明显低估——同一段
 * 文本真实分词后的 token 数可能接近「字节数 / 3」。裁剪历史时使用这个上界，避免
 * 估算通过的请求在服务端仍超窗。
 */
export function estimateConservativeTokens(text: string): number {
  return Math.max(Math.ceil(text.length / 4), Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

/** 单次请求可用的输入 token 上限：优先取配置，否则由窗口减输出与固定开销推导。 */
export function resolveMaxInputTokens(
  config: Pick<CorvexConfig["agent"], "maxInputTokens" | "contextWindow" | "maxOutputTokens">,
): number {
  if (Number.isFinite(config.maxInputTokens) && config.maxInputTokens > 0) return config.maxInputTokens;
  const derived = (config.contextWindow ?? 0) - (config.maxOutputTokens ?? 0) - framingOverheadTokens;
  if (!Number.isFinite(derived)) return 1_024;
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
  /context (?:size|window) (?:has been |is )?exceeded/i, // llama.cpp: "Context size has been exceeded."
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

/**
 * 对话历史可用的 token 预算：配置的历史预算与「单次请求输入上限」取较小值。
 *
 * `max_input_tokens` 因此不再只是展示用的配置：它会把 system 提示与当前请求之外的
 * 剩余额度交给历史裁剪，超出部分进入滚动摘要。
 */
export function resolveHistoryBudgetTokens(
  config: Pick<CorvexConfig["agent"], "maxInputTokens" | "contextWindow" | "maxOutputTokens" | "historyTokenBudget">,
  fixedPromptTokens: number,
): number {
  const configured = Number.isFinite(config.historyTokenBudget) ? config.historyTokenBudget : 0;
  const available = resolveMaxInputTokens(config) - Math.max(0, fixedPromptTokens);
  return Math.max(0, Math.min(configured, available));
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
    const cost = estimateConservativeTokens(message.content) + 4;
    if (kept.length > 0 && used + cost > budgetTokens) break;
    kept.unshift(message);
    used += cost;
    cutIndex = index;
  }
  return { messages: kept, dropped: normalized.slice(0, cutIndex) };
}

/**
 * 把待摘要的历史切成若干块：每块连同滚动摘要保守估算不超过预算。
 *
 * 摘要请求同样受窗口限制：把全部被裁剪的历史塞进一次请求，长对话迟早会超窗，
 * 而摘要失败会被吞掉、边界不再推进，早期上下文就永久丢失。分块后每块都能落在
 * 窗口内，滚动摘要逐块累积。单条超预算消息独占一块，保证循环一定推进。
 */
export function chunkForSummary<T extends HistoryMessage>(
  summary: string | null,
  messages: readonly T[],
  budgetTokens: number,
): T[][] {
  const budget = Math.max(1_024, budgetTokens);
  const summaryCost = summary ? estimateConservativeTokens(summary) + 4 : 0;
  const chunks: T[][] = [];
  let index = 0;
  while (index < messages.length) {
    let used = summaryCost;
    const chunk: T[] = [];
    while (index < messages.length) {
      const cost = estimateConservativeTokens(messages[index]!.content) + 4;
      if (chunk.length > 0 && used + cost > budget) break;
      chunk.push(messages[index]!);
      used += cost;
      index += 1;
    }
    chunks.push(chunk);
  }
  return chunks;
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
