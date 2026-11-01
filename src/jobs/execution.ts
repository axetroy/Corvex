import type { JobStore } from "./store.js";
import type { ExecutionEventStatus } from "./model.js";

/**
 * 用于把 webhook 投递或 Worker 尝试关联到执行事件；至少提供一个关联 ID。
 * webhook 可在任务创建前记录，后续通过 eventId 关联到任务。
 */
export interface ExecutionEventContext {
  deliveryId?: string | null;
  eventId?: string | null;
  jobId?: string | null;
  attempt?: number | null;
}

/**
 * 持久化一次操作的输入、结果或失败状态，再返回结果或重新抛出原错误。
 * input/output 会由 JobStore 脱敏并限制大小；failureStatus 默认为 `failed`，
 * 可用于表达远端副作用结果不确定等终态。
 */
export async function traceExecutionStep<T>(
  store: JobStore,
  context: ExecutionEventContext,
  step: string,
  input: unknown,
  operation: () => T | Promise<T>,
  output: (value: T) => unknown = (value) => value,
  failureStatus: (error: unknown) => Exclude<ExecutionEventStatus, "running"> = () => "failed",
): Promise<T> {
  const eventId = store.startExecutionEvent({ ...context, step, input });
  const startedAt = performance.now();
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    store.finishExecutionEvent(
      eventId,
      failureStatus(error),
      performance.now() - startedAt,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
  store.finishExecutionEvent(eventId, "succeeded", performance.now() - startedAt, output(result));
  return result;
}