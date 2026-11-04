import { formatDate, formatExecutionPayload, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import type { ExecutionEvent } from "../types.js";
import { DataTable, DetailItem, Empty, ExpandableText } from "./common.js";

/** 执行事件的输入、输出与标识折叠区。 */
function ExecutionEventDetails({ event, copy }: { event: ExecutionEvent; copy: Copy }) {
  return (
    <details className="execution-event-details">
      <summary>{copy.executionDetails}</summary>
      {event.deliveryId || event.eventId ? (
        <dl className="execution-event-identifiers">
          {event.deliveryId ? <DetailItem label={copy.executionDeliveryId} value={event.deliveryId} /> : null}
          {event.eventId ? <DetailItem label={copy.executionEventId} value={event.eventId} /> : null}
        </dl>
      ) : null}
      {event.input ? (
        <ExpandableText label={copy.traceInput} value={formatExecutionPayload(event.input)} className="trace-payload" />
      ) : null}
      {event.output ? (
        <ExpandableText label={copy.traceOutput} value={formatExecutionPayload(event.output)} className="trace-payload" />
      ) : null}
      {event.errorDetail ? (
        <ExpandableText label={copy.error} value={formatExecutionPayload(event.errorDetail)} className="trace-payload" />
      ) : null}
    </details>
  );
}

/** 执行事件表：按开始时间排序，展开后可查看脱敏后的输入与输出。 */
export function ExecutionEvents({ events, copy, locale }: { events: readonly ExecutionEvent[]; copy: Copy; locale: Locale }) {
  if (events.length === 0) return <Empty>{copy.noExecutionEvents}</Empty>;
  const sorted = [...events].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id - right.id,
  );
  return (
    <DataTable
      headers={[
        copy.executionStep,
        copy.executionStatus,
        copy.executionAttempt,
        copy.executionStarted,
        copy.executionDuration,
        copy.executionDetails,
      ]}
    >
      {sorted.map((event) => (
        <tr key={event.id}>
          <td className="execution-event-step">{event.step}</td>
          <td className={`execution-event-status execution-event-status-${event.status}`}>
            {translate(copy.executionStatuses, event.status)}
          </td>
          <td>{event.attempt ?? copy.none}</td>
          <td>{formatDate(event.startedAt, copy, locale)}</td>
          <td>{formatTraceDuration(event.durationMs, copy)}</td>
          <td><ExecutionEventDetails event={event} copy={copy} /></td>
        </tr>
      ))}
    </DataTable>
  );
}
