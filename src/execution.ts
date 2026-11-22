import type { AppStore } from "./store.js";
import type { ExecutionStepStatus, TraceScope } from "./model.js";
import { errorMessage } from "./errors.js";

/** 用于把执行步骤关联到对话轮次。 */
export interface ExecutionStepContext {
  turnId: string;
  attempt: number;
}

/** 把轨迹归属转换成执行步骤上下文。 */
export function stepContextFor(scope: TraceScope, attempt: number): ExecutionStepContext {
  return { turnId: scope.turnId, attempt };
}

/**
 * 持久化一次操作的输入、结果或失败状态，再返回结果或重新抛出原错误。
 * input/output 会由 AppStore 脱敏并限制大小；failureStatus 默认为 `failed`，
 * 可用于表达远端副作用结果不确定等终态。
 */
export async function traceExecutionStep<T>(
  store: AppStore,
  context: ExecutionStepContext,
  step: string,
  input: unknown,
  operation: () => T | Promise<T>,
  output: (value: T) => unknown = (value) => value,
  failureStatus: (error: unknown) => Exclude<ExecutionStepStatus, "running"> = () => "failed",
): Promise<T> {
  const stepId = store.startExecutionStep({ ...context, step, input });
  const startedAt = performance.now();
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    store.finishExecutionStep(
      stepId,
      failureStatus(error),
      performance.now() - startedAt,
      undefined,
      errorMessage(error),
    );
    throw error;
  }
  store.finishExecutionStep(stepId, "succeeded", performance.now() - startedAt, output(result));
  return result;
}
