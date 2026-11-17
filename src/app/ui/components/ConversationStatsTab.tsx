import { useEffect, useState } from "react";
import { Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import type { ConversationStats } from "../types.js";
import { DataTable, Empty, ErrorBanner, Loading, Panel, StatCard } from "./common.js";

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
}

/** 对话「统计」标签：汇总整段对话的轮次、用量与耗时，并给出逐轮明细。 */
export function ConversationStatsTab({ conversationId, copy, locale, refreshToken, onUpdated }: Props) {
  const [stats, setStats] = useState<ConversationStats>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!conversationId) {
      setStats(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setStats(undefined);
    setError(undefined);
    fetchJson<ConversationStats>(`/api/ops/conversations/${encodeURIComponent(conversationId)}/stats`, copy)
      .then((value) => {
        if (!active) return;
        setStats(value);
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [conversationId, copy, refreshToken, onUpdated]);

  if (error && !stats) return <ErrorBanner message={error} />;
  if (!stats) return <Loading>{copy.loading}</Loading>;

  const totalTokens = stats.inputTokens + stats.outputTokens;
  const averageTurnMs = stats.measuredTurns > 0 ? stats.totalDurationMs / stats.measuredTurns : null;
  const turnNote = [
    `${copy.conversationStatsCompleted} ${stats.completedTurns}`,
    `${copy.conversationStatsFailed} ${stats.failedTurns}`,
    `${copy.conversationStatsActive} ${stats.activeTurns}`,
  ].join(" · ");

  return (
    <div className="conversation-stats">
      {error ? <ErrorBanner message={error} /> : null}
      <div className="conversation-tab-heading">
        <Typography.Title level={4}>{copy.conversationStatsTitle}</Typography.Title>
        <Typography.Text type="secondary">{copy.conversationStatsDescription}</Typography.Text>
      </div>
      <div className="cards">
        <StatCard label={copy.conversationStatsTurns} value={stats.turnCount} note={turnNote} />
        <StatCard
          label={copy.conversationStatsAverage}
          value={averageTurnMs === null ? copy.none : formatTraceDuration(averageTurnMs, copy)}
          note={copy.conversationStatsMeasuredTemplate.replace("{count}", String(stats.measuredTurns))}
        />
        <StatCard label={copy.conversationStatsModelCalls} value={stats.modelCalls} note={`${copy.conversationStatsToolCalls} ${stats.toolCalls}`} />
        <StatCard
          label={copy.conversationStatsTotalTokens}
          value={totalTokens}
          note={copy.conversationStatsInOutTemplate.replace("{input}", String(stats.inputTokens)).replace("{output}", String(stats.outputTokens))}
        />
      </div>
      <Panel title={copy.conversationStatsBreakdown}>
        {stats.turns.length === 0 ? (
          <Empty>{copy.conversationStatsNoTurns}</Empty>
        ) : (
          <DataTable
            headers={[
              copy.conversationStatsStatusColumn,
              copy.conversationStatsRequestColumn,
              copy.conversationStatsStartedColumn,
              copy.conversationStatsDurationColumn,
              copy.conversationStatsModelColumn,
              copy.conversationStatsToolColumn,
              copy.conversationStatsInputTokens,
              copy.conversationStatsOutputTokens,
            ]}
          >
            {stats.turns.map((turn) => (
              <tr key={turn.messageId}>
                <td>{translate(copy.statuses, turn.status)}</td>
                <td className="conversation-stats-request">{turn.request}</td>
                <td>{formatDate(turn.createdAt, copy, locale)}</td>
                <td>{turn.durationMs === null ? copy.conversationStatsDurationUnavailable : formatTraceDuration(turn.durationMs, copy)}</td>
                <td>{turn.modelCalls}</td>
                <td>{turn.toolCalls}</td>
                <td>{turn.inputTokens}</td>
                <td>{turn.outputTokens}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
