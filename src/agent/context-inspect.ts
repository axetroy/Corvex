import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactSensitiveText } from "../redact.js";
import { estimateConservativeTokens } from "./budget.js";
import type { TokenCounter } from "./token-counter.js";

/** 上下文组成的分类；与运维台预算卡片保持同一套语义。 */
export const contextCategories = ["system", "tools", "user", "inject", "assistant", "tool"] as const;
export type ContextCategory = typeof contextCategories[number];

export interface ContextItem {
  category: ContextCategory;
  name: string;
  tokens: number;
  /** 已脱敏、限长的原文预览，仅用于展示。 */
  preview: string;
}

/** 一次模型请求前的上下文快照；由 hook 产出并交给各 tap 消费。 */
export interface ContextSnapshotData {
  conversationId: string;
  turnId: string;
  requestSeq: number;
  createdAt: string;
  contextWindow: number;
  reservedOutput: number;
  threshold: number | null;
  estimatedTokens: number;
  breakdown: Record<ContextCategory, number>;
  counts: Record<ContextCategory, number>;
  items: ContextItem[];
  truncated: boolean;
}

export interface ContextInspectOptions {
  conversationId: string;
  turnId: string;
  contextWindow: number;
  reservedOutput: number;
  threshold: number | null;
  tokenCounter: TokenCounter;
  onSnapshot: (snapshot: ContextSnapshotData) => Promise<void> | void;
  /** 取消信号：token 计数调用必须可中断，避免轮次取消后仍等待 tokenize。 */
  signal?: AbortSignal;
  maxItems?: number;
  maxPreviewChars?: number;
}

const defaultMaxItems = 80;
const defaultMaxPreviewChars = 2_048;

interface RawItem {
  category: ContextCategory;
  name: string;
  text: string;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (typeof item.content === "string") parts.push(item.content);
  }
  return parts.join("\n");
}

/** Pi 把提示词拆进 system 消息的 sections：工具定义、规则、注入内容各有其章节名。 */
function categoryForSection(name: string): ContextCategory {
  if (name === "tools" || name === "rules") return "tools";
  if (name === "project_context" || name === "skills" || name === "addendum") return "inject";
  return "system";
}

/** 一条系统消息可能同时包含自定义提示词、若干章节与工具声明，需拆成多项。 */
function systemMessageItems(message: Record<string, unknown>): RawItem[] {
  const result: RawItem[] = [];
  const content = contentText(message.content);
  if (content) result.push({ category: "system", name: "system prompt", text: content });

  const sections = message.sections;
  if (sections && typeof sections === "object" && !Array.isArray(sections)) {
    for (const [name, value] of Object.entries(sections as Record<string, unknown>)) {
      if (typeof value !== "string" || !value) continue;
      result.push({ category: categoryForSection(name), name, text: value });
    }
  }

  // 真实字段是 toolsAdded（SDK 也兼容旧字段 tools）。
  const tools = message.toolsAdded ?? message.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    result.push({ category: "tools", name: "tool definitions", text: JSON.stringify(tools) });
  }
  return result;
}

function messageItems(message: Record<string, unknown>): RawItem[] {
  const role = message.role;
  if (role === "system") return systemMessageItems(message);
  const text = contentText(message.content);
  if (!text) return [];
  if (role === "toolResult" || role === "tool") {
    const name = typeof message.toolName === "string" && message.toolName.trim()
      ? message.toolName.trim().slice(0, 120) : "tool";
    return [{ category: "tool", name, text }];
  }
  if (role === "assistant") return [{ category: "assistant", name: "assistant", text }];
  if (role === "user") {
    const injected = message.name === "project-guidance";
    return [{ category: injected ? "inject" : "user", name: injected ? "project-guidance" : "user", text }];
  }
  return [];
}

/** 从完整请求消息计算有界组成与逐项预览；token 数优先用 provider /tokenize。 */
export async function buildContextSnapshotData(
  messages: readonly Record<string, unknown>[],
  options: Omit<ContextInspectOptions, "onSnapshot"> & { requestSeq: number },
): Promise<ContextSnapshotData> {
  const maxItems = options.maxItems ?? defaultMaxItems;
  const maxPreviewChars = options.maxPreviewChars ?? defaultMaxPreviewChars;
  const breakdown = Object.fromEntries(contextCategories.map((key) => [key, 0])) as Record<ContextCategory, number>;
  const counts = Object.fromEntries(contextCategories.map((key) => [key, 0])) as Record<ContextCategory, number>;
  const raw: RawItem[] = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    for (const item of messageItems(message as Record<string, unknown>)) {
      counts[item.category] += 1;
      raw.push(item);
    }
  }

  const allText = raw.map((item) => item.text).join("\n");
  const counted = await options.tokenCounter.count(allText, options.signal).catch(() => undefined);
  const estimatedTokens = counted ?? estimateConservativeTokens(allText);
  const chars = raw.reduce((sum, item) => sum + item.text.length, 0) || 1;

  const items: ContextItem[] = [];
  for (const item of raw) {
    const tokens = Math.max(1, Math.round(estimatedTokens * item.text.length / chars));
    breakdown[item.category] += tokens;
    items.push({
      category: item.category,
      name: item.name,
      tokens,
      preview: redactSensitiveText(item.text).slice(0, maxPreviewChars),
    });
  }

  return {
    conversationId: options.conversationId,
    turnId: options.turnId,
    requestSeq: options.requestSeq,
    createdAt: new Date().toISOString(),
    contextWindow: options.contextWindow,
    reservedOutput: options.reservedOutput,
    threshold: options.threshold,
    estimatedTokens,
    breakdown,
    counts,
    // 消息按时间从旧到新排列；保留尾部才能展示当前请求真正相关的内容。
    items: items.slice(-maxItems),
    truncated: items.length > maxItems,
  };
}

/**
 * 注册上下文采集扩展：只在每次模型请求前产出快照并交给 hook，
 * 不修改消息，也不把 SDK 原始对象写进数据库。
 */
export function createContextInspectExtension(options: ContextInspectOptions): (pi: ExtensionAPI) => void {
  let requestSeq = 0;
  return (pi) => {
    pi.on("context_with_system", async (event) => {
      requestSeq += 1;
      const snapshot = await buildContextSnapshotData(
        event.messages as unknown as Record<string, unknown>[],
        {
          conversationId: options.conversationId,
          turnId: options.turnId,
          contextWindow: options.contextWindow,
          reservedOutput: options.reservedOutput,
          threshold: options.threshold,
          tokenCounter: options.tokenCounter,
          signal: options.signal,
          maxItems: options.maxItems,
          maxPreviewChars: options.maxPreviewChars,
          requestSeq,
        },
      );
      await options.onSnapshot(snapshot);
    });
  };
}
