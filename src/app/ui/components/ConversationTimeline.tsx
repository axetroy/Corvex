import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "antd";
import { describeSessionTool, formatTraceDuration } from "../lib/format.js";
import { isAtScrollBottom } from "../lib/scroll.js";
import { fitMiddleEllipsis, splitForMiddleEllipsis } from "../lib/truncate.js";
import { translate } from "../lib/i18n.js";
import type { Copy } from "../lib/i18n.js";
import { parseTraceValue } from "../lib/trace.js";
import { parseDisplayPlanSteps } from "../lib/planDisplay.js";
import type { ConversationToolCall } from "../lib/types.js";
import { ConversationExecTerminal, type ExecDisplay } from "./ConversationExecTerminal.js";
import { commandFromToolInput } from "./execDisplay.js";

/**
 * 一轮对话中按发生顺序排列的展示项：模型每次开始新一轮输出时新增一条思考，
 * 接着是这一轮实际执行的工具调用，最后才是落库回答（由对话页单独渲染）。
 * 过程会脱敏落库，刷新后仍可还原；工具事件带调用 ID，重连后按 ID 合并。
 */
export type ConversationTimelineSegment =
  | { kind: "thinking"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "context"; key: string; text: string; count?: number }
  | { kind: "tool"; key: string; id: string; call: ConversationToolCall };

/** 工具描述很长时按实际字宽均分开头与结尾，中间用省略号；完整文本留在 title。 */
const ToolCallName = memo(function ToolCallName({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [parts, setParts] = useState(() => splitForMiddleEllipsis(text));

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return;
      context.font = getComputedStyle(node).font;
      if (node.clientWidth <= 0) return;
      setParts(fitMiddleEllipsis(text, (value) => context.measureText(value).width, node.clientWidth));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span className="conversation-tool-call-name" ref={ref} title={text}>
      <span className="conversation-tool-call-name-head">{parts.head}</span>
      {parts.tail ? (
        <>
          <span className="conversation-tool-call-name-ellipsis">...</span>
          <span className="conversation-tool-call-name-tail">{parts.tail}</span>
        </>
      ) : null}
    </span>
  );
});

