import { memo, useEffect, useMemo, useState } from "react";
import type { Copy, Locale } from "../i18n.js";
import type { ConversationTurnSegment, EventTraceEntry } from "../types.js";
import { Empty } from "./common.js";
import { TraceDiagram } from "./TraceDiagram.js";

/**
 * 执行轨迹视图：以时间线展示模型与工具活动。
 *
 * 对话的「对话」标签已经用可读记录呈现每条回复与工具调用，这里只保留时间线这一个
 * 视角，避免两个视图重复表达同一份数据。选中状态在刷新后自动收敛到仍存在的条目。
 */
export const TraceExperience = memo(function TraceExperience({
  entries,
  turns,
  copy,
  locale,
}: {
  entries: readonly EventTraceEntry[];
  /** 按轮分组的元数据；有值时按轮分段展示整段对话。 */
  turns?: readonly ConversationTurnSegment[];
  copy: Copy;
  locale: Locale;
}) {
  const traces = useMemo(
    () => [...entries].sort(
      (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id - right.id,
    ),
    [entries],
  );
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

  return (
    <div className="trace-experience">
      <TraceDiagram
        traces={traces}
        turns={turns}
        copy={copy}
        locale={locale}
        selection={selection}
        onSelectionChange={setSelection}
      />
    </div>
  );
});
