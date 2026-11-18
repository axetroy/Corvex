import { memo } from "react";
import { describeSessionTool, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy } from "../i18n.js";
import { parseTraceValue } from "../trace.js";
import type { ConversationToolCall } from "../types.js";

/**
 * 助手回复下方的工具调用列表：把该轮实际读过的文件、执行过的检索以
 * 「名称 + 状态 + 耗时」的形式直接呈现在对话流里，无需切换到「轨迹」标签。
 * 参数沿用服务端的脱敏与限长结果，输出与错误详情仍在轨迹标签中查看。
 */
export const ConversationToolCalls = memo(function ConversationToolCalls({
  calls,
  copy,
}: {
  calls: readonly ConversationToolCall[];
  copy: Copy;
}) {
  if (calls.length === 0) return null;
  const summary = (calls.length === 1 ? copy.conversationToolCallTemplate : copy.conversationToolCallsTemplate)
    .replace("{count}", String(calls.length));
  return (
    <details className="conversation-tool-calls" open>
      <summary className="conversation-tool-calls-summary">{summary}</summary>
      <ul className="conversation-tool-calls-list">
        {calls.map((call, index) => (
          <li key={index} className="conversation-tool-call">
            <span className="conversation-tool-call-name">
              {describeSessionTool(call.name, parseTraceValue(call.input), null, copy)}
            </span>
            <span className={`conversation-tool-call-status conversation-tool-call-status-${call.status}`}>
              {translate(copy.traceStatuses, call.status)}
            </span>
            {call.durationMs === null ? null : (
              <span className="conversation-tool-call-duration">{formatTraceDuration(call.durationMs, copy)}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
});
