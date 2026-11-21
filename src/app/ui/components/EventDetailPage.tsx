import { useEffect, useState } from "react";
import { Button, Space } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatEventTarget } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import { isSameTerminalEventSnapshot } from "../snapshot.js";
import type { EventDetails } from "../types.js";
import {
  DataTable,
  DetailItem,
  DetailNode,
  Empty,
  ErrorBanner,
  ExpandableText,
  Loading,
  PageHeading,
  Panel,
  StatusBadge,
} from "./common.js";
import { ExecutionSteps } from "./ExecutionSteps.js";
import { TraceExperience } from "./TraceExperience.js";

interface Props {
  eventId: string;
  /** 返回事件列表的 hash，携带进入详情前的筛选条件。 */
  backHash: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 事件详情页：只读展示事件字段、生命周期、执行步骤、轨迹与尝试历史。 */
export function EventDetailPage({ eventId, backHash, copy, locale, refreshToken, onUpdated, onRefresh }: Props) {
  const [event, setEvent] = useState<EventDetails>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    setRefreshing(true);
    fetchJson<EventDetails>(`/api/ops/events/${encodeURIComponent(eventId)}`, copy)
      .then((response) => {
        if (!active) return;
        // 终态事件的轨迹不再变化，保留旧快照可跳过整棵详情树的重渲染。
        setEvent((current) => (current && isSameTerminalEventSnapshot(current, response) ? current : response));
        setError(undefined);
        onUpdated(new Date().toISOString());
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
  }, [copy, eventId, refreshToken, onUpdated]);

  if (error && !event) {
    return (
      <>
        <a className="back-link" href={backHash}>{copy.backToEvents}</a>
        <PageHeading
          title={copy.eventDetailTitleTemplate.replace("{id}", eventId)}
          description={copy.eventDetailDescription}
        />
        <ErrorBanner message={error} />
      </>
    );
  }
  if (!event) return <Loading>{copy.loading}</Loading>;

  const timeline = [{ from: "created", to: "queued", at: event.createdAt }, ...event.timeline];
  const refresh = (
    <Button disabled={refreshing} aria-busy={refreshing} onClick={onRefresh}>
      {refreshing ? copy.refreshing : copy.refresh}
    </Button>
  );

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <a className="back-link" href={backHash}>{copy.backToEvents}</a>
      <PageHeading
        title={copy.eventDetailTitleTemplate.replace("{id}", event.id)}
        description={copy.eventDetailDescription}
        actions={(
          <Space className="page-heading-actions">
            <StatusBadge status={event.status} label={translate(copy.statuses, event.status)} />
            {refresh}
          </Space>
        )}
      />
      <Panel title={copy.taskDetails}>
        <dl className="detail-grid">
          <DetailItem label={copy.statusFilter} value={translate(copy.statuses, event.status)} />
          <DetailItem label={copy.typeFilter} value={translate(copy.types, event.type)} />
          <DetailItem label={copy.projectMrDetails} value={formatEventTarget(event, copy)} />
          <DetailItem label={copy.requester} value={event.actorUsername || copy.none} />
          <DetailItem label={copy.requesterId} value={event.actorId} />
          <DetailItem label={copy.created} value={formatDate(event.createdAt, copy, locale)} />
          <DetailItem label={copy.lastUpdated} value={formatDate(event.updatedAt, copy, locale)} />
          <DetailItem label={copy.headSha} value={event.headSha} />
          <DetailItem label={copy.attempts} value={event.attemptCount} />
          <DetailItem
            label={copy.failureStage}
            value={event.failureStage ? translate(copy.statuses, event.failureStage) : copy.none}
          />
          <DetailItem label={copy.cancellationRequested} value={event.cancellationRequested ? copy.yes : copy.no} />
          {event.triggerComment ? (
            <DetailNode label={copy.triggerComment}>
              <ExpandableText label={copy.viewOriginalComment} value={event.triggerComment} />
            </DetailNode>
          ) : (
            <DetailItem label={copy.triggerComment} value={copy.none} />
          )}
          <DetailItem label={copy.request} value={event.request || copy.none} className="pre-wrap" />
          {event.lastError ? (
            <DetailNode label={copy.lastError}>
              <ExpandableText label={copy.viewErrorDetails} value={event.lastError} />
            </DetailNode>
          ) : (
            <DetailItem label={copy.lastError} value={copy.none} />
          )}
        </dl>
      </Panel>
      <Panel title={copy.lifecycleTimeline}>
        <DataTable headers={[copy.transition, copy.time]}>
          {timeline.map((transition, index) => (
            <tr key={index}>
              <td>
                {copy.transitionTemplate
                  .replace(
                    "{from}",
                    transition.from === "created" ? copy.createdState : translate(copy.statuses, transition.from),
                  )
                  .replace("{to}", translate(copy.statuses, transition.to))}
              </td>
              <td>{formatDate(transition.at, copy, locale)}</td>
            </tr>
          ))}
        </DataTable>
      </Panel>
      <Panel title={copy.executionSteps}>
        <ExecutionSteps events={event.events} copy={copy} locale={locale} />
      </Panel>
      <Panel title={copy.traceDiagram}>
        <TraceExperience entries={event.trajectory} copy={copy} locale={locale} />
      </Panel>
      <Panel title={copy.attemptHistory}>
        {event.attempts.length === 0 ? (
          <Empty>{copy.noAttempts}</Empty>
        ) : (
          <DataTable headers={[copy.attempts, copy.started, copy.finished, copy.error]}>
            {event.attempts.map((attempt) => (
              <tr key={attempt.attempt}>
                <td>{attempt.attempt}</td>
                <td>{formatDate(attempt.startedAt, copy, locale)}</td>
                <td>{formatDate(attempt.finishedAt, copy, locale)}</td>
                <td>
                  {attempt.error ? (
                    <ExpandableText label={copy.viewErrorDetails} value={attempt.error} />
                  ) : (
                    <span>{copy.none}</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </>
  );
}
