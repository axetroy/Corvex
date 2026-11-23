import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { formatDate, formatOutputTps, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import { displayModelName } from "../modelLabel.js";
import type { Copy, CopyTextKey, Locale } from "../i18n.js";
import {
  anchoredScrollLeft,
  buildTimelineLayout,
  calculateAverageFirstTokenMs,
  calculateGenerationTokensPerSecond,
  clampZoom,
  parseTraceValue,
  reconstructLlmInput,
  timelineTickCount,
  timelineTicksForWidth,
  traceTurnId,
  wheelZoomFactor,
} from "../trace.js";
import type { ConversationTurnSegment, TraceEntry } from "../types.js";
import { DetailItem, TraceField } from "./common.js";

type InspectorTab = "overview" | "parameters" | "result" | "schema" | "timing" | "context";

/** 详情面板的标签页顺序。 */
const inspectorTabs: readonly (readonly [InspectorTab, CopyTextKey])[] = [
  ["overview", "traceTabOverview"],
  ["parameters", "traceTabParameters"],
  ["result", "traceTabResult"],
  ["schema", "traceTabSchema"],
  ["timing", "traceTabTiming"],
  ["context", "traceTabContext"],
];

/** 时间轴左侧活动名称列的宽度，与样式表保持一致。 */
const labelWidth = 72;

/** 事件详情面板：按选中条目与当前标签页展示字段、输入输出与计时。 */
function InspectorContent({
  tab,
  selected,
  traces,
  copy,
  locale,
}: {
  tab: InspectorTab;
  selected: readonly TraceEntry[];
  traces: readonly TraceEntry[];
  copy: Copy;
  locale: Locale;
}) {
  if (selected.length === 0) return <div className="trace-inspector-empty">{copy.traceNoSelection}</div>;
  if (selected.length > 1) {
    return (
      <dl className="trace-inspector-grid">
        <DetailItem
          label={copy.traceSelectedCountTemplate.replace("{count}", String(selected.length))}
          value={selected.length}
        />
        <DetailItem
          label={copy.traceDuration}
          value={formatTraceDuration(selected.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0), copy)}
        />
        <DetailItem
          label={copy.traceStatus}
          value={`${selected.filter((entry) => entry.status === "succeeded").length} / ${selected.length}`}
        />
        <DetailItem
          label={copy.traceFirstToken}
          value={formatTraceDuration(calculateAverageFirstTokenMs(selected), copy)}
        />
        <DetailItem
          label={copy.traceGenerationDuration}
          value={formatTraceDuration(
            selected.reduce((sum, entry) => sum + (entry.generationDurationMs ?? 0), 0) || null,
            copy,
          )}
        />
        <DetailItem label={copy.traceTps} value={formatOutputTps(calculateGenerationTokensPerSecond(selected), copy)} />
      </dl>
    );
  }

  const entry = selected[0]!;
  if (tab === "overview") {
    return (
      <dl className="trace-inspector-grid">
        <DetailItem
          label={copy.traceKinds[entry.kind]}
          value={entry.kind === "llm" ? displayModelName(entry.model) || entry.name : entry.name}
        />
        <DetailItem label={copy.traceStatus} value={translate(copy.traceStatuses, entry.status)} />
        <DetailItem label={copy.traceAttempt} value={entry.attempt} />
        <DetailItem
          label={copy.traceRoundTemplate.replace("{round}", entry.round === null ? copy.traceRoundUnknown : String(entry.round))}
          value={entry.round ?? copy.traceRoundUnknown}
        />
        <DetailItem label={copy.traceDuration} value={formatTraceDuration(entry.durationMs, copy)} />
        {entry.kind === "llm" ? (
          <>
            <DetailItem label={copy.inputTokens} value={entry.inputTokens ?? copy.none} />
            <DetailItem label={copy.outputTokens} value={entry.outputTokens ?? copy.none} />
            <DetailItem label={copy.traceFirstToken} value={formatTraceDuration(entry.firstTokenMs, copy)} />
            <DetailItem
              label={copy.traceGenerationDuration}
              value={formatTraceDuration(entry.generationDurationMs, copy)}
            />
            <DetailItem
              label={copy.traceTps}
              value={formatOutputTps(calculateGenerationTokensPerSecond([entry]), copy)}
            />
          </>
        ) : null}
      </dl>
    );
  }
  if (tab === "context") {
    if (entry.kind !== "context") return <div className="trace-inspector-empty">{copy.traceNoSelection}</div>;
    const formatSnapshot = (value: string | null): string => {
      const parsed = parseTraceValue(value ?? "");
      return parsed === undefined || parsed === null
        ? copy.traceContextEmpty
        : JSON.stringify(parsed, null, 2);
    };
    return (
      <>
        <TraceField label={copy.traceContextBefore} value={formatSnapshot(entry.input)} emptyLabel={copy.traceContextEmpty} defaultOpen />
        <TraceField label={copy.traceContextAfter} value={formatSnapshot(entry.output)} emptyLabel={copy.traceContextEmpty} defaultOpen />
      </>
    );
  }
  if (tab === "parameters") {
    return (
      <TraceField
        label={entry.kind === "llm" ? copy.traceInput : copy.traceArguments}
        value={entry.kind === "llm" ? reconstructLlmInput(traces, entry) : entry.input ?? entry.rawContent}
        emptyLabel={copy.traceNoInput}
        defaultOpen
      />
    );
  }
  if (tab === "result") {
    return (
      <>
        <TraceField label={copy.traceResult} value={entry.output} emptyLabel={copy.traceNoOutput} defaultOpen />
        {entry.errorDetail ? (
          <TraceField label={copy.error} value={entry.errorDetail} emptyLabel={copy.traceNoOutput} defaultOpen />
        ) : null}
      </>
    );
  }
  if (tab === "schema") {
    return <TraceField label={copy.traceSchema} value={entry.schema} emptyLabel={copy.noRawContent} defaultOpen />;
  }
  return (
    <dl className="trace-inspector-grid">
      <DetailItem label={copy.started} value={formatDate(entry.startedAt, copy, locale)} />
      <DetailItem label={copy.finished} value={formatDate(entry.finishedAt, copy, locale)} />
      <DetailItem label={copy.traceDuration} value={formatTraceDuration(entry.durationMs, copy)} />
      {entry.kind === "llm" ? (
        <>
          <DetailItem
            label={copy.traceRequestStarted}
            value={formatDate(entry.requestStartedAt, copy, locale)}
          />
          <DetailItem
            label={copy.traceResponseHeaders}
            value={formatTraceDuration(entry.responseHeadersMs, copy)}
          />
          <DetailItem label={copy.traceFirstToken} value={formatTraceDuration(entry.firstTokenMs, copy)} />
          <DetailItem
            label={copy.traceGenerationDuration}
            value={formatTraceDuration(entry.generationDurationMs, copy)}
          />
        </>
      ) : null}
    </dl>
  );
}

