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

/** 时间轴缩放下限：足够看清长跨度轨迹的整体结构。 */
export const minTraceZoom = 0.5;
/** 时间轴缩放上限：足以分辨相邻事件的边界。 */
export const maxTraceZoom = 32;

/** 把缩放系数限制在时间轴允许的范围内；非有限值回退为 1。 */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(maxTraceZoom, Math.max(minTraceZoom, zoom));
}

/**
 * 滚轮事件的缩放系数。触控板在按住修饰键时会把缩放转为 `ctrlKey`，因此两者都按
 * 缩放处理；未按修饰键的 Shift 滚轮用于平移，返回 1 表示不缩放。
 */
export function wheelZoomFactor(deltaY: number, shiftKey: boolean, ctrlKey: boolean): number {
  if (shiftKey && !ctrlKey) return 1;
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  return Math.exp(-deltaY * 0.0015);
}

/**
 * 缩放时保持光标下方的时间点不动：以锚点位置占可视宽度的比例，重新计算滚动偏移。
 * `anchorX` 为光标相对可视区域左边缘的像素位置。
 */
export function anchoredScrollLeft(
  scrollLeft: number,
  viewportWidth: number,
  anchorX: number,
  ratio: number,
): number {
  if (viewportWidth <= 0 || !Number.isFinite(anchorX)) return scrollLeft;
  return Math.max(0, (scrollLeft + anchorX) * ratio - anchorX);
}

/**
 * 时间轴刻度数量：跟随缩放增加，让放大后仍能读出每一段的时间；最小 5 条、最大 33 条。
 */
export function timelineTickCount(zoom: number): number {
  const safe = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.max(5, Math.min(33, Math.round(safe * 8) + 1));
}

/** 时间轴上的一段：同一轮内的轨迹条目与其时间标尺。 */
export interface TimelineSegment<T> {
  /** 轮次 ID；事件轨迹等单段场景为空字符串。 */
  key: string;
  entries: T[];
  /** 段内每条条目的横向位置比例。 */
  positions: TimelinePosition<T>[];
  /** 该段在时间轴上的像素宽度。 */
  width: number;
  /** 该段的时间跨度（毫秒），用于生成刻度标签。 */
  duration: number;
  /** 该段起点在整条时间轴上的像素偏移。 */
  offset: number;
}

/** 段内一条条目的横向位置：相对段起点的比例与宽度比例。 */
export interface TimelinePosition<T> {
  entry: T;
  startRatio: number;
  widthRatio: number;
}

export interface TimelineLayout<T> {
  segments: TimelineSegment<T>[];
  /** 整条时间轴的像素宽度。 */
  width: number;
}

/** 时间轴布局参数：像素预算与相邻轮次之间的分隔宽度。 */
export interface TimelineOptions {
  /** 单段的最小像素宽度。 */
  minWidth?: number;
  /** 单段的最大像素宽度。 */
  maxWidth?: number;
  /** 每段按条目数追加的像素宽度。 */
  perEntry?: number;
  /** 相邻段之间的固定像素间隔；只用于视觉分隔，不表示真实耗时。 */
  segmentGap?: number;
}

/**
 * 把轨迹条目布局到一条可横向缩放的时间轴上，并按轮次分段。
 *
 * 每一轮各自生成标尺，段内空白按真实时间比例对齐；相邻轮次之间只留固定的像素间隔，
 * 真实耗时由每段自己的标尺表达，否则一段长间隔（用户思考、离开页面）会撑出巨量空白。
 * `turnOf` 返回条目的轮次 ID；为空表示不分组（事件轨迹等单段场景）。
 */
export function buildTimelineLayout<T extends { id: number; startedAt: string; finishedAt: string | null }>(
  entries: readonly T[],
  turnOf: (entry: T) => string | null,
  options: TimelineOptions = {},
): TimelineLayout<T> {
  const minWidth = options.minWidth ?? 320;
  const maxWidth = options.maxWidth ?? 1400;
  const perEntry = options.perEntry ?? 22;
  const segmentGap = Math.max(0, options.segmentGap ?? 24);

  // 保持输入顺序分组：调用方已按时间排序，同一轮的条目必然相邻。
  const groups: { key: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const key = turnOf(entry) ?? "";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, entries: [entry] });
  }

  const measured = groups.map((group) => {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const entry of group.entries) {
      const entryStart = Date.parse(entry.startedAt);
      const entryEnd = Date.parse(entry.finishedAt ?? entry.startedAt);
      if (Number.isFinite(entryStart)) start = Math.min(start, entryStart);
      if (Number.isFinite(entryEnd)) end = Math.max(end, entryEnd);
    }
    const span = Number.isFinite(start) ? Math.max(1, end - start) : 1;
    return {
      key: group.key,
      entries: group.entries,
      duration: Number.isFinite(start) ? Math.max(0, end - start) : 0,
      width: Math.max(minWidth, Math.min(maxWidth, group.entries.length * perEntry)),
      positions: group.entries.map((entry): TimelinePosition<T> => {
        const entryStart = Date.parse(entry.startedAt);
        const entryEnd = Date.parse(entry.finishedAt ?? entry.startedAt);
        const from = Number.isFinite(entryStart) ? Math.min(1, Math.max(0, (entryStart - start) / span)) : 0;
        const to = Number.isFinite(entryEnd) ? Math.min(1, Math.max(from, (entryEnd - start) / span)) : from;
        return { entry, startRatio: from, widthRatio: to - from };
      }),
    };
  });

  const segments: TimelineSegment<T>[] = [];
  let offset = 0;
  measured.forEach((group, index) => {
    if (index > 0) offset += segmentGap;
    segments.push({
      key: group.key,
      entries: group.entries,
      positions: group.positions,
      width: group.width,
      duration: group.duration,
      offset,
    });
    offset += group.width;
  });

  return { segments, width: offset };
}

/** 轨迹条目所属轮次；事件轨迹等无轮次归属时返回 null。 */
export function traceTurnId(entry: { turnId?: string | null }): string | null {
  return entry.turnId ?? null;
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
