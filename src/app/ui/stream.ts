import { isConversationTurnStatus } from "../../events/model.js";
import type { ConversationTurnStatus } from "../../events/model.js";
import type { ConversationStreamEvent } from "./types.js";

/**
 * 解析一段 SSE 缓冲，返回已完整的事件与尚未收到空行的剩余文本。
 *
 * 只关心 `data:` 行：心跳等注释帧直接丢弃；单帧 JSON 损坏时跳过而不抛错，
 * 否则一条坏数据就会让整段对话流中断、界面退回轮询。
 */
export function parseSseFrames(buffer: string): {
  events: ConversationStreamEvent[];
  rest: string;
} {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const events: ConversationStreamEvent[] = [];
  let rest = normalized;
  while (true) {
    const separator = rest.indexOf("\n\n");
    if (separator < 0) break;
    const frame = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type === "text" && typeof event.text === "string" && typeof event.reset === "boolean") {
      events.push({ type: "text", reset: event.reset, text: event.text });
    } else if (event.type === "done" && typeof event.status === "string" && isConversationTurnStatus(event.status)) {
      events.push({
        type: "done",
        status: event.status,
        ...(typeof event.error === "string" ? { error: event.error } : {}),
      });
    }
  }
  return { events, rest };
}

export interface ConversationStreamHandlers {
  /** 当前轮已累计的正文；`reset` 为真时表示模型开始了新一轮输出。 */
  onText: (text: string, reset: boolean) => void;
  /** 轮次结束；服务端保证只发送一次。 */
  onDone: (status: ConversationTurnStatus, error?: string) => void;
}

/**
 * 订阅一轮对话的流式正文，直到收到 done 或连接中断。
 *
 * 与 `EventSource` 不同这里用 `fetch` 读取响应体：控制台的 Basic 鉴权由浏览器在
 * 同源请求上自动带上，而 `EventSource` 无法自定义该请求。调用方负责传入
 * `AbortSignal`，离开页面或切换轮次时中止读取。
 */
export async function streamConversationTurn(
  conversationId: string,
  turnId: string,
  handlers: ConversationStreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/stream`,
    {
      headers: { accept: "text/event-stream" },
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`conversation stream returned HTTP ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSseFrames(buffer + value);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.type === "text") {
          handlers.onText(event.text, event.reset);
        } else {
          handlers.onDone(event.status, event.error);
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
