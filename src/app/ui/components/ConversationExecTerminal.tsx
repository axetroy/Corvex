import { memo, useEffect, useRef, useState } from "react";
import { Button, Tag, Typography } from "antd";
import { sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import { isAtScrollBottom } from "../scroll.js";
import "./ConversationExecTerminal.css";

/** 一条命令的可视状态：按 execId 聚合流式 chunk 与终态。 */
export interface ExecDisplay {
  execId: string;
  command: string;
  stdout: string;
  stderr: string;
  done: boolean;
  exitCode?: number | null;
  aborted?: boolean;
  reason?: string;
  truncated?: boolean;
  startedAt: number;
  finishedAt?: number;
}

export function createExecDisplay(execId: string, command: string, now = Date.now()): ExecDisplay {
  return { execId, command, stdout: "", stderr: "", done: false, startedAt: now };
}

/** 把 exec 事件追加到显示状态；返回新的条目（不可变更新）。 */
export function applyExecDelta(entry: ExecDisplay, delta: {
  stream: "stdout" | "stderr";
  chunk: string;
  done?: boolean;
  exitCode?: number | null;
  aborted?: boolean;
  reason?: string;
  truncated?: boolean;
}, now = Date.now()): ExecDisplay {
  if (delta.done) {
    return {
      ...entry,
      done: true,
      exitCode: delta.exitCode,
      aborted: delta.aborted,
      reason: delta.reason,
      truncated: delta.truncated,
      finishedAt: now,
    };
  }
  return delta.stream === "stdout"
    ? { ...entry, stdout: entry.stdout + delta.chunk }
    : { ...entry, stderr: entry.stderr + delta.chunk };
}

interface Props {
  entry: ExecDisplay;
  conversationId?: string;
  turnId?: string;
  copy: Copy;
  disabled?: boolean;
}

/** 可读终端：命令未结束期间实时追加输出，并可单独停止该命令（不取消整轮）。 */
export const ConversationExecTerminal = memo(function ConversationExecTerminal({ entry, conversationId, turnId, copy, disabled }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");

  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
  }, [entry.stdout, entry.stderr]);

  const status = entry.done
    ? entry.aborted
      ? <Tag color="warning">{copy.execStopped}</Tag>
      : entry.exitCode === 0
        ? <Tag color="success">{copy.execExitOk}</Tag>
        : <Tag color="error">{copy.execExitFail.replace("{code}", String(entry.exitCode ?? "?"))}</Tag>
    : <Tag color="processing">{copy.execRunning}</Tag>;
  const durationMs = (entry.finishedAt ?? Date.now()) - entry.startedAt;

  const stop = async () => {
    if (!conversationId || !turnId || stopping) return;
    setStopping(true);
    setStopError("");
    try {
      await sendJson(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/executions/${encodeURIComponent(entry.execId)}/cancel`,
        {}, copy, "POST",
      );
    } catch (cause) {
      setStopError(errorMessage(cause));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className={`conversation-exec-terminal${entry.done ? " is-done" : " is-running"}`}>
      <div className="conversation-exec-header">
        <Typography.Text code className="conversation-exec-command">$ {entry.command}</Typography.Text>
        {status}
        <Typography.Text type="secondary" className="conversation-exec-duration">{durationMs}ms</Typography.Text>
        {!entry.done && conversationId && turnId ? (
          <Button size="small" danger loading={stopping} disabled={disabled} onClick={() => void stop()}>
            {copy.execStop}
          </Button>
        ) : null}
      </div>
      <div
        className="conversation-exec-body"
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          pinnedRef.current = isAtScrollBottom(node.scrollTop, node.clientHeight, node.scrollHeight);
        }}
      >
        {entry.stdout ? <pre className="conversation-exec-stdout">{entry.stdout}</pre> : null}
        {entry.stderr ? <pre className="conversation-exec-stderr">{entry.stderr}</pre> : null}
        {!entry.done && !entry.stdout && !entry.stderr ? (
          <Typography.Text type="secondary">{copy.execWaiting}</Typography.Text>
        ) : null}
      </div>
      {entry.truncated ? <div className="conversation-exec-truncated">{copy.execTruncated}</div> : null}
      {entry.aborted && entry.reason ? (
        <div className="conversation-exec-reason">{copy.execReason.replace("{reason}", entry.reason)}</div>
      ) : null}
      {stopError ? <div className="conversation-exec-error">{stopError}</div> : null}
    </div>
  );
});
