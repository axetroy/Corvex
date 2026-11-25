import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Spin, Typography } from "antd";
import { fetchJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate } from "../lib/format.js";
import type { Copy, Locale } from "../lib/i18n.js";
import type { TraceEntry } from "../lib/types.js";
// 仅导入类型：采集模块含 Node 侧依赖，不能被打进浏览器包。
import type { ContextCategory, ContextSnapshotData } from "../../../agent/context-inspect.js";

type Category = ContextCategory;
const categories: Category[] = ["system", "tools", "user", "inject", "assistant", "tool"];
type SnapshotSummary = Omit<ContextSnapshotData, "items">;

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
}

const categoryLabels: Record<Category, keyof Copy> = {
  system: "contextCategorySystem",
  tools: "contextCategoryTools",
  user: "contextCategoryUser",
  inject: "contextCategoryInject",
  assistant: "contextCategoryAssistant",
  tool: "contextCategoryTool",
};

function label(copy: Copy, category: Category): string {
  return String(copy[categoryLabels[category]]);
}

/** 会话上下文面板：复用 hook 落库的有界快照，不重新分析会话原文。 */
export function ContextPanel({ conversationId, copy, locale, refreshToken }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [events, setEvents] = useState<TraceEntry[]>([]);
  const [selectedSeq, setSelectedSeq] = useState<number>();
  const [detail, setDetail] = useState<ContextSnapshotData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      fetchJson<{ snapshots: SnapshotSummary[] }>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/context`, copy,
      ),
      fetchJson<{ trajectory: TraceEntry[] }>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns`, copy,
      ),
    ]).then(([context, turns]) => {
      if (!active) return;
      setSnapshots(context.snapshots ?? []);
      setEvents((turns.trajectory ?? []).filter((entry) => entry.kind === "context"));
      // 刷新/切换会话后总是回到最新请求，避免停留在上一轮的旧快照。
      setSelectedSeq(context.snapshots?.[0]?.requestSeq);
      setError("");
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [conversationId, copy, refreshToken]);

  useEffect(() => {
    if (!selectedSeq) {
      setDetail(undefined);
      return;
    }
    let active = true;
    fetchJson<ContextSnapshotData>(
      `/api/ops/conversations/${encodeURIComponent(conversationId)}/context/${selectedSeq}`, copy,
    ).then((result) => {
      if (active) setDetail(result);
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause));
    });
    return () => { active = false; };
  }, [conversationId, copy, selectedSeq]);

  // 统计、组成、时间线与内容浏览都跟随同一个选中请求，避免「上面看最新、下面看旧的」。
  const selected = snapshots.find((snapshot) => snapshot.requestSeq === selectedSeq) ?? snapshots[0];
  const utilization = selected && selected.contextWindow > 0
    ? Math.round(selected.estimatedTokens / selected.contextWindow * 1000) / 10
    : null;
  const thresholdPercent = selected && selected.contextWindow > 0 && selected.threshold
    ? Math.round(selected.threshold / selected.contextWindow * 1000) / 10
    : null;
  const bars = useCallback((snapshot: Pick<SnapshotSummary, "breakdown" | "estimatedTokens">) => {
    const total = categories.reduce((sum, key) => sum + (snapshot.breakdown[key] ?? 0), 0) || snapshot.estimatedTokens || 1;
    return categories.map((key) => ({
      key,
      value: snapshot.breakdown[key] ?? 0,
      ratio: (snapshot.breakdown[key] ?? 0) / total,
    }));
  }, []);
  const selectedBars = useMemo(() => selected ? bars(selected) : [], [bars, selected]);

  if (loading && !snapshots.length) return <Spin size="small" />;
  if (!snapshots.length) {
    return (
      <div className="context-panel">
        {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
        <Typography.Text type="secondary">{copy.contextPanelNoData}</Typography.Text>
      </div>
    );
  }

  return (
    <div className="context-panel">
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <div className="context-panel-stats">
        <div><span>{copy.contextPanelUtilization}</span><strong>{utilization === null ? copy.none : `${utilization}%`}</strong></div>
        <div><span>{copy.contextPanelWindow}</span><strong>{selected?.contextWindow ?? 0}</strong></div>
        <div><span>{copy.contextPanelEstimated}</span><strong>{selected?.estimatedTokens ?? 0}</strong></div>
        <div title={selected?.threshold ? String(selected.threshold) : undefined}>
          <span>{copy.contextPanelThreshold}</span>
          <strong>{thresholdPercent === null ? copy.none : `${thresholdPercent}%`}</strong>
        </div>
        <div><span>{copy.contextPanelRequests}</span><strong>{snapshots.length}</strong></div>
      </div>

      <section className="context-panel-section">
        <Typography.Text strong>
          {copy.contextPanelComposition}
          {selected?.truncated ? <em className="context-truncated"> · {copy.contextPanelTruncated}</em> : null}
        </Typography.Text>
        <div className="context-composition-bar">
          {selectedBars.map((part) => (
            <span
              key={part.key}
              className={`context-composition-part is-${part.key}`}
              style={{ width: `${Math.max(0, part.ratio * 100)}%` }}
              title={`${label(copy, part.key)}: ${part.value}`}
            />
          ))}
        </div>
        <div className="context-composition-legend">
          {selectedBars.map((part) => (
            <span key={part.key}>
              <i className={`is-${part.key}`} />
              {label(copy, part.key)} {part.value}
            </span>
          ))}
        </div>
      </section>

      <section className="context-panel-section">
        <Typography.Text strong>{copy.contextPanelTimeline}</Typography.Text>
        <div className="context-timeline-list">
          {snapshots.map((snapshot) => (
            <button
              key={snapshot.requestSeq}
              type="button"
              className={`context-timeline-row${selected?.requestSeq === snapshot.requestSeq ? " is-selected" : ""}`}
              onClick={() => setSelectedSeq(snapshot.requestSeq)}
              title={formatDate(snapshot.createdAt, copy, locale)}
            >
              <span className="context-timeline-seq">#{snapshot.requestSeq}</span>
              <span className="context-timeline-bar">
                {bars(snapshot).map((part) => (
                  <i key={part.key} className={`is-${part.key}`} style={{ width: `${Math.max(0, part.ratio * 100)}%` }} />
                ))}
              </span>
              <span className="context-timeline-tokens">{snapshot.estimatedTokens}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="context-panel-section">
        <Typography.Text strong>
          {copy.contextPanelBrowser} · #{selected?.requestSeq}
        </Typography.Text>
        {detail ? (
          <div className="context-browser">
            {categories.map((category) => {
              const items = detail.items.filter((item) => item.category === category);
              if (!items.length) return null;
              return (
                <div className="context-browser-group" key={category}>
                  <Typography.Text strong>{label(copy, category)} · {items.length}</Typography.Text>
                  {items.map((item, index) => (
                    <details key={`${item.name}-${index}`} className="context-browser-item">
                      <summary><code>{item.name}</code><span>{item.tokens}</span></summary>
                      <pre>{item.preview || copy.contextPanelNoPreview}</pre>
                    </details>
                  ))}
                </div>
              );
            })}
          </div>
        ) : <Spin size="small" />}
      </section>

      <section className="context-panel-section">
        <Typography.Text strong>{copy.contextPanelEvents}</Typography.Text>
        {events.length ? (
          <div className="context-event-list">
            {events.slice(0, 50).map((event) => (
              <div className="context-event-row" key={event.id}>
                <span>{event.name}</span>
                <span>{event.status}</span>
                <time>{formatDate(event.startedAt, copy, locale)}</time>
              </div>
            ))}
          </div>
        ) : <Typography.Text type="secondary">{copy.contextPanelEventEmpty}</Typography.Text>}
      </section>
      <Button size="small" onClick={() => setSelectedSeq(snapshots[0]?.requestSeq)}>{copy.contextPanelLatest}</Button>
    </div>
  );
}
