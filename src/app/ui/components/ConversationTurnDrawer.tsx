import { useEffect, useState } from "react";
import { Descriptions, Drawer, Space, Tabs, Tag } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import type { ConversationTurn } from "../types.js";
import { Empty, ErrorBanner, Loading, StatusBadge } from "./common.js";
import { ExecutionEvents } from "./ExecutionEvents.js";
import { TraceExperience } from "./TraceExperience.js";

interface Props {
  conversationId: string;
  /** 该轮的 conversation 任务 ID；为空表示抽屉关闭。 */
  jobId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onClose: () => void;
  onUpdated: (value: string) => void;
}

/**
 * 单轮对话记录抽屉：把一轮回复背后的任务状态、生命周期、轨迹与执行步骤
 * 收拢在同一处，让运维台在对话内就能查看该轮的完整记录。
 */
export function ConversationTurnDrawer({ conversationId, jobId, copy, locale, refreshToken, onClose, onUpdated }: Props) {
  const [turn, setTurn] = useState<ConversationTurn>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!jobId) {
      setTurn(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setError(undefined);
    setTurn(undefined);
    fetchJson<ConversationTurn>(
      `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(jobId)}`,
      copy,
    )
      .then((value) => {
        if (!active) return;
        setTurn(value);
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [conversationId, jobId, copy, refreshToken, onUpdated]);

  // 仍在运行的轮次会持续写入轨迹，跟随自动刷新重新拉取。
  const active = turn ? !["completed", "failed", "stale", "cancelled"].includes(turn.status) : false;

  return (
    <Drawer
      className="conversation-turn-drawer"
      width="min(880px, 96vw)"
      open={Boolean(jobId)}
      onClose={onClose}
      destroyOnHidden
      title={copy.conversationTurnTitle}
      extra={turn ? <StatusBadge status={turn.status} label={translate(copy.statuses, turn.status)} /> : null}
    >
      {error ? <ErrorBanner message={error} /> : null}
      {!turn && !error ? <Loading>{copy.loading}</Loading> : null}
      {turn ? (
        <Space direction="vertical" size={16} className="conversation-turn-body">
          <Descriptions
            className="conversation-turn-meta"
            size="small"
            column={{ xs: 1, sm: 2 }}
            items={[
              { key: "status", label: copy.statusFilter, children: translate(copy.statuses, turn.status) },
              { key: "attempts", label: copy.attempts, children: turn.attemptCount },
              { key: "created", label: copy.created, children: formatDate(turn.createdAt, copy, locale) },
              { key: "updated", label: copy.lastUpdated, children: formatDate(turn.updatedAt, copy, locale) },
              { key: "duration", label: copy.traceDuration, children: formatTraceDuration(turnDurationMs(turn), copy) },
              { key: "headSha", label: copy.headSha, children: <code>{turn.headSha}</code> },
              { key: "request", label: copy.request, span: 2, children: <span className="conversation-turn-request">{turn.request}</span> },
              ...(turn.lastError
                ? [{ key: "error", label: copy.lastError, span: 2, children: <span className="conversation-turn-error">{turn.lastError}</span> }]
                : []),
            ]}
          />
          <Tabs
            className="conversation-turn-tabs"
            destroyOnHidden
            items={[
              {
                key: "trace",
                label: copy.traceDiagram,
                children: (
                  <TraceExperience entries={turn.trajectory} userRequest={turn.request} copy={copy} locale={locale} />
                ),
              },
              {
                key: "records",
                label: copy.traceRecords,
                children: (
                  <ExecutionEvents events={turn.events} copy={copy} locale={locale} />
                ),
              },
              {
                key: "lifecycle",
                label: copy.lifecycleTimeline,
                children: turn.timeline.length === 0 ? (
                  <Empty>{copy.noExecutionEvents}</Empty>
                ) : (
                  <ol className="conversation-turn-timeline">
                    {turn.timeline.map((transition, index) => (
                      <li key={index}>
                        <Tag>{translate(copy.statuses, transition.to)}</Tag>
                        <span>{formatDate(transition.at, copy, locale)}</span>
                      </li>
                    ))}
                  </ol>
                ),
              },
            ]}
          />
          {active ? <p className="conversation-turn-live">{copy.conversationTurnLive}</p> : null}
        </Space>
      ) : null}
    </Drawer>
  );
}

/** 轮次从创建到最近更新的耗时，用于概览展示；缺失或非法时间返回 null。 */
function turnDurationMs(turn: ConversationTurn): number | null {
  const start = Date.parse(turn.createdAt);
  const end = Date.parse(turn.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
