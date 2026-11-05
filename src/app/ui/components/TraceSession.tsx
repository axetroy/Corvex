import { Fragment, memo, useState } from "react";
import type { ReactNode } from "react";
import {
  describeSessionTool,
  formatOutputTps,
  formatSessionPayload,
  formatTraceDuration,
  formatTraceJson,
  readAssistantOutput,
} from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import { asTraceRecord, calculateAverageFirstTokenMs, calculateGenerationTokensPerSecond, parseTraceValue } from "../trace.js";
import type { JobTraceEntry } from "../types.js";
import { Empty, ExpandableText } from "./common.js";

/** 会话中的一段角色消息。 */
function SessionMessage({ label, value, kind, metadata }: {
  label: string;
  value: string;
  kind: string;
  metadata?: ReactNode;
}) {
  return (
    <article className={`trace-session-message trace-session-message-${kind}`}>
      <header className="trace-session-message-header">
        <strong className="trace-session-role">{label}</strong>
        {metadata ? <div className="trace-session-message-meta">{metadata}</div> : null}
      </header>
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
  time,
}: {
  entry: JobTraceEntry;
  copy: Copy;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  time: string;
}) {
  const input = formatTraceJson(entry.input ?? entry.rawContent);
  const output = formatSessionPayload(entry.output);
  return (
    <details
      className="trace-session-tool-details"
      aria-label={copy.traceToolDetails}
      open={open}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
    >
      <summary className="trace-session-tool-tip">
        <span className="trace-session-kind">{copy.traceKinds.tool}</span>
        <strong className="trace-session-title">
          {describeSessionTool(entry.name, parseTraceValue(entry.input ?? entry.rawContent), entry.output, copy)}
        </strong>
        <span className={`trace-session-status trace-session-status-${entry.status}`}>
          {translate(copy.traceStatuses, entry.status)}
        </span>
        <span className="trace-session-round">{roundLabel(entry, copy)}</span>
        <time className="trace-session-time">{time}</time>
        <span className="trace-session-duration">{formatTraceDuration(entry.durationMs, copy)}</span>
      </summary>
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
        {entry.errorDetail ? (
          <section className="trace-session-detail trace-session-detail-error">
            <strong className="trace-session-role">{copy.error}</strong>
            <pre className="trace-session-content">{entry.errorDetail}</pre>
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
  userRequest,
  copy,
  locale,
}: {
  traces: readonly JobTraceEntry[];
  userRequest: string;
  copy: Copy;
  locale: Locale;
}) {
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(() => new Set());

  const modelTraces = traces.filter((entry) => entry.kind === "llm");
  const toolTraces = traces.filter((entry) => entry.kind === "tool");
  const failures = traces.filter((entry) => ["failed", "unknown", "interrupted"].includes(entry.status)).length;
  const summary = copy.traceSessionSummaryTemplate
    .replace("{messages}", String(modelTraces.length))
    .replace("{tools}", String(toolTraces.length))
    .replace("{errors}", String(failures))
    .replace("{ttft}", formatTraceDuration(calculateAverageFirstTokenMs(modelTraces), copy))
    .replace("{tps}", formatOutputTps(calculateGenerationTokensPerSecond(modelTraces), copy));
  const systemPrompts = [...new Set(traces.flatMap((entry) => {
    if (entry.kind !== "llm") return [];
    const input = asTraceRecord(parseTraceValue(entry.input));
    const request = asTraceRecord(parseTraceValue(entry.rawContent));
    const prompt = input?.systemPrompt ?? request?.systemPrompt;
    return typeof prompt === "string" && prompt.trim() ? [prompt] : [];
  }))];

  // 模型上下文含有注入的附件数据；用户气泡只展示任务保存的原始请求。
  const items = traces.map((entry) => {
    const started = Date.parse(entry.startedAt);
    const time = Number.isFinite(started)
      ? new Date(started).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : copy.invalidDate;

    if (entry.kind === "tool") {
      return (
        <ToolDetails
          key={entry.id}
          entry={entry}
          copy={copy}
          open={openIds.has(entry.id)}
          time={time}
          onOpenChange={(open) => {
            setOpenIds((current) => {
              const next = new Set(current);
              if (open) next.add(entry.id);
              else next.delete(entry.id);
              return next;
            });
          }}
        />
      );
    }

    const assistant = readAssistantOutput(entry.output, copy);
    const assistantText = assistant.text || (assistant.toolCalls.length > 0
      ? copy.traceSessionToolCallsTemplate.replace("{count}", String(assistant.toolCalls.length))
      : "");
    const metadata = (
      <>
        {entry.model ? <span>{copy.traceSessionModelTemplate.replace("{model}", entry.model)}</span> : null}
        <span>{copy.traceFirstTokenShort}: {formatTraceDuration(entry.firstTokenMs, copy)}</span>
        <span>{formatOutputTps(calculateGenerationTokensPerSecond([entry]), copy)}</span>
        <span>{formatTraceDuration(entry.durationMs, copy)}</span>
        <time>{time}</time>
      </>
    );

    return (
      <Fragment key={entry.id}>
        {assistantText ? (
          <SessionMessage
            label={copy.traceSessionAssistant}
            value={assistantText}
            kind="assistant"
            metadata={metadata}
          />
        ) : null}
        {entry.errorDetail ? (
          <SessionMessage label={copy.error} value={entry.errorDetail} kind="error" />
        ) : null}
      </Fragment>
    );
  });

  return (
    <div className="trace-session-view" id="trace-session-panel" role="tabpanel" aria-labelledby="trace-session-tab">
      <p className="trace-session-summary">{summary}</p>
      <div className="trace-session-list" aria-label={copy.traceTabSession}>
        {systemPrompts.map((prompt, index) => (
          <ExpandableText
            key={index}
            label={copy.traceSystemPrompt}
            value={prompt}
            className="trace-session-system-prompt"
          />
        ))}
        {userRequest.trim() ? (
          <SessionMessage label={copy.traceSessionUser} value={userRequest.trim()} kind="user" />
        ) : null}
        {items.length === 0 ? <Empty>{copy.noTrajectory}</Empty> : items}
      </div>
    </div>
  );
});
