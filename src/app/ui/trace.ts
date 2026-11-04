/** 参与输出速度计算的轨迹条目；缺少有效 Token 或耗时的条目会被跳过。 */
export interface TraceTokenSample {
  status: "running" | "succeeded" | "failed";
  outputTokens: number | null;
  firstTokenMs: number | null;
  generationDurationMs: number | null;
}

/** 重建模型输入所需的轨迹条目子集，缺省字段按未记录处理。 */
export interface TraceInputEntry {
  id: number;
  kind?: string;
  input?: string | null;
  rawContent?: string | null;
}

/** 轨迹字段保存的是 JSON 文本；解析失败时返回 undefined 而不是抛错。 */
export function parseTraceValue(value: string | null | undefined): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** 把未知值收窄为普通对象，供轨迹负载做字段读取。 */
export function asTraceRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** 仅按成功调用的生成阶段耗时加权计算 TPS；没有有效样本时返回 null。 */
export function calculateGenerationTokensPerSecond(entries: readonly TraceTokenSample[]): number | null {
  let outputTokens = 0;
  let generationDurationMs = 0;
  for (const entry of entries) {
    const tokens = entry.outputTokens;
    const duration = entry.generationDurationMs;
    if (entry.status !== "succeeded") continue;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) continue;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) continue;
    outputTokens += tokens;
    generationDurationMs += duration;
  }
  return generationDurationMs > 0 ? outputTokens * 1000 / generationDurationMs : null;
}

/** 仅计算成功调用的平均首 token 延迟；旧轨迹或无增量样本不参与。 */
export function calculateAverageFirstTokenMs(entries: readonly TraceTokenSample[]): number | null {
  let totalMs = 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.status !== "succeeded") continue;
    const firstTokenMs = entry.firstTokenMs;
    if (typeof firstTokenMs !== "number" || !Number.isFinite(firstTokenMs) || firstTokenMs < 0) continue;
    totalMs += firstTokenMs;
    count++;
  }
  return count > 0 ? totalMs / count : null;
}

/**
 * 用增量上下文条目重建所选模型回复的完整输入：从最近的完整快照或上下文重置处
 * 开始累积消息，遇到 `contextReset` 时清空历史。非增量输入原样返回。
 */
export function reconstructLlmInput(traces: readonly TraceInputEntry[], selectedEntry: TraceInputEntry): string {
  const selectedIndex = traces.findIndex((entry) => entry.id === selectedEntry.id);
  const selectedInput = asTraceRecord(parseTraceValue(selectedEntry.input));
  if (selectedIndex < 0 || selectedInput?.contextMode !== "delta") {
    return selectedEntry.input ?? selectedEntry.rawContent ?? "";
  }

  let systemPrompt = "";
  let messages: unknown[] = [];
  for (const entry of traces.slice(0, selectedIndex + 1)) {
    if (entry.kind !== "llm") continue;
    const input = asTraceRecord(parseTraceValue(entry.input));
    if (!input) continue;
    if (input.contextMode !== "delta") {
      if (Array.isArray(input.messages)) messages = input.messages;
      if (typeof input.systemPrompt === "string") systemPrompt = input.systemPrompt;
      continue;
    }
    if (input.contextReset) messages = [];
    if (typeof input.systemPrompt === "string") systemPrompt = input.systemPrompt;
    if (Array.isArray(input.messages)) messages.push(...input.messages);
  }
  return JSON.stringify({ systemPrompt, messages }, null, 2);
}
