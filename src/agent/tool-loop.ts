/**
 * 工具循环检测：长任务里模型可能对同一工具用相同参数反复调用，或对同一操作连续失败。
 * 这里在工具执行后记录有界的调用签名，达到阈值时返回一条提示，让模型在下一轮换策略。
 *
 * 只做检测与提示，不阻止工具执行——SDK 的事件是观察式的，权限与边界仍在应用代码里。
 */

/** 连续相同签名达到该次数时提示。 */
export const consecutiveLoopThreshold = 4;
/** 同一签名在一段会话内累计达到该次数时提示（即使中间夹了别的工具）。 */
export const repeatedLoopThreshold = 8;
/** 同一工具连续失败达到该次数时提示。 */
export const failureLoopThreshold = 3;

export interface ToolLoopState {
  /** 签名 → 累计次数。 */
  counts: Map<string, number>;
  /** 上一个签名与连续次数。 */
  lastSignature: string | undefined;
  consecutive: number;
  /** 连续失败的工具名与次数。 */
  lastFailureTool: string | undefined;
  consecutiveFailures: number;
  /** 已提示过的签名，避免刷屏。 */
  notified: Set<string>;
}

export function createToolLoopState(): ToolLoopState {
  return {
    counts: new Map(),
    lastSignature: undefined,
    consecutive: 0,
    lastFailureTool: undefined,
    consecutiveFailures: 0,
    notified: new Set(),
  };
}

/** 稳定序列化：键排序 + 有界截断，让同一组参数得到同一签名。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function toolSignature(name: string, args: unknown): string {
  const stable = stableStringify(args ?? {});
  const flat = stable.replace(/\s+/g, " ").slice(0, 400);
  return flat === "{}" ? name : `${name}:${flat}`;
}

export interface ToolLoopNotice {
  reason: "consecutive" | "repeated" | "failures";
  signature: string;
  count: number;
}

/** 记录一次工具执行，返回需要提示的循环（同一签名只提示一次）。 */
export function recordToolCall(
  state: ToolLoopState,
  name: string,
  args: unknown,
  isError: boolean,
): ToolLoopNotice | undefined {
  const signature = toolSignature(name, args);
  if (signature === state.lastSignature) state.consecutive += 1;
  else {
    state.lastSignature = signature;
    state.consecutive = 1;
  }
  const count = (state.counts.get(signature) ?? 0) + 1;
  state.counts.set(signature, count);

  // 连续失败按工具名统计，不要求参数完全相同。
  if (isError) {
    if (name === state.lastFailureTool) state.consecutiveFailures += 1;
    else {
      state.lastFailureTool = name;
      state.consecutiveFailures = 1;
    }
  } else {
    state.lastFailureTool = undefined;
    state.consecutiveFailures = 0;
  }

  if (state.notified.has(signature)) return undefined;
  if (state.consecutive >= consecutiveLoopThreshold) {
    state.notified.add(signature);
    return { reason: "consecutive", signature, count: state.consecutive };
  }
  if (count >= repeatedLoopThreshold) {
    state.notified.add(signature);
    return { reason: "repeated", signature, count };
  }
  if (isError && state.consecutiveFailures >= failureLoopThreshold) {
    const failureSignature = `failure:${name}`;
    state.notified.add(failureSignature);
    return { reason: "failures", signature: failureSignature, count: state.consecutiveFailures };
  }
  return undefined;
}
