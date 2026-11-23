import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 旧工具结果保留的原文长度；超过部分换成提示，让模型按需重新精确读取。 */
const defaultMaxKeptChars = 400;
/** 最近多少条工具结果保持原样。 */
const defaultKeepRecent = 4;

export interface MicrocompactResult {
  messages: Record<string, unknown>[];
  changed: boolean;
  pruned: number;
  savedChars: number;
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
  const next = messages.map((message, index) => {
    if (message.role !== "toolResult" || protectedIndices.has(index)) return message;
    const text = contentText(message.content);
    if (text.length <= maxKeptChars) return message;
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const note = `\n\n[Corvex microcompact: earlier ${toolName} result shortened (${text.length - maxKeptChars} chars removed). Re-read with a narrower path or line range if needed.]`;
    const content = [{ type: "text" as const, text: `${text.slice(0, maxKeptChars)}${note}` }];
    changed = true;
    pruned += 1;
    savedChars += text.length - content[0]!.text.length;
    return { ...message, content };
  });
  return { messages: next, changed, pruned, savedChars };
}

export interface MicrocompactOptions {
  keepRecent?: number;
  maxKeptChars?: number;
  onPruned?: (pruned: number, savedChars: number) => void;
}

/**
 * 注册上下文微压缩扩展：在每次模型调用前裁剪旧工具结果，避免为一次大输出
 * 触发整轮 LLM 摘要压缩。
 */
export function createMicrocompactExtension(options: MicrocompactOptions = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("context", (event) => {
      const messages = event.messages as unknown as Record<string, unknown>[];
      const result = microcompactMessages(messages, options);
      if (!result.changed) return;
      options.onPruned?.(result.pruned, result.savedChars);
      return { messages: result.messages as unknown as typeof event.messages };
    });
  };
}