/** 时间轴上的一个轮次分段：段内位置、标尺与分隔标签。 */
interface TurnBand {
  /** 轮次 ID；未分组的单段场景为空字符串。 */
  key: string;
  /** 轮次序号，用于「第 N 轮」标签；未分组时为 null。 */
  ordinal: number | null;
  /** 该轮的用户提问，作为分隔标签的提示。 */
  request: string | null;
  /** 缩放后的像素位置与宽度。 */
  offset: number;
  width: number;
  /** 该段的时间跨度（毫秒），用于生成段内刻度。 */
  duration: number;
}

interface DiagramProps {
  traces: readonly TraceEntry[];
  /** 按轮分组的元数据；为空表示单段（事件轨迹），时间轴不分段。 */
  turns?: readonly ConversationTurnSegment[];
  copy: Copy;
  locale: Locale;
  selection: ReadonlySet<number>;
  onSelectionChange: (selected: ReadonlySet<number>) => void;
}

/** 轨迹视图：时间轴概览、活动列表与事件详情面板。 */
export const TraceDiagram = memo(function TraceDiagram({ traces, turns, copy, locale, selection, onSelectionChange }: DiagramProps) {
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ start: number; current: number }>();
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const plot = useRef<HTMLDivElement | null>(null);
  const scroll = useRef<HTMLDivElement | null>(null);
  // 滚轮事件必须在非 passive 监听器里 preventDefault，否则页面会跟着滚动。
  const wheelRef = useRef<(event: WheelEvent) => void>(() => {});

  // 时间轴几何只依赖轨迹内容：用 reduce 而非展开参数，避免超长轨迹触发参数上限。
  const { duration, layout } = useMemo(() => {
    const starts = traces.map((entry) => Date.parse(entry.startedAt));
    const ends = traces.map((entry) => Date.parse(entry.finishedAt ?? entry.startedAt));
    const startTime = starts.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
    const endTime = ends.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
    // 分组后每轮各占一段、可窄一些；事件详情等单段场景保持较宽的默认时间轴。
    const grouped = traces.some((entry) => traceTurnId(entry) !== null);
    return {
      duration: Math.max(1, endTime - startTime),
      layout: buildTimelineLayout(traces, traceTurnId, grouped ? undefined : { minWidth: 760 }),
    };
  }, [traces]);
  const plotWidth = Math.round(layout.width * zoom);
  // 分段与条目共用同一缩放比例，标尺与色条才能对齐。
  const bands = useMemo<TurnBand[]>(
    () => layout.segments.map((segment, index) => ({
      key: segment.key,
      ordinal: segment.key ? index + 1 : null,
      request: turns?.find((turn) => turn.turnId === segment.key)?.request ?? null,
      offset: segment.offset * zoom,
      width: segment.width * zoom,
      duration: segment.duration,
    })),
    [layout, turns, zoom],
  );
  const grouped = bands.some((band) => band.ordinal !== null);

  // 保持光标下方的时间点不动：缩放前后用同一比例换算滚动位置。
  const zoomAt = (nextZoom: number, viewport: HTMLDivElement, clientX?: number): void => {
    const bounded = clampZoom(nextZoom);
    const current = scroll.current;
    if (!current) {
      setZoom(bounded);
      return;
    }
    const ratio = bounded / zoom;
    const anchorX = clientX === undefined
      ? viewport.clientWidth / 2
      : clientX - viewport.getBoundingClientRect().left;
    const target = anchoredScrollLeft(current.scrollLeft, viewport.clientWidth, anchorX, ratio);
    setZoom(bounded);
    // 布局完成后按新宽度校正滚动位置，避免落在中间态宽度上。
    requestAnimationFrame(() => {
      current.scrollLeft = target;
    });
  };

  const applyWheel = (event: WheelEvent): void => {
    const viewport = scroll.current;
    if (!viewport) return;
    // Shift 滚轮（未按 Ctrl）横向平移，触控板捏合与 Ctrl 滚轮缩放。
    if (event.shiftKey && !event.ctrlKey) {
      if (event.deltaY === 0) return;
      event.preventDefault();
      viewport.scrollLeft += event.deltaY;
      return;
    }
    const factor = wheelZoomFactor(event.deltaY, event.shiftKey, event.ctrlKey);
    if (factor === 1) return;
    event.preventDefault();
    zoomAt(zoom * factor, viewport, event.clientX);
  };
  wheelRef.current = applyWheel;

  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const handler = (event: WheelEvent) => wheelRef.current(event);
    viewport.addEventListener("wheel", handler, { passive: false });
    return () => viewport.removeEventListener("wheel", handler);
  }, []);

  // 缩放后若光标锚点落在两端，滚动位置会被夹紧；这里做一次收敛，避免越界空滚。
  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    const maxScroll = viewport.scrollWidth - viewport.clientWidth;
    if (maxScroll <= 0) return;
    viewport.scrollLeft = Math.min(viewport.scrollLeft, maxScroll);
  }, [zoom]);

  const ticks = timelineTickCount(zoom);

  const plotLocalX = (event: ReactPointerEvent<HTMLDivElement>): number => {
    const node = plot.current;
    return node ? event.clientX - node.getBoundingClientRect().left : 0;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const point = plotLocalX(event);
    setDrag({ start: point, current: point });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ ...drag, current: plotLocalX(event) });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const endX = Math.max(0, Math.min(plotWidth, plotLocalX(event)));
    const selected = new Set<number>();
    // 拖动距离过小视为点击空白处，清空选择。
    if (Math.abs(endX - drag.start) > 5) {
      const fromX = Math.min(drag.start, endX);
      const toX = Math.max(drag.start, endX);
      // 按像素判定：轮次分段各自压缩过空档，比例坐标无法跨段比较。
      for (const band of bands) {
        for (const { entry, startRatio, widthRatio } of layout.segments.find((segment) => segment.key === band.key)?.positions ?? []) {
          const left = band.offset + startRatio * band.width;
          const right = left + Math.max(4, widthRatio * band.width);
          if (right >= fromX && left <= toX) selected.add(entry.id);
        }
      }
    }
    setDrag(undefined);
    onSelectionChange(selected);
  };

  // 详情标签页遵循 roving tabindex：方向键切换并移动焦点，只有当前页可被 Tab 命中。
  const handleInspectorKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = inspectorTabs.findIndex(([tab]) => tab === activeTab);
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % inspectorTabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + inspectorTabs.length) % inspectorTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = inspectorTabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const next = inspectorTabs[nextIndex]![0];
    setActiveTab(next);
    document.getElementById(`trace-inspector-tab-${next}`)?.focus();
  };

  const selected = traces.filter((entry) => selection.has(entry.id));

  return (
    <div
      className="trace-diagram-view"
      id="trace-diagram-panel"
      role="tabpanel"
      aria-labelledby="trace-diagram-tab"
    >
      <section className="trace-overview">
        <div className="trace-overview-header">
          <strong className="trace-overview-title">{copy.traceOverview}</strong>
          <span className="trace-overview-summary">
            {copy.traceOverviewSummaryTemplate
              .replace("{events}", String(traces.length))
              .replace("{duration}", formatTraceDuration(duration, copy))}
          </span>
          <div className="trace-overview-controls">
            <button
              type="button"
              className="trace-zoom-button"
              aria-label={copy.traceZoomOut}
              title={copy.traceZoomOut}
              onClick={() => {
                const viewport = scroll.current;
                if (viewport) zoomAt(zoom / 1.25, viewport);
              }}
            >
              −
            </button>
            <span className="trace-zoom-value">{`${Math.round(zoom * 100)}%`}</span>
            <button
              type="button"
              className="trace-zoom-button"
              aria-label={copy.traceZoomIn}
              title={copy.traceZoomIn}
              onClick={() => {
                const viewport = scroll.current;
                if (viewport) zoomAt(zoom * 1.25, viewport);
              }}
            >
              +
            </button>
            <button type="button" className="trace-zoom-reset" onClick={() => setZoom(1)}>
              {copy.traceZoomReset}
            </button>
          </div>
        </div>
        <div className="trace-overview-hint">{copy.traceZoomHint}</div>
        <div className="trace-overview-scroll" ref={scroll}>
          <div
            className="trace-overview-scene"
            role="group"
            aria-label={copy.traceDiagram}
            style={{ width: `${labelWidth + plotWidth}px` }}
          >
            <div className="trace-overview-axis-row">
              <span className="trace-overview-label-spacer" />
              <div className="trace-overview-axis" style={{ width: `${plotWidth}px` }}>
                {bands.map((band) => {
                  const bandTicks = timelineTicksForWidth(band.width, ticks);
                  return (
                    <div
                      key={band.key || "single"}
                      className={`trace-overview-band-axis${band.ordinal === null ? " is-ungrouped" : ""}`}
                      style={{ left: `${band.offset}px`, width: `${band.width}px` }}
                    >
                      {band.ordinal !== null ? (
                        <span className="trace-overview-band-label" title={band.request ?? undefined}>
                          {copy.traceTurnLabelTemplate.replace("{turn}", String(band.ordinal))}
                        </span>
                      ) : null}
                      {Array.from({ length: bandTicks }, (_, index) => (
                        <span
                          key={index}
                          className="trace-overview-tick"
                          aria-hidden="true"
                          style={{ left: `${(index / (bandTicks - 1)) * 100}%` }}
                        >
                          {formatTraceDuration(Math.round(band.duration * (index / (bandTicks - 1))), copy)}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
            {(["llm", "tool", "context"] as const).map((kind) => (
              <div className={`trace-overview-track trace-overview-track-${kind}`} key={kind}>
                <span className="trace-overview-track-label">{copy.traceKinds[kind]}</span>
                <div
                  className={`trace-overview-plot trace-overview-plot-${kind}`}
                  style={{ width: `${plotWidth}px` }}
                  ref={(node) => {
                    plot.current = node;
                  }}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={() => setDrag(undefined)}
                >
                  {/* 轮次分隔线：每轮各占一段，段间空档被压缩后仍能一眼看出轮次边界。 */}
                  {grouped
                    ? bands.map((band) => (
                      <span
                        key={band.key}
                        className="trace-overview-band"
                        aria-hidden="true"
                        style={{ left: `${band.offset}px`, width: `${band.width}px` }}
                      />
                    ))
                    : null}
                  {bands.flatMap((band) => {
                    const segment = layout.segments.find((candidate) => candidate.key === band.key);
                    return (segment?.positions ?? [])
                      .filter((position) => position.entry.kind === kind)
                      .map(({ entry, startRatio, widthRatio }) => {
                        const title = entry.kind === "llm" ? displayModelName(entry.model) || entry.name : entry.name;
                        return (
                          <button
                            key={entry.id}
                            type="button"
                            className={`trace-time-bar trace-time-bar-${entry.kind} trace-time-bar-${entry.status}${selection.has(entry.id) ? " is-selected" : ""}`}
                            title={`${title} · ${formatTraceDuration(entry.durationMs, copy)}`}
                            aria-label={`${copy.traceKinds[entry.kind]}: ${title}, ${formatTraceDuration(entry.durationMs, copy)}`}
                            style={{
                              left: `${band.offset + startRatio * band.width}px`,
                              width: `${Math.max(4, widthRatio * band.width)}px`,
                            }}
                            onClick={() => onSelectionChange(new Set([entry.id]))}
                          />
                        );
                      });
                  })}
                </div>
              </div>
            ))}
            {drag ? (
              <div
                className="trace-overview-selection"
                style={{
                  left: `${labelWidth + Math.min(drag.start, drag.current)}px`,
                  width: `${Math.abs(drag.current - drag.start)}px`,
                }}
              />
            ) : null}
          </div>
        </div>
      </section>
      <div className="trace-selection-toolbar">
        <span className="trace-selection-status">
          {selection.size > 0
            ? copy.traceSelectedCountTemplate.replace("{count}", String(selection.size))
            : copy.traceSelectionHint}
        </span>
        {selection.size > 0 ? (
          <button type="button" className="trace-clear-selection" onClick={() => onSelectionChange(new Set())}>
            {copy.traceClearSelection}
          </button>
        ) : null}
      </div>
      <div className="trace-workbench">
        <section className="trace-events-pane">
          <div className="trace-pane-heading">
            <strong>{copy.traceRecords}</strong>
            <span className="trace-event-count">{traces.length}</span>
          </div>
          <div className="trace-event-list" aria-label={copy.traceRecords}>
            {bands.map((band, bandIndex) => (
              <Fragment key={band.key || "single"}>
                {band.ordinal !== null ? (
                  <div className="trace-event-band" title={band.request ?? undefined}>
                    <span className="trace-event-band-label">
                      {copy.traceTurnLabelTemplate.replace("{turn}", String(band.ordinal))}
                    </span>
                    {band.request ? <span className="trace-event-band-request">{band.request}</span> : null}
                  </div>
                ) : null}
                {(layout.segments[bandIndex]?.entries ?? []).map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`trace-event-row trace-event-row-${entry.kind}${selection.has(entry.id) ? " is-selected" : ""}`}
                    aria-pressed={selection.has(entry.id)}
                    onClick={() => onSelectionChange(new Set([entry.id]))}
                  >
                    <span className="trace-event-kind">{copy.traceKinds[entry.kind]}</span>
                    <strong className="trace-event-title">
                      {entry.kind === "llm" ? displayModelName(entry.model) || copy.traceAgent : entry.name}
                    </strong>
                    <span className="trace-event-round">
                      {copy.traceAttemptRoundTemplate
                        .replace("{attempt}", String(entry.attempt))
                        .replace("{round}", entry.round === null ? copy.traceRoundUnknown : String(entry.round))}
                    </span>
                    <span className={`trace-event-status trace-event-status-${entry.status}`}>
                      {translate(copy.traceStatuses, entry.status)}
                    </span>
                    <time className="trace-event-duration">{formatTraceDuration(entry.durationMs, copy)}</time>
                  </button>
                ))}
              </Fragment>
            ))}
          </div>
        </section>
        <section className="trace-inspector">
          <strong className="trace-pane-heading">{copy.traceInspector}</strong>
          <div
            className="trace-inspector-tabs"
            role="tablist"
            aria-label={copy.traceInspector}
            onKeyDown={handleInspectorKeys}
          >
            {inspectorTabs.map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`trace-inspector-tab-${tab}`}
                className="trace-inspector-tab"
                aria-selected={activeTab === tab}
                aria-controls="trace-inspector-panel"
                tabIndex={activeTab === tab ? 0 : -1}
                onClick={() => setActiveTab(tab)}
              >
                {copy[label]}
              </button>
            ))}
          </div>
          <div
            className="trace-inspector-content"
            role="tabpanel"
            id="trace-inspector-panel"
            aria-labelledby={`trace-inspector-tab-${activeTab}`}
          >
            <InspectorContent tab={activeTab} selected={selected} traces={traces} copy={copy} locale={locale} />
          </div>
        </section>
      </div>
    </div>
  );
});
