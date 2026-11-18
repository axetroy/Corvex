import { memo, useEffect, useMemo, useState } from "react";
import { Tabs } from "antd";
import type { Copy, Locale } from "../i18n.js";
import type { ConversationTurnSegment, EventTraceEntry } from "../types.js";
import { Empty } from "./common.js";
import { TraceDiagram } from "./TraceDiagram.js";
import { TraceSession } from "./TraceSession.js";

type TraceView = "session" | "trace";

/** 执行轨迹：会话视图与时间线视图共享同一份排序结果和选中状态。 */
export const TraceExperience = memo(function TraceExperience({
  entries,
  userRequest,
  turns,
  copy,
  locale,
}: {
  entries: readonly EventTraceEntry[];
  /** 单轮场景的用户请求；与 `turns` 二选一。 */
  userRequest?: string;
  /** 按轮分组的元数据；有值时两个视图都按轮分段展示整段对话。 */
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

  return (
    <div className="trace-experience">
      <Tabs
        activeKey={view}
        onChange={(key) => setView(key as TraceView)}
        destroyOnHidden
        items={[
          {
            key: "session",
            label: copy.traceTabSession,
            children: <TraceSession traces={traces} userRequest={userRequest} turns={turns} copy={copy} locale={locale} />,
          },
          {
            key: "trace",
            label: copy.traceTabTrace,
            children: (
              <TraceDiagram
                traces={traces}
                turns={turns}
                copy={copy}
                locale={locale}
                selection={selection}
                onSelectionChange={setSelection}
              />
            ),
          },
        ]}
      />
    </div>
  );
});
