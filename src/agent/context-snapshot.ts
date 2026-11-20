import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

/** 观察扩展：在 SDK 压缩前抓取将被摘要的上下文，交给调用方写入轨迹。 */
export function createContextObserveExtension(observation: { before?: ContextSnapshot }): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("session_before_compact", (event) => {
      observation.before = buildContextSnapshot(
        event.preparation.messagesToSummarize,
        event.preparation.tokensBefore,
      );
    });
  };
}
