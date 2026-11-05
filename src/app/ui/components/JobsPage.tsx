import { useEffect, useState } from "react";
import { Button, Input, Select } from "antd";
import { errorMessage, fetchJson } from "../api.js";
import { formatDate, formatDuration, formatJobTarget } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import { clampPageOffset, pageRange } from "../pagination.js";
import { jobHash } from "../routing.js";
import { calculateJobDurationSeconds } from "../time.js";
import { jobTypes, pageSize, statuses } from "../types.js";
import type { JobPageResponse, JobQueue } from "../types.js";
import { DataTable, Empty, ErrorBanner, Loading, PageHeading, StatusBadge } from "./common.js";

interface Props {
  copy: Copy;
  locale: Locale;
  queue: JobQueue;
  refreshToken: number;
  onQueueChange: (queue: JobQueue) => void;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 任务列表页：按状态、类型与关键字筛选，并按固定页大小分页。 */
export function JobsPage({ copy, locale, queue, refreshToken, onQueueChange, onUpdated, onRefresh }: Props) {
  const [status, setStatus] = useState(queue.status);
  const [type, setType] = useState(queue.type);
  const [search, setSearch] = useState(queue.search);
  const [page, setPage] = useState<JobPageResponse>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setStatus(queue.status);
    setType(queue.type);
    setSearch(queue.search);
  }, [queue]);

  useEffect(() => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(queue.offset) });
    if (queue.status) params.set("status", queue.status);
    if (queue.type) params.set("type", queue.type);
    if (queue.search) params.set("search", queue.search);
    let active = true;
    setRefreshing(true);
    fetchJson<JobPageResponse>(`/api/ops/jobs?${params}`, copy)
      .then((response) => {
        if (!active) return;
        // 历史数据被保留策略清理后偏移可能越界，回到最后一页重新请求。
        const clampedOffset = clampPageOffset(response.total, queue.offset, pageSize);
        if (clampedOffset !== queue.offset) {
          onQueueChange({ ...queue, offset: clampedOffset });
          return;
        }
        setPage(response);
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
  }, [copy, queue, refreshToken, onUpdated, onQueueChange]);

  if (error && !page) return <ErrorBanner message={error} />;
  if (!page) return <Loading>{copy.loading}</Loading>;

  const { start, end } = pageRange(page.total, queue.offset, page.items.length, pageSize);

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <PageHeading
        title={copy.jobsTitle}
        description={copy.jobsDescription}
        actions={(
          <Button disabled={refreshing} aria-busy={refreshing} onClick={onRefresh}>
            {refreshing ? copy.refreshing : copy.refresh}
          </Button>
        )}
      />
      <section className="panel">
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            onQueueChange({ status, type, search: search.trim(), offset: 0 });
          }}
        >
          <label className="field">
            <span>{copy.statusFilter}</span>
            <Select
              value={status}
              onChange={setStatus}
              options={[{ value: "", label: copy.allStatuses }, ...statuses.map((value) => ({
                value,
                label: translate(copy.statuses, value),
              }))]}
            />
          </label>
          <label className="field">
            <span>{copy.typeFilter}</span>
            <Select
              value={type}
              onChange={setType}
              options={[{ value: "", label: copy.allTypes }, ...jobTypes.map((value) => ({
                value,
                label: translate(copy.types, value),
              }))]}
            />
          </label>
          <label className="field">
            <span>{copy.searchLabel}</span>
            <Input
              type="search"
              maxLength={100}
              value={search}
              placeholder={copy.searchPlaceholder}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button type="primary" htmlType="submit">{copy.applyFilters}</Button>
        </form>
        {page.items.length === 0 ? (
          <Empty>{copy.noMatchingJobs}</Empty>
        ) : (
          <DataTable
            headers={[
              copy.statusFilter,
              copy.typeFilter,
              copy.projectMr,
              copy.jobId,
              copy.created,
              copy.age,
              copy.attempts,
              copy.updated,
            ]}
          >
            {page.items.map((job) => (
              <tr key={job.id}>
                <td><StatusBadge status={job.status} label={translate(copy.statuses, job.status)} /></td>
                <td>{translate(copy.types, job.type)}</td>
                <td>{formatJobTarget(job, copy)}</td>
                <td><a href={jobHash(job.id, queue)}>{job.id}</a></td>
                <td>{formatDate(job.createdAt, copy, locale)}</td>
                <td>{formatDuration(calculateJobDurationSeconds(job), copy)}</td>
                <td>{job.attemptCount}</td>
                <td>{formatDate(job.updatedAt, copy, locale)}</td>
              </tr>
            ))}
          </DataTable>
        )}
        <div className="pagination">
          <span>
            {copy.showingTemplate
              .replace("{start}", String(start))
              .replace("{end}", String(end))
              .replace("{total}", String(page.total))}
          </span>
          <div>
            <Button
              disabled={queue.offset === 0}
              onClick={() => onQueueChange({ ...queue, offset: Math.max(0, queue.offset - pageSize) })}
            >
              {copy.previous}
            </Button>
            <Button
              disabled={queue.offset + page.items.length >= page.total}
              onClick={() => onQueueChange({ ...queue, offset: queue.offset + pageSize })}
            >
              {copy.next}
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
