import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 旧工具结果保留的原文长度；超过部分换成提示，让模型按需重新精确读取。 */
const defaultMaxKeptChars = 400;
/** 最近多少条工具结果保持原样。 */
const defaultKeepRecent = 4;

/**
 * 按模型窗口推导微压缩策略：大窗口下保留更多最近结果、并只在真正接近窗口时才裁剪。
 * 小窗口仍维持较激进的默认值，避免上下文溢出。
 */
export function resolveMicrocompactPolicy(
  contextWindow: number,
  compactionTriggerPercent = 85,
): { keepRecent: number; maxKeptChars: number; triggerTokens: number } {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 131_072;
  const keepRecent = Math.min(24, Math.max(defaultKeepRecent, Math.round(window / 40_000)));
  const maxKeptChars = window >= 200_000 ? 2_000 : defaultMaxKeptChars;
  const percent = Math.max(20, Math.min(95, (Number.isFinite(compactionTriggerPercent) ? compactionTriggerPercent : 85) - 15));
  return { keepRecent, maxKeptChars, triggerTokens: Math.floor(window * percent / 100) };
}

/** 稳定标识：优先用 SDK 的 toolCallId，否则用原文摘要；下标会随新消息移动，不能当标识。 */
function toolResultIdentity(message: Record<string, unknown>, text: string): string {
  const id = typeof message.toolCallId === "string" && message.toolCallId
    ? message.toolCallId
    : typeof message.id === "string" && message.id
      ? message.id
      : "";
  if (id) return id;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return `text:${(hash >>> 0).toString(16)}`;
}

export interface MicrocompactEntry {
  identity: string;
  savedChars: number;
}

export interface MicrocompactResult {
  messages: Record<string, unknown>[];
  changed: boolean;
  pruned: number;
  savedChars: number;
  /** 本次被裁剪项的稳定标识；连续请求中集合变化才代表有新结果被裁剪。 */
  signature: string;
  entries: MicrocompactEntry[];
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

/**
 * 把较早且过大的 toolResult 内容裁剪成有界原文 + 提示，最近若干条保持完整。
 * 只在发给模型前生效，不修改会话历史与轨迹；模型需要细节时可用更窄的路径重新读取。
 */
export function microcompactMessages(
  messages: readonly Record<string, unknown>[],
  options: { keepRecent?: number; maxKeptChars?: number } = {},
): MicrocompactResult {
  const keepRecent = options.keepRecent ?? defaultKeepRecent;
  const maxKeptChars = options.maxKeptChars ?? defaultMaxKeptChars;
  const toolIndices = messages
    .map((message, index) => message.role === "toolResult" ? index : -1)
    .filter((index) => index >= 0);
  const protectedIndices = new Set(keepRecent > 0 ? toolIndices.slice(-keepRecent) : []);

  let changed = false;
  let pruned = 0;
  let savedChars = 0;
  const entries: MicrocompactEntry[] = [];
  const next = messages.map((message, index) => {
    if (message.role !== "toolResult" || protectedIndices.has(index)) return message;
    const text = contentText(message.content);
    if (text.length <= maxKeptChars) return message;
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const note = `\n\n[Corvex microcompact: earlier ${toolName} result shortened (${text.length - maxKeptChars} chars removed). Re-read with a narrower path or line range if needed.]`;
    const content = [{ type: "text" as const, text: `${text.slice(0, maxKeptChars)}${note}` }];
    const saved = text.length - content[0]!.text.length;
    changed = true;
    pruned += 1;
    savedChars += saved;
    entries.push({ identity: toolResultIdentity(message, text), savedChars: saved });
    return { ...message, content };
  });
  return {
    messages: next,
    changed,
    pruned,
    savedChars,
    signature: entries.map((entry) => entry.identity).join(","),
    entries,
  };
}

export interface MicrocompactOptions {
  keepRecent?: number;
  maxKeptChars?: number;
  /** 估算 token 达到该阈值才裁剪；低于阈值时完全不改请求。 */
  triggerTokens?: number;
  estimateTokens?: (messages: readonly Record<string, unknown>[]) => number;
  /** 只上报「本次新进入裁剪集合」的结果，避免重复计数与刷屏。 */
  onPruned?: (pruned: number, savedChars: number, signature: string) => void;
}

/**
 * 注册上下文微压缩扩展：每次模型请求前按窗口压力裁剪旧工具结果。
 * SDK 不会把改写后的消息写回会话历史，所以每次请求都要重新返回裁剪后的列表；
 * 但通知与指标只按稳定标识上报一次，避免同一批旧结果被反复计数。
 */
export function createMicrocompactExtension(options: MicrocompactOptions = {}): (pi: ExtensionAPI) => void {
  const known = new Set<string>();
  return (pi) => {
    pi.on("context", (event) => {
      const messages = event.messages as unknown as Record<string, unknown>[];
      if (
        options.triggerTokens !== undefined &&
        options.triggerTokens > 0 &&
        options.estimateTokens &&
        options.estimateTokens(messages) < options.triggerTokens
      ) {
        return;
      }
      const result = microcompactMessages(messages, options);
      if (!result.changed) return;
      const fresh = result.entries.filter((entry) => !known.has(entry.identity));
      for (const entry of fresh) known.add(entry.identity);
      if (fresh.length > 0) {
        options.onPruned?.(
          fresh.length,
          fresh.reduce((total, entry) => total + entry.savedChars, 0),
          fresh.map((entry) => entry.identity).join(","),
        );
      }
      return { messages: result.messages as unknown as typeof event.messages };
    });
  };
}