/** 思考文本在流式输出时会自动贴底；一旦用户向上翻阅就停止跟随。 */
const ThinkingContent = memo(function ThinkingContent({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  /** 用户是否停留在底部；初始为 true，流式开始时自然跟随最新内容。 */
  const pinned = useRef(true);

  useEffect(() => {
    const node = ref.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [text]);

  return (
    <div
      className="conversation-thinking-content"
      ref={ref}
      onScroll={(event) => {
        const node = event.currentTarget;
        pinned.current = isAtScrollBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
      }}
    >
      {text}
    </div>
  );
});

/**
 * 一整块「过程」：按发生顺序直接输出每次思考与工具调用，不逐条折叠。
 * 轮次运行期间整块强制展开且不可收起，结束后整体收起，用户可自行展开回看。
 */
export const ConversationTimeline = memo(function ConversationTimeline({
  segments,
  active,
  copy,
  execs,
  conversationId,
  turnId,
}: {
  segments: readonly ConversationTimelineSegment[];
  active: boolean;
  copy: Copy;
  /** 命令执行状态，按工具调用 ID（execId）索引；run_command 工具调用在此渲染为终端。 */
  execs?: ReadonlyMap<string, ExecDisplay>;
  conversationId?: string;
  turnId?: string;
}) {
  const [open, setOpen] = useState(active);
  const [commandFilter, setCommandFilter] = useState("");
  useEffect(() => {
    setOpen(active);
  }, [active]);
  // 一条轮次里命令较多时，允许按命令文本筛选要查看的终端；非命令步骤始终保留。
  const execSegments = useMemo(
    () => segments.filter((segment) => segment.kind === "tool" && segment.call.name === "run_command"),
    [segments],
  );
  const filterText = commandFilter.trim().toLowerCase();
  const hiddenExecCount = filterText
    ? execSegments.filter((segment) => segment.kind === "tool" &&
        !commandFromToolInput(segment.call.input).toLowerCase().includes(filterText)).length
    : 0;
  const matchesFilter = (segment: Extract<ConversationTimelineSegment, { kind: "tool" }>) =>
    !filterText || commandFromToolInput(segment.call.input).toLowerCase().includes(filterText);
  if (segments.length === 0) return null;
  return (
    <details
      className={`conversation-process${active ? " is-active" : ""}`}
      open={open}
      onToggle={(event) => {
        // 执行中始终保持展开；结束后交给用户自由切换。
        if (active) event.currentTarget.open = true;
        else setOpen(event.currentTarget.open);
      }}
    >
      <summary className="conversation-process-summary">
        {active ? <span className="conversation-process-spinner" aria-hidden="true" /> : null}
        {copy.conversationProcessTemplate.replace("{count}", String(segments.length))}
      </summary>
      <div className="conversation-process-body">
        {execSegments.length >= 2 ? (
          <div className="conversation-exec-filter">
            <Input
              size="small"
              allowClear
              value={commandFilter}
              placeholder={copy.execFilterPlaceholder}
              onChange={(event) => setCommandFilter(event.target.value)}
              aria-label={copy.execFilterPlaceholder}
            />
            {hiddenExecCount > 0 ? (
              <span className="conversation-exec-filter-count">
                {copy.execFilterHidden.replace("{count}", String(hiddenExecCount))}
              </span>
            ) : null}
          </div>
        ) : null}
        {segments.map((segment) => segment.kind === "thinking" ? (
          <div className="conversation-thinking" key={segment.key}>
            <div className="conversation-thinking-label">{copy.conversationThinking}</div>
            <ThinkingContent text={segment.text} />
          </div>
        ) : segment.kind === "text" ? (
          <div className="conversation-process-text" key={segment.key}>{segment.text}</div>
        ) : segment.kind === "context" ? (
          <div className="conversation-context-notice" key={segment.key} role="status">
            <span className="conversation-context-notice-icon" aria-hidden="true">↻</span>
            <span>{segment.text}</span>
            {segment.count && segment.count > 1 ? (
              <span className="conversation-context-notice-count" title={copy.conversationNoticeRepeatCount}>
                ×{segment.count}
              </span>
            ) : null}
          </div>
        ) : segment.kind === "tool" && segment.call.name === "run_command" ? (
          !matchesFilter(segment) ? null : execs?.get(segment.id) ? (
            <ConversationExecTerminal
              key={segment.key}
              entry={execs.get(segment.id)!}
              conversationId={conversationId}
              turnId={turnId}
              copy={copy}
            />
          ) : (
            <details className="conversation-tool-call" key={segment.key}>
              <summary className="conversation-tool-call-summary">
                <ToolCallName text={describeSessionTool(segment.call.name, parseTraceValue(segment.call.input), null, copy)} />
                <span className={`conversation-tool-call-status conversation-tool-call-status-${segment.call.status}`}>
                  {translate(copy.traceStatuses, segment.call.status)}
                </span>
              </summary>
              {segment.call.input ? <pre className="conversation-tool-call-input">{segment.call.input}</pre> : null}
            </details>
          )
        ) : segment.kind === "tool" && segment.call.name === "record_plan" ? (
          <div className="conversation-plan" key={segment.key}>
            <div className="conversation-plan-label">{copy.conversationPlan}</div>
            <ol className="conversation-plan-steps">
              {parseDisplayPlanSteps(segment.call.input).map((step, index) => (
                <li className={`conversation-plan-step is-${step.status}`} key={`${segment.key}-${index}`}>
                  {step.text}
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <details className="conversation-tool-call" key={segment.key}>
            <summary className="conversation-tool-call-summary">
              <ToolCallName text={describeSessionTool(segment.call.name, parseTraceValue(segment.call.input), null, copy)} />
              <span className={`conversation-tool-call-status conversation-tool-call-status-${segment.call.status}`}>
                {translate(copy.traceStatuses, segment.call.status)}
              </span>
              {segment.call.durationMs === null ? null : (
                <span className="conversation-tool-call-duration">
                  {formatTraceDuration(segment.call.durationMs, copy)}
                </span>
              )}
              {segment.call.input ? (
                <span className="conversation-tool-call-params-hint">{copy.conversationToolParameters}</span>
              ) : null}
            </summary>
            {segment.call.input ? <pre className="conversation-tool-call-input">{segment.call.input}</pre> : null}
          </details>
        ))}
      </div>
    </details>
  );
});
