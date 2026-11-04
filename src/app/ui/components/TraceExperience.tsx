import { memo, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Copy, Locale } from "../i18n.js";
import type { JobTraceEntry } from "../types.js";
import { Empty } from "./common.js";
import { TraceDiagram } from "./TraceDiagram.js";
import { TraceSession } from "./TraceSession.js";

type TraceView = "session" | "trace";

/** 执行轨迹：会话视图与时间线视图共享同一份排序结果和选中状态。 */
export const TraceExperience = memo(function TraceExperience({
  entries,
  copy,
  locale,
}: {
  entries: readonly JobTraceEntry[];
  copy: Copy;
  locale: Locale;
}) {
  const traces = useMemo(
    () => [...entries].sort(
      (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id - right.id,
    ),
    [entries],
  );
  const [view, setView] = useState<TraceView>("session");
  const [selection, setSelection] = useState<ReadonlySet<number>>(
    () => new Set(traces.length > 0 ? [traces[0]!.id] : []),
  );

  // 刷新后丢弃已不存在的选中项，并在选择为空时回退到最新读取的第一条轨迹。
  useEffect(() => {
    setSelection((current) => {
      const available = new Set(traces.map((entry) => entry.id));
      const next = new Set([...current].filter((id) => available.has(id)));
      if (next.size === 0 && traces.length > 0) next.add(traces[0]!.id);
      const unchanged = next.size === current.size && [...next].every((id) => current.has(id));
      return unchanged ? current : next;
    });
  }, [traces]);

  if (traces.length === 0) return <Empty>{copy.noTrajectory}</Empty>;

  const handleTabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const next: TraceView | undefined = event.key === "ArrowLeft" || event.key === "Home"
      ? "session"
      : event.key === "ArrowRight" || event.key === "End"
        ? "trace"
        : undefined;
    if (!next) return;
    event.preventDefault();
    setView(next);
    document.getElementById(next === "session" ? "trace-session-tab" : "trace-diagram-tab")?.focus();
  };

  return (
    <div className="trace-experience">
      <div className="trace-view-tabs" role="tablist" aria-label={copy.traceDiagram} onKeyDown={handleTabKeys}>
        <button
          type="button"
          role="tab"
          id="trace-session-tab"
          className="trace-view-tab"
          aria-controls="trace-session-panel"
          aria-selected={view === "session"}
          tabIndex={view === "session" ? 0 : -1}
          onClick={() => setView("session")}
        >
          {copy.traceTabSession}
        </button>
        <button
          type="button"
          role="tab"
          id="trace-diagram-tab"
          className="trace-view-tab"
          aria-controls="trace-diagram-panel"
          aria-selected={view === "trace"}
          tabIndex={view === "trace" ? 0 : -1}
          onClick={() => setView("trace")}
        >
          {copy.traceTabTrace}
        </button>
      </div>
      {/* 只渲染当前视图：隐藏面板仍会参与协调，切换标签会重置面板内的筛选与缩放。 */}
      {view === "session" ? (
        <TraceSession traces={traces} copy={copy} locale={locale} />
      ) : (
        <TraceDiagram
          traces={traces}
          copy={copy}
          locale={locale}
          selection={selection}
          onSelectionChange={setSelection}
        />
      )}
    </div>
  );
});
