import { memo, useEffect, useState } from "react";
import {
  describeSessionTool,
  formatOutputTps,
  formatSessionContent,
  formatSessionPayload,
  formatTraceDuration,
  formatTraceJson,
  readAssistantOutput,
} from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, CopyTextKey, Locale } from "../i18n.js";
import { asTraceRecord, calculateAverageFirstTokenMs, calculateGenerationTokensPerSecond, parseTraceValue } from "../trace.js";
import type { JobTraceEntry } from "../types.js";
import { Empty } from "./common.js";

type SessionFilter = "all" | "conversation" | "tools";

/** 会话视图的筛选选项。 */
const filterOptions: readonly (readonly [SessionFilter, CopyTextKey])[] = [
  ["all", "traceSessionFilterAll"],
  ["conversation", "traceSessionFilterConversation"],
  ["tools", "traceSessionFilterTools"],
];

/** 会话中的一段角色消息。 */
function SessionMessage({ label, value, kind }: { label: string; value: string; kind: string }) {
  return (
    <article className={`trace-session-message trace-session-message-${kind}`}>
      <strong className="trace-session-role">{label}</strong>
      <pre className="trace-session-content">{value}</pre>
    </article>
  );
}

/** 工具调用的入参与结果折叠区。 */
function ToolDetails({
  entry,
  copy,
  open,
  onOpenChange,
}: {
  entry: JobTraceEntry;
  copy: Copy;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const input = formatTraceJson(entry.input ?? entry.rawContent);
  const output = formatSessionPayload(entry.output);
  return (
    <details
      className="trace-session-tool-details"
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary>{copy.traceToolDetails}</summary>
      <div className="trace-session-detail-grid">
        {input ? (
          <section className="trace-session-detail">
            <strong className="trace-session-role">{copy.traceArguments}</strong>
            <pre className="trace-session-content">{input}</pre>
          </section>
        ) : null}
        {output ? (
          <section className="trace-session-detail">
            <strong className="trace-session-role">{copy.traceResult}</strong>
            <pre className="trace-session-content">{output}</pre>
          </section>
        ) : null}
      </div>
    </details>
  );
}

/** 把轨迹条目格式化为「尝试 / 轮次」说明。 */
function roundLabel(entry: JobTraceEntry, copy: Copy): string {
  return copy.traceAttemptRoundTemplate
    .replace("{attempt}", String(entry.attempt))
    .replace("{round}", entry.round === null ? copy.traceRoundUnknown : String(entry.round));
}

/** 会话视图：把轨迹还原成可读的模型回复与工具调用时间线。 */
export const TraceSession = memo(function TraceSession({
  traces,
  copy,
  locale,
}: {
  traces: readonly JobTraceEntry[];
  copy: Copy;
  locale: Locale;
}) {
  const [filter, setFilter] = useState<SessionFilter>("all");
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(
    () => new Set(traces.filter((entry) => entry.kind === "tool").map((entry) => entry.id)),
  );

  useEffect(() => {
    const toolIds = new Set(traces.filter((entry) => entry.kind === "tool").map((entry) => entry.id));
    setOpenIds((current) => {
      const next = new Set([...current].filter((id) => toolIds.has(id)));
      for (const id of toolIds) {
        if (!current.has(id)) next.add(id);
      }
      return next.size === current.size && [...next].every((id) => current.has(id)) ? current : next;
    });
  }, [traces]);

  const modelTraces = traces.filter((entry) => entry.kind === "llm");
  const toolTraces = traces.filter((entry) => entry.kind === "tool");
  const failures = traces.filter((entry) => ["failed", "unknown", "interrupted"].includes(entry.status)).length;
  const summary = copy.traceSessionSummaryTemplate
    .replace("{messages}", String(modelTraces.length))
    .replace("{tools}", String(toolTraces.length))
    .replace("{errors}", String(failures))
    .replace("{ttft}", formatTraceDuration(calculateAverageFirstTokenMs(modelTraces), copy))
    .replace("{tps}", formatOutputTps(calculateGenerationTokensPerSecond(modelTraces), copy));

  const visible = filter === "all" ? traces : filter === "tools" ? toolTraces : modelTraces;
  const hasVisibleTools = visible.some((entry) => entry.kind === "tool");
  const emptyText = filter === "tools"
    ? copy.traceSessionNoTools
    : filter === "conversation"
      ? copy.traceSessionNoConversation
      : copy.noTrajectory;

  // 同一条用户消息可能出现在多个增量上下文中，按出现顺序去重后只展示一次。
  const seenUserMessages = new Set<string>();
  const items = visible.map((entry) => {
    const started = Date.parse(entry.startedAt);
    const time = Number.isFinite(started)
      ? new Date(started).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : copy.invalidDate;
    const heading = (
      <div className="trace-session-heading">
        <span className="trace-session-kind">
          {entry.kind === "llm" ? copy.traceSessionModelCall : copy.traceKinds.tool}
        </span>
        {entry.kind === "tool" ? (
          <strong className="trace-session-title">
            {describeSessionTool(entry.name, parseTraceValue(entry.input ?? entry.rawContent), entry.output, copy)}
          </strong>
        ) : null}
        {entry.kind === "llm" && entry.model ? (
          <span className="trace-session-model">{copy.traceSessionModelTemplate.replace("{model}", entry.model)}</span>
        ) : null}
        {entry.kind === "llm" ? (
          <>
            <span className="trace-session-ttft">
              {copy.traceFirstToken}: {formatTraceDuration(entry.firstTokenMs, copy)}
            </span>
            <span className="trace-session-tps">
              {formatOutputTps(calculateGenerationTokensPerSecond([entry]), copy)}
            </span>
          </>
        ) : null}
        <span className="trace-session-round">{roundLabel(entry, copy)}</span>
        <span className={`trace-session-status trace-session-status-${entry.status}`}>
          {translate(copy.traceStatuses, entry.status)}
        </span>
        <time className="trace-session-time">{time}</time>
        <span className="trace-session-duration">{formatTraceDuration(entry.durationMs, copy)}</span>
      </div>
    );

    if (entry.kind === "tool") {
      return (
        <article className="trace-session-event trace-session-event-tool" key={entry.id}>
          {heading}
          {entry.status === "failed" && entry.errorDetail ? (
            <SessionMessage label={copy.error} value={entry.errorDetail} kind="error" />
          ) : null}
          <ToolDetails
            entry={entry}
            copy={copy}
            open={openIds.has(entry.id)}
            onOpenChange={(open) => {
              setOpenIds((current) => {
                const next = new Set(current);
                if (open) next.add(entry.id);
                else next.delete(entry.id);
                return next;
              });
            }}
          />
        </article>
      );
    }

    const input = asTraceRecord(parseTraceValue(entry.input));
    const userMessages: string[] = [];
    if (Array.isArray(input?.messages)) {
      for (const contextEntry of input.messages) {
        const record = asTraceRecord(contextEntry);
        const message = asTraceRecord(record?.message);
        if (record?.type !== "message" || message?.role !== "user") continue;
        const text = formatSessionContent(message.content);
        if (!text) continue;
        const key = String(record.id ?? message.id ?? `${String(message.timestamp ?? "")}:${text}`);
        if (seenUserMessages.has(key)) continue;
        seenUserMessages.add(key);
        userMessages.push(text);
      }
    }
    const request = asTraceRecord(parseTraceValue(entry.rawContent));
    if (userMessages.length === 0 && typeof request?.userPrompt === "string" && seenUserMessages.size === 0) {
      seenUserMessages.add(request.userPrompt);
      userMessages.push(request.userPrompt);
    }
    const assistant = readAssistantOutput(entry.output, copy);
    const assistantText = assistant.text || (assistant.toolCalls.length > 0
      ? copy.traceSessionToolCallsTemplate.replace("{count}", String(assistant.toolCalls.length))
      : "");

    return (
      <article className="trace-session-event trace-session-event-llm" key={entry.id}>
        {heading}
        {userMessages.map((message, index) => (
          <SessionMessage key={index} label={copy.traceSessionUser} value={message} kind="user" />
        ))}
        {assistantText ? (
          <SessionMessage label={copy.traceSessionAssistant} value={assistantText} kind="assistant" />
        ) : null}
        {assistant.toolCalls.length > 0 && assistant.text ? (
          <div className="trace-session-tool-calls">
            {copy.traceSessionToolCallsTemplate.replace("{count}", String(assistant.toolCalls.length))}
          </div>
        ) : null}
        {entry.errorDetail ? (
          <SessionMessage label={copy.error} value={entry.errorDetail} kind="error" />
        ) : null}
      </article>
    );
  });

  return (
    <div className="trace-session-view" id="trace-session-panel" role="tabpanel" aria-labelledby="trace-session-tab">
      <p className="trace-session-summary">{summary}</p>
      <div className="trace-session-toolbar">
        <div className="trace-session-filters" role="group" aria-label={copy.traceSessionControls}>
          {filterOptions.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="trace-session-filter"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {copy[label]}
            </button>
          ))}
        </div>
        <div className="trace-session-actions">
          <button
            type="button"
            className="trace-session-action"
            disabled={!hasVisibleTools}
            onClick={() => setOpenIds(new Set(visible.filter((entry) => entry.kind === "tool").map((entry) => entry.id)))}
          >
            {copy.traceExpandAll}
          </button>
          <button
            type="button"
            className="trace-session-action"
            disabled={!hasVisibleTools}
            onClick={() => setOpenIds(new Set())}
          >
            {copy.traceCollapseAll}
          </button>
        </div>
      </div>
      <div className="trace-session-list" aria-label={copy.traceTabSession}>
        {items.length === 0 ? <Empty>{emptyText}</Empty> : items}
      </div>
    </div>
  );
});
