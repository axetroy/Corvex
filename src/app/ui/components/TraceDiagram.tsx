import { memo, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { formatDate, formatOutputTps, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, CopyTextKey, Locale } from "../i18n.js";
import {
  calculateAverageFirstTokenMs,
  calculateGenerationTokensPerSecond,
  reconstructLlmInput,
} from "../trace.js";
import type { JobTraceEntry, JobTraceKind } from "../types.js";
import { DetailItem, TraceField } from "./common.js";

type InspectorTab = "overview" | "parameters" | "result" | "schema" | "timing";

/** 详情面板的标签页顺序。 */
const inspectorTabs: readonly (readonly [InspectorTab, CopyTextKey])[] = [
  ["overview", "traceTabOverview"],
  ["parameters", "traceTabParameters"],
  ["result", "traceTabResult"],
  ["schema", "traceTabSchema"],
  ["timing", "traceTabTiming"],
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
  selected: readonly JobTraceEntry[];
  traces: readonly JobTraceEntry[];
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
          value={entry.kind === "llm" ? entry.model || entry.name : entry.name}
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

/** 时间轴上每条轨迹的横向位置比例。 */
interface TracePosition {
  entry: JobTraceEntry;
  startRatio: number;
  widthRatio: number;
}

interface DiagramProps {
  traces: readonly JobTraceEntry[];
  copy: Copy;
  locale: Locale;
  selection: ReadonlySet<number>;
  onSelectionChange: (selected: ReadonlySet<number>) => void;
}

/** 轨迹视图：时间轴概览、活动列表与事件详情面板。 */
export const TraceDiagram = memo(function TraceDiagram({ traces, copy, locale, selection, onSelectionChange }: DiagramProps) {
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ start: number; current: number; kind: JobTraceKind }>();
  const [activeTab, setActiveTab] = useState<InspectorTab>("overview");
  const plots = useRef<Partial<Record<JobTraceKind, HTMLDivElement | null>>>({});

  // 时间轴几何只依赖轨迹内容：用 reduce 而非展开参数，避免超长轨迹触发参数上限。
  const { duration, basePlotWidth, positions } = useMemo(() => {
    const starts = traces.map((entry) => Date.parse(entry.startedAt));
    const ends = traces.map((entry) => Date.parse(entry.finishedAt ?? entry.startedAt));
    const startTime = starts.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
    const endTime = ends.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
    const span = Math.max(1, endTime - startTime);
    return {
      duration: span,
      basePlotWidth: Math.max(760, Math.min(1400, traces.length * 22)),
      positions: traces.map((entry): TracePosition => {
        const startRatio = Math.max(0, (Date.parse(entry.startedAt) - startTime) / span);
        const endRatio = Math.max(startRatio, (Date.parse(entry.finishedAt ?? entry.startedAt) - startTime) / span);
        return { entry, startRatio, widthRatio: endRatio - startRatio };
      }),
    };
  }, [traces]);
  const plotWidth = Math.round(basePlotWidth * zoom);

  const plotLocalX = (event: ReactPointerEvent<HTMLDivElement>, kind: JobTraceKind): number => {
    const plot = plots.current[kind];
    return plot ? event.clientX - plot.getBoundingClientRect().left : 0;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>, kind: JobTraceKind) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const point = plotLocalX(event, kind);
    setDrag({ start: point, current: point, kind });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ ...drag, current: plotLocalX(event, drag.kind) });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>, kind: JobTraceKind) => {
    if (!drag || drag.kind !== kind) return;
    const endX = Math.max(0, Math.min(plotWidth, plotLocalX(event, kind)));
    const fromRatio = Math.min(drag.start, endX) / plotWidth;
    const toRatio = Math.max(drag.start, endX) / plotWidth;
    const selected = new Set<number>();
    // 拖动距离过小视为点击空白处，清空选择。
    if (Math.abs(endX - drag.start) > 5) {
      for (const { entry, startRatio, widthRatio } of positions) {
        if (startRatio + widthRatio >= fromRatio && startRatio <= toRatio) selected.add(entry.id);
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
              onClick={() => setZoom((value) => Math.max(0.5, value / 1.25))}
            >
              −
            </button>
            <span className="trace-zoom-value">{`${Math.round(zoom * 100)}%`}</span>
            <button
              type="button"
              className="trace-zoom-button"
              aria-label={copy.traceZoomIn}
              title={copy.traceZoomIn}
              onClick={() => setZoom((value) => Math.min(4, value * 1.25))}
            >
              +
            </button>
            <button type="button" className="trace-zoom-reset" onClick={() => setZoom(1)}>
              {copy.traceZoomReset}
            </button>
          </div>
        </div>
        <div className="trace-overview-scroll">
          <div
            className="trace-overview-scene"
            role="group"
            aria-label={copy.traceDiagram}
            style={{ width: `${labelWidth + plotWidth}px` }}
          >
            <div className="trace-overview-axis-row">
              <span className="trace-overview-label-spacer" />
              <div className="trace-overview-axis" style={{ width: `${plotWidth}px` }}>
                {[0, 1, 2, 3, 4].map((index) => (
                  <span
                    key={index}
                    className="trace-overview-tick"
                    aria-hidden="true"
                    style={{ left: `${(index / 4) * 100}%` }}
                  >
                    {formatTraceDuration(Math.round(duration * (index / 4)), copy)}
                  </span>
                ))}
              </div>
            </div>
            {(["llm", "tool"] as const).map((kind) => (
              <div className={`trace-overview-track trace-overview-track-${kind}`} key={kind}>
                <span className="trace-overview-track-label">{copy.traceKinds[kind]}</span>
                <div
                  className={`trace-overview-plot trace-overview-plot-${kind}`}
                  style={{ width: `${plotWidth}px` }}
                  ref={(node) => {
                    plots.current[kind] = node;
                  }}
                  onPointerDown={(event) => handlePointerDown(event, kind)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={(event) => handlePointerUp(event, kind)}
                  onPointerCancel={() => setDrag(undefined)}
                >
                  {positions
                    .filter((position) => position.entry.kind === kind)
                    .map(({ entry, startRatio, widthRatio }) => {
                      const title = entry.kind === "llm" ? entry.model || entry.name : entry.name;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          className={`trace-time-bar trace-time-bar-${entry.kind} trace-time-bar-${entry.status}${selection.has(entry.id) ? " is-selected" : ""}`}
                          title={`${title} · ${formatTraceDuration(entry.durationMs, copy)}`}
                          aria-label={`${copy.traceKinds[entry.kind]}: ${title}, ${formatTraceDuration(entry.durationMs, copy)}`}
                          style={{
                            left: `${startRatio * plotWidth}px`,
                            width: `${Math.max(4, widthRatio * plotWidth)}px`,
                          }}
                          onClick={() => onSelectionChange(new Set([entry.id]))}
                        />
                      );
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
            {traces.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`trace-event-row trace-event-row-${entry.kind}${selection.has(entry.id) ? " is-selected" : ""}`}
                aria-pressed={selection.has(entry.id)}
                onClick={() => onSelectionChange(new Set([entry.id]))}
              >
                <span className="trace-event-kind">{copy.traceKinds[entry.kind]}</span>
                <strong className="trace-event-title">
                  {entry.kind === "llm" ? entry.model || copy.traceAgent : entry.name}
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
