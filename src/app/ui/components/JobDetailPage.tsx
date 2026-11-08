import { useEffect, useState } from "react";
import { Button, Space } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatJobTarget } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import { isSameTerminalJobSnapshot } from "../snapshot.js";
import type { JobDetails } from "../types.js";
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
import { ExecutionEvents } from "./ExecutionEvents.js";
import { TraceExperience } from "./TraceExperience.js";

interface Props {
  jobId: string;
  /** 返回任务列表的 hash，携带进入详情前的筛选条件。 */
  backHash: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 任务详情页：只读展示任务字段、生命周期、执行步骤、轨迹与尝试历史。 */
export function JobDetailPage({ jobId, backHash, copy, locale, refreshToken, onUpdated, onRefresh }: Props) {
  const [job, setJob] = useState<JobDetails>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    setRefreshing(true);
    fetchJson<JobDetails>(`/api/ops/jobs/${encodeURIComponent(jobId)}`, copy)
      .then((response) => {
        if (!active) return;
        // 终态任务的轨迹不再变化，保留旧快照可跳过整棵详情树的重渲染。
        setJob((current) => (current && isSameTerminalJobSnapshot(current, response) ? current : response));
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
  }, [copy, jobId, refreshToken, onUpdated]);

  if (error && !job) {
    return (
      <>
        <a className="back-link" href={backHash}>{copy.backToJobs}</a>
        <PageHeading
          title={copy.jobDetailTitleTemplate.replace("{id}", jobId)}
          description={copy.jobDetailDescription}
        />
        <ErrorBanner message={error} />
      </>
    );
  }
  if (!job) return <Loading>{copy.loading}</Loading>;

  const timeline = [{ from: "created", to: "queued", at: job.createdAt }, ...job.timeline];
  const refresh = (
    <Button disabled={refreshing} aria-busy={refreshing} onClick={onRefresh}>
      {refreshing ? copy.refreshing : copy.refresh}
    </Button>
  );

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <a className="back-link" href={backHash}>{copy.backToJobs}</a>
      <PageHeading
        title={copy.jobDetailTitleTemplate.replace("{id}", job.id)}
        description={copy.jobDetailDescription}
        actions={(
          <Space className="page-heading-actions">
            <StatusBadge status={job.status} label={translate(copy.statuses, job.status)} />
            {refresh}
          </Space>
        )}
      />
      <Panel title={copy.taskDetails}>
        <dl className="detail-grid">
          <DetailItem label={copy.statusFilter} value={translate(copy.statuses, job.status)} />
          <DetailItem label={copy.typeFilter} value={translate(copy.types, job.type)} />
          <DetailItem label={copy.projectMrDetails} value={formatJobTarget(job, copy)} />
          <DetailItem label={copy.requester} value={job.actorUsername || copy.none} />
          <DetailItem label={copy.requesterId} value={job.actorId} />
          <DetailItem label={copy.created} value={formatDate(job.createdAt, copy, locale)} />
          <DetailItem label={copy.lastUpdated} value={formatDate(job.updatedAt, copy, locale)} />
          <DetailItem label={copy.headSha} value={job.headSha} />
          <DetailItem label={copy.attempts} value={job.attemptCount} />
          <DetailItem
            label={copy.failureStage}
            value={job.failureStage ? translate(copy.statuses, job.failureStage) : copy.none}
          />
          <DetailItem label={copy.cancellationRequested} value={job.cancellationRequested ? copy.yes : copy.no} />
          {job.triggerComment ? (
            <DetailNode label={copy.triggerComment}>
              <ExpandableText label={copy.viewOriginalComment} value={job.triggerComment} />
            </DetailNode>
          ) : (
            <DetailItem label={copy.triggerComment} value={copy.none} />
          )}
          <DetailItem label={copy.request} value={job.request || copy.none} className="pre-wrap" />
          {job.lastError ? (
            <DetailNode label={copy.lastError}>
              <ExpandableText label={copy.viewErrorDetails} value={job.lastError} />
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
      <Panel title={copy.executionEvents}>
        <ExecutionEvents events={job.events} copy={copy} locale={locale} />
      </Panel>
      <Panel title={copy.traceDiagram}>
        <TraceExperience entries={job.trajectory} userRequest={job.request} copy={copy} locale={locale} />
      </Panel>
      <Panel title={copy.attemptHistory}>
        {job.attempts.length === 0 ? (
          <Empty>{copy.noAttempts}</Empty>
        ) : (
          <DataTable headers={[copy.attempts, copy.started, copy.finished, copy.error]}>
            {job.attempts.map((attempt) => (
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
