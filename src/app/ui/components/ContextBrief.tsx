import { useEffect, useState } from "react";
import { fetchJson } from "../api.js";
import { formatDate } from "../format.js";
import type { Copy, Locale } from "../i18n.js";

interface SnapshotSummary {
  requestSeq: number;
  createdAt: string;
  contextWindow: number;
  estimatedTokens: number;
  threshold: number | null;
}

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onOpen: () => void;
}

const numberFormat = new Intl.NumberFormat("en-US");

function percent(value: number, total: number): number {
  return total > 0 ? Math.round(value / total * 1000) / 10 : 0;
}

/** 输入框下方的上下文简讯：只读取概要接口，点击可进入完整的上下文标签。 */
export function ContextBrief({ conversationId, copy, locale, refreshToken, onOpen }: Props) {
  const [latest, setLatest] = useState<SnapshotSummary>();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let active = true;
    fetchJson<{ snapshots: SnapshotSummary[] }>(
      `/api/ops/conversations/${encodeURIComponent(conversationId)}/context`, copy,
    ).then((result) => {
      if (!active) return;
      setLatest(result.snapshots?.[0]);
      setCount(result.snapshots?.length ?? 0);
    }).catch(() => {
      // 简讯是可选信息；读取失败时静默隐藏，不影响输入与发送。
      if (active) {
        setLatest(undefined);
        setCount(0);
      }
    });
    return () => { active = false; };
  }, [conversationId, copy, refreshToken]);

  if (!latest) return null;

  const usage = percent(latest.estimatedTokens, latest.contextWindow);
  const threshold = latest.threshold ? percent(latest.threshold, latest.contextWindow) : null;
  const detail = [
    `${copy.contextPanelEstimated} ${numberFormat.format(latest.estimatedTokens)}`,
    `${copy.contextPanelWindow} ${numberFormat.format(latest.contextWindow)}`,
    threshold === null ? null : `${copy.contextPanelThreshold} ${threshold}%`,
    `${copy.contextPanelRequests} ${count}`,
  ].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      className="conversation-context-brief"
      onClick={onOpen}
      title={detail}
      aria-label={copy.contextBriefOpen}
    >
      <span className="conversation-context-brief-label">{copy.conversationTabContext}</span>
      <span className="conversation-context-brief-bar">
        <i style={{ width: `${Math.min(100, Math.max(0, usage))}%` }} />
      </span>
      <span className="conversation-context-brief-value">{usage}%</span>
      <span className="conversation-context-brief-detail">{detail}</span>
      <span className="conversation-context-brief-time">{formatDate(latest.createdAt, copy, locale)}</span>
      <span className="conversation-context-brief-open">{copy.contextBriefOpen}</span>
    </button>
  );
}
