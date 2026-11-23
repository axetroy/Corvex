import type { CompactionResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 压缩前上下文里保留的一条消息；只取展示所需的角色与纯文本。 */
export interface ContextSnapshotMessage {
  role: string;
  text: string;
}

/** 一次上下文快照：token 估计、消息列表以及是否被裁剪。 */
export interface ContextSnapshot {
  tokens: number | null;
  messages: ContextSnapshotMessage[];
  truncated: boolean;
}

const defaultMaxMessages = 40;
const defaultMaxChars = 16_000;
const textRoles = new Set(["user", "assistant", "system", "toolResult"]);

function extractMessage(value: unknown): ContextSnapshotMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "";
  if (!textRoles.has(role)) return undefined;
  const content = record.content;
  if (typeof content === "string") return { role, text: content };
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const item = part as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "thinking" && item.redacted !== true && typeof item.thinking === "string") {
      parts.push(item.thinking);
    }
  }
  return parts.length > 0 ? { role, text: parts.join("\n") } : undefined;
}

/** 把消息内容展平成纯文本，供真实 token 计数使用（不做截断）。 */
export function messagesToText(messages: readonly unknown[]): string {
  return messages.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const content = record.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const item = part as Record<string, unknown>;
      if (item.type === "text" && typeof item.text === "string") return [item.text];
      if (item.type === "thinking" && item.redacted !== true && typeof item.thinking === "string") return [item.thinking];
      return [];
    });
  }).join("\n");
}

/**
 * 把 SDK 的 AgentMessage 列表转成有界的上下文快照，供轨迹展示压缩前的上下文。
 * 只保留最近的若干条消息，并从较早的一端裁剪，避免把整段历史塞进 SQLite。
 */
export function buildContextSnapshot(
  messages: readonly unknown[],
  tokens: number | undefined,
  limits: { maxMessages?: number; maxChars?: number } = {},
): ContextSnapshot {
  const maxMessages = limits.maxMessages ?? defaultMaxMessages;
  const maxChars = limits.maxChars ?? defaultMaxChars;
  const extracted = messages.flatMap((message) => extractMessage(message) ?? []);
  const kept: ContextSnapshotMessage[] = [];
  let used = 0;
  let truncated = false;
  for (let index = extracted.length - 1; index >= 0; index -= 1) {
    const message = extracted[index]!;
    if (kept.length >= maxMessages) {
      truncated = true;
      break;
    }
    const remaining = maxChars - used;
    if (message.text.length > remaining) {
      if (remaining <= 1) {
        truncated = true;
        break;
      }
      kept.unshift({ ...message, text: `${message.text.slice(0, remaining - 1)}…` });
      truncated = true;
      break;
    }
    kept.unshift(message);
    used += message.text.length;
  }
  return {
    tokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : null,
    messages: kept,
    truncated,
  };
}

/** 多次摘要失败后使用的确定性摘要：保留最近几条消息的原文，避免压缩反复失败。 */
export function buildFallbackSummary(snapshot: ContextSnapshot): string {
  const messages = snapshot.messages.slice(-6);
  const lines = messages.map((item) => `${item.role}: ${item.text}`);
  const joined = lines.join("\n\n").slice(0, 3_000);
  return [
    "Earlier conversation context (deterministic fallback after summarization failures):",
    joined || "(no text available)",
  ].join("\n\n");
}

export interface ContextTriggerDetail {
  reason?: string;
  tokens?: number;
  reserveTokens?: number;
}

export interface ContextObserveCallbacks {
  /** 压缩刚开始（SDK 尚未开始摘要）时通知界面。 */
  onBeforeCompact?: (snapshot: ContextSnapshot, trigger: ContextTriggerDetail) => void;
  /** 摘要失败时通知界面。 */
  onFailed?: (error?: string) => void;
}

/**
 * 观察扩展：在 SDK 压缩前抓取将被摘要的上下文；摘要失败一次后用确定性摘要兜底，
 * 避免 SDK 因为上下文仍超阈值而无限重试同一种会失败的 LLM 摘要。
 */
export function createContextObserveExtension(
  observation: { before?: ContextSnapshot; failures?: number },
  callbacks: ContextObserveCallbacks = {},
  tokenCounter?: { count(text: string, signal?: AbortSignal): Promise<number | undefined> },
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("session_before_compact", async (event) => {
      const snapshot = buildContextSnapshot(
        event.preparation.messagesToSummarize,
        event.preparation.tokensBefore,
      );
      observation.before = snapshot;
      const settings = event.preparation.settings as { reserveTokens?: number } | undefined;
      const actualTokens = await tokenCounter?.count(messagesToText(event.preparation.messagesToSummarize), event.signal);
      callbacks.onBeforeCompact?.(snapshot, {
        reason: event.reason,
        tokens: actualTokens ?? snapshot.tokens ?? event.preparation.tokensBefore,
        reserveTokens: settings?.reserveTokens,
      });
      observation.failures ??= 0;
      if (observation.failures < 1) return;
      const summary = buildFallbackSummary(snapshot);
      const compaction: CompactionResult = {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        estimatedTokensAfter: Math.ceil(summary.length / 4),
      };
      return { compaction };
    });
    pi.on("session_compact_failed", (event) => {
      observation.failures = (observation.failures ?? 0) + 1;
      callbacks.onFailed?.(event.errorMessage);
    });
    pi.on("session_compact", () => {
      observation.failures = 0;
    });
  };
}
