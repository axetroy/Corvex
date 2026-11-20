import { memo, useEffect, useRef, useState } from "react";
import { describeSessionTool, formatTraceDuration } from "../format.js";
import { isAtScrollBottom } from "../scroll.js";
import { translate } from "../i18n.js";
import type { Copy } from "../i18n.js";
import { parseTraceValue } from "../trace.js";
import type { ConversationToolCall } from "../types.js";

/**
 * 一轮对话中按发生顺序排列的展示项：模型每次开始新一轮输出时新增一条思考，
 * 接着是这一轮实际执行的工具调用，最后才是落库回答（由对话页单独渲染）。
 * 过程会脱敏落库，刷新后仍可还原；工具事件带调用 ID，重连后按 ID 合并。
 */
export type ConversationTimelineSegment =
  | { kind: "thinking"; key: string; text: string }
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; id: string; call: ConversationToolCall };

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
}: {
  segments: readonly ConversationTimelineSegment[];
  active: boolean;
  copy: Copy;
}) {
  const [open, setOpen] = useState(active);
  useEffect(() => {
    setOpen(active);
  }, [active]);
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
        {segments.map((segment) => segment.kind === "thinking" ? (
          <div className="conversation-thinking" key={segment.key}>
            <div className="conversation-thinking-label">{copy.conversationThinking}</div>
            <ThinkingContent text={segment.text} />
          </div>
        ) : segment.kind === "text" ? (
          <div className="conversation-process-text" key={segment.key}>{segment.text}</div>
        ) : (
          <details className="conversation-tool-call" key={segment.key}>
            <summary className="conversation-tool-call-summary">
              <span className="conversation-tool-call-name">
                {describeSessionTool(segment.call.name, parseTraceValue(segment.call.input), null, copy)}
              </span>
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
