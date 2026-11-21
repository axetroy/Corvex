import { useEffect, useState } from "react";
import { Button, Input, Select } from "antd";
import { Link } from "react-router-dom";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatDuration, formatEventTarget } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import { clampPageOffset, pageRange } from "../pagination.js";
import { eventPath } from "../routing.js";
import { calculateEventDurationSeconds } from "../time.js";
import { eventTypes, pageSize, statuses } from "../types.js";
import type { EventPageResponse, EventQueue } from "../types.js";
import { DataTable, Empty, ErrorBanner, Loading, PageHeading, StatusBadge } from "./common.js";

interface Props {
  copy: Copy;
  locale: Locale;
  queue: EventQueue;
  refreshToken: number;
  onQueueChange: (queue: EventQueue) => void;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

/** 事件列表页：按状态、类型与关键字筛选，并按固定页大小分页。 */
export function EventsPage({ copy, locale, queue, refreshToken, onQueueChange, onUpdated, onRefresh }: Props) {
  const [status, setStatus] = useState(queue.status);
  const [type, setType] = useState(queue.type);
  const [search, setSearch] = useState(queue.search);
  const [page, setPage] = useState<EventPageResponse>();
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
    fetchJson<EventPageResponse>(`/api/ops/events?${params}`, copy)
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
        title={copy.eventsTitle}
        description={copy.eventsDescription}
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
              options={[{ value: "", label: copy.allTypes }, ...eventTypes.map((value) => ({
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
          <Empty>{copy.noMatchingEvents}</Empty>
        ) : (
          <DataTable
            headers={[
              copy.statusFilter,
              copy.typeFilter,
              copy.projectMr,
              copy.eventId,
              copy.created,
              copy.age,
              copy.attempts,
              copy.updated,
            ]}
          >
            {page.items.map((event) => (
              <tr key={event.id}>
                <td><StatusBadge status={event.status} label={translate(copy.statuses, event.status)} /></td>
                <td>{translate(copy.types, event.type)}</td>
                <td>{formatEventTarget(event, copy)}</td>
                <td><Link to={eventPath(event.id, queue)}>{event.id}</Link></td>
                <td>{formatDate(event.createdAt, copy, locale)}</td>
                <td>{formatDuration(calculateEventDurationSeconds(event), copy)}</td>
                <td>{event.attemptCount}</td>
                <td>{formatDate(event.updatedAt, copy, locale)}</td>
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
