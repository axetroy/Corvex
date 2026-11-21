import type { EventStore } from "./store.js";
import type { ExecutionStepStatus, TraceScope } from "./model.js";
import { errorMessage } from "../errors.js";

/**
 * 用于把 webhook 投递或事件执行尝试关联到执行事件；至少提供一个关联 ID。
 * webhook 可在事件创建前记录，后续通过 webhookEventId 关联到事件。
 */
export interface ExecutionStepContext {
  deliveryId?: string | null;
  webhookEventId?: string | null;
  eventId?: string | null;
  turnId?: string | null;
  attempt?: number | null;
}

/** 把轨迹归属转换成执行步骤上下文，使事件与对话共用同一套步骤记录。 */
export function stepContextFor(scope: TraceScope, attempt: number): ExecutionStepContext {
  return scope.kind === "event" ? { eventId: scope.eventId, attempt } : { turnId: scope.turnId, attempt };
}

/**
 * 持久化一次操作的输入、结果或失败状态，再返回结果或重新抛出原错误。
 * input/output 会由 EventStore 脱敏并限制大小；failureStatus 默认为 `failed`，
 * 可用于表达远端副作用结果不确定等终态。
 */
export async function traceExecutionStep<T>(
  store: EventStore,
  context: ExecutionStepContext,
  step: string,
  input: unknown,
  operation: () => T | Promise<T>,
  output: (value: T) => unknown = (value) => value,
  failureStatus: (error: unknown) => Exclude<ExecutionStepStatus, "running"> = () => "failed",
): Promise<T> {
  const webhookEventId = store.startExecutionStep({ ...context, step, input });
  const startedAt = performance.now();
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    store.finishExecutionStep(
      webhookEventId,
      failureStatus(error),
      performance.now() - startedAt,
      undefined,
      errorMessage(error),
    );
    throw error;
  }
  store.finishExecutionStep(webhookEventId, "succeeded", performance.now() - startedAt, output(result));
  return result;
}