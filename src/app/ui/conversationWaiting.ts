/**
 * 一轮对话中「等待模型首个输出」的状态机。
 *
 * 每次模型请求开始（文本/思考的 reset 事件）或工具执行结束都会重新进入等待；
 * 一旦有实际内容、工具开始执行或轮次结束就退出等待。纯函数便于测试与复用。
 */
export type WaitingEvent =
  | { type: "start" }
  | { type: "content" }
  | { type: "toolRunning" }
  | { type: "toolSettled" }
  | { type: "done" };

export function resolveWaitingSince(current: number | null, event: WaitingEvent, now: number): number | null {
  switch (event.type) {
    case "start":
    case "toolSettled":
      return now;
    case "content":
    case "toolRunning":
    case "done":
      return null;
    default:
      return current;
  }
}

/** 等待超过该时长后改用安抚文案，明确告知仍在等待且给出可停止的出口。 */
export const WAIT_REASSURE_AFTER_MS = 15_000;
/** 更长的等待再升一级，强调可以停止或继续等待，避免无休止的静默。 */
export const WAIT_LONG_AFTER_MS = 60_000;

export type WaitingStage = "normal" | "slow" | "long";

export function resolveWaitingStage(elapsedMs: number): WaitingStage {
  if (elapsedMs >= WAIT_LONG_AFTER_MS) return "long";
  if (elapsedMs >= WAIT_REASSURE_AFTER_MS) return "slow";
  return "normal";
}
