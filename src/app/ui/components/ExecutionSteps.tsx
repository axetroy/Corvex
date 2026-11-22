import { formatDate, formatExecutionPayload, formatTraceDuration } from "../format.js";
import { Collapse } from "antd";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import type { ExecutionStep } from "../types.js";
import { DataTable, Empty, ExpandableText } from "./common.js";

/** 执行事件的输入、输出与标识折叠区。 */
function ExecutionStepDetails({ event, copy }: { event: ExecutionStep; copy: Copy }) {
  return (
    <Collapse
      className="execution-event-details"
      size="small"
      items={[{
        key: "details",
        label: copy.executionDetails,
        children: (
          <>
            {event.input ? (
              <ExpandableText label={copy.traceInput} value={formatExecutionPayload(event.input)} className="trace-payload" />
            ) : null}
            {event.output ? (
              <ExpandableText label={copy.traceOutput} value={formatExecutionPayload(event.output)} className="trace-payload" />
            ) : null}
            {event.errorDetail ? (
              <ExpandableText label={copy.error} value={formatExecutionPayload(event.errorDetail)} className="trace-payload" />
            ) : null}
          </>
        ),
      }]}
    />
  );
}

/** 执行事件表：按开始时间排序，展开后可查看脱敏后的输入与输出。 */
export function ExecutionSteps({ events, copy, locale, turnLabel }: {
  events: readonly ExecutionStep[];
  copy: Copy;
  locale: Locale;
  /** 按对话轮次汇总时返回该步骤所属的轮次标签；提供后表格增加轮次列。 */
  turnLabel?: (event: ExecutionStep) => string | null;
}) {
  if (events.length === 0) return <Empty>{copy.noExecutionSteps}</Empty>;
  const sorted = [...events].sort(
    (left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id - right.id,
  );
  return (
    <DataTable
      headers={[
        ...(turnLabel ? [copy.conversationTurnPicker] : []),
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
          {turnLabel ? <td>{turnLabel(event) ?? copy.none}</td> : null}
          <td className="execution-event-step">{event.step}</td>
          <td className={`execution-event-status execution-event-status-${event.status}`}>
            {translate(copy.executionStatuses, event.status)}
          </td>
          <td>{event.attempt ?? copy.none}</td>
          <td>{formatDate(event.startedAt, copy, locale)}</td>
          <td>{formatTraceDuration(event.durationMs, copy)}</td>
          <td><ExecutionStepDetails event={event} copy={copy} /></td>
        </tr>
      ))}
    </DataTable>
  );
}
