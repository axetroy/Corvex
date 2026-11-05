import { useEffect, useState } from "react";
import { Button } from "antd";
import { errorMessage, fetchJson } from "../api.js";
import { formatDate, formatDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import { statuses } from "../types.js";
import type { OverviewResponse } from "../types.js";
import { DataTable, Empty, ErrorBanner, Loading, PageHeading, Panel, StatCard } from "./common.js";

/** 概览页展示的进行中状态集合。 */
const activeStatuses = ["preparing", "analyzing", "fixing", "verifying", "publishing"] as const;

interface Props {
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 概览页：队列、Worker 心跳与模型调用汇总。 */
export function OverviewPage({ copy, locale, refreshToken, onUpdated, onRefresh }: Props) {
  const [data, setData] = useState<OverviewResponse>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    setRefreshing(true);
    fetchJson<OverviewResponse>("/api/ops/overview", copy)
      .then((response) => {
        if (!active) return;
        setData(response);
        setError(undefined);
        onUpdated(response.generatedAt);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [copy, refreshToken, onUpdated]);

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Loading>{copy.loading}</Loading>;

  const active = activeStatuses.reduce((sum, status) => sum + data.counts[status], 0);
  const refresh = (
    <Button type="primary" disabled={refreshing} aria-busy={refreshing} onClick={onRefresh}>
      {refreshing ? copy.refreshing : copy.refresh}
    </Button>
  );

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <PageHeading title={copy.overviewTitle} description={copy.overviewDescription} actions={refresh} />
      <div className="cards">
        <StatCard
          label={copy.queuedTitle}
          value={data.counts.queued}
          note={copy.oldestWaitingTemplate.replace("{value}", formatDuration(data.oldestQueueAgeSeconds, copy))}
        />
        <StatCard label={copy.inProgressTitle} value={active} note={copy.activeStages} />
        <StatCard label={copy.failedTitle} value={data.counts.failed} note={copy.requiresReview} />
        <StatCard
          label={copy.workersOnline}
          value={data.workers.onlineCount}
          note={copy.lastSeenTemplate.replace("{value}", formatDate(data.workers.lastSeenAt, copy, locale))}
        />
      </div>
      <Panel title={copy.lifecycle}>
        <div className="status-grid">
          {statuses.map((status) => (
            <div className="status-item" key={status}>
              <span>{translate(copy.statuses, status)}</span>
              <strong>{data.counts[status]}</strong>
            </div>
          ))}
        </div>
      </Panel>
      <Panel title={copy.modelUsage}>
        {data.modelCalls.length === 0 ? (
          <Empty>{copy.noModelCalls}</Empty>
        ) : (
          <DataTable
            headers={[copy.task, copy.outcome, copy.calls, copy.duration, copy.inputTokens, copy.outputTokens]}
          >
            {data.modelCalls.map((metric) => (
              <tr key={`${metric.taskType}-${metric.outcome}`}>
                <td>{translate(copy.types, metric.taskType)}</td>
                <td>{translate(copy.outcomes, metric.outcome)}</td>
                <td>{metric.calls}</td>
                <td>{copy.metricDurationTemplate.replace("{value}", (metric.durationMs / 1000).toFixed(1))}</td>
                <td>{metric.inputTokens}</td>
                <td>{metric.outputTokens}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </>
  );
}
