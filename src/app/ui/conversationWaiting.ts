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
