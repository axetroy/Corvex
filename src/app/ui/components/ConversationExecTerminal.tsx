import { memo, useEffect, useRef, useState } from "react";
import type { Terminal, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { Button, Tag, Typography } from "antd";
import { sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import { formatExecDuration, type ExecDisplay } from "./execDisplay.js";
import "@xterm/xterm/css/xterm.css";
import "./ConversationExecTerminal.css";

export { createExecDisplay, applyExecDelta, replayExecsFromProcess, commandFromToolInput, formatExecDuration } from "./execDisplay.js";
export type { ExecDisplay } from "./execDisplay.js";

interface Props {
  entry: ExecDisplay;
  conversationId?: string;
  turnId?: string;
  copy: Copy;
}

/** 从主题变量读取真实颜色；xterm 用 canvas 绘制，无法解析 CSS `var()`。 */
function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  const background = read("--bg-code") || "#ffffff";
  const foreground = read("--text") || "#000000";
  const selection = read("--primary-soft") || background;
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: selection,
    black: read("--text"),
    red: read("--danger"),
    green: read("--success"),
    yellow: read("--warning"),
    blue: read("--primary"),
    magenta: read("--primary"),
    cyan: read("--primary"),
    white: foreground,
    brightBlack: read("--text-secondary"),
    scrollbarSliderBackground: read("--border"),
  };
}

/**
 * 可读终端：用 VS Code 同款 xterm.js 渲染 ANSI 输出，内置虚拟滚动。
 * 可折叠展开；命令成功结束（退出码 0）时自动收起，失败/被停止则保持展开。
 * 运行期间可单独停止该命令（不取消整轮）。
 */
export const ConversationExecTerminal = memo(function ConversationExecTerminal({ entry, conversationId, turnId, copy }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const disposersRef = useRef<Array<{ dispose(): void }>>([]);
  // 始终持有最新条目的引用：xterm 异步加载完成前到达的 chunk 不能丢。
  const latestRef = useRef(entry);
  latestRef.current = entry;
  const writtenRef = useRef({ stdout: 0, stderr: 0 });
  const pinnedRef = useRef(true);
  const wasDoneRef = useRef(entry.done);
  const [ready, setReady] = useState(false);
  // 运行中每秒推进一次，让耗时持续更新；命令结束后停止定时器。
  const [now, setNow] = useState(() => Date.now());
  // 历史记录里已成功结束的命令默认收起；正在运行的默认展开。
  const [collapsed, setCollapsed] = useState(entry.done && entry.exitCode === 0);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).then(([{ Terminal: TerminalCtor }, { FitAddon: FitAddonCtor }]) => {
      if (cancelled || !hostRef.current) return;
      const term = new TerminalCtor({
        allowTransparency: false,
        convertEol: true,
        disableStdin: true,
        cursorBlink: false,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.4,
        scrollback: 20_000,
        theme: terminalTheme(),
      });
      const fit = new FitAddonCtor();
      term.loadAddon(fit);
      term.open(hostRef.current);
      try { fit.fit(); } catch { /* 容器尚未布局完成，ResizeObserver 会再试 */ }

      // 异步加载期间可能已到达输出：按最新条目一次性补齐，避免丢帧。
      const current = latestRef.current;
      if (current.stdout) term.write(current.stdout);
      if (current.stderr) term.write(current.stderr);
      writtenRef.current = { stdout: current.stdout.length, stderr: current.stderr.length };
      term.scrollToBottom();

      const scrollSub = term.onScroll((position) => {
        pinnedRef.current = position >= term.buffer.active.baseY;
      });
      const resize = new ResizeObserver(() => {
        try { fit.fit(); } catch { /* 折叠或尺寸为 0 时忽略 */ }
      });
      resize.observe(host);
      const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      terminalRef.current = term;
      fitRef.current = fit;
      disposersRef.current = [scrollSub, { dispose: () => resize.disconnect() }, { dispose: () => themeObserver.disconnect() }];
      setReady(true);
    });
    return () => {
      cancelled = true;
      for (const disposable of disposersRef.current) disposable.dispose();
      disposersRef.current = [];
      fitRef.current?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 增量写入：xterm 是命令式的，只 write 新增部分，避免重复渲染整段输出。
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    const written = writtenRef.current;
    if (entry.stdout.length > written.stdout) {
      term.write(entry.stdout.slice(written.stdout));
      written.stdout = entry.stdout.length;
    }
    if (entry.stderr.length > written.stderr) {
      term.write(entry.stderr.slice(written.stderr));
      written.stderr = entry.stderr.length;
    }
    if (pinnedRef.current) term.scrollToBottom();
  }, [entry.stdout, entry.stderr, ready]);

  // 命令成功结束的瞬间自动收起；失败、被停止或用户手动展开后不再改写。
  useEffect(() => {
    if (entry.done && !wasDoneRef.current && entry.exitCode === 0) setCollapsed(true);
    wasDoneRef.current = entry.done;
  }, [entry.done, entry.exitCode]);

  // 运行中的耗时秒表：每秒刷新一次，结束后定格在落库的 finishedAt。
  useEffect(() => {
    if (entry.done) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [entry.done, entry.startedAt]);

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

  const status = entry.done
    ? entry.aborted
      ? <Tag color="warning">{copy.execStopped}</Tag>
      : entry.exitCode === 0
        ? <Tag color="success">{copy.execExitOk}</Tag>
        : <Tag color="error">{copy.execExitFail.replace("{code}", String(entry.exitCode ?? "?"))}</Tag>
    : <Tag color="processing">{copy.execRunning}</Tag>;
  const durationMs = (entry.finishedAt ?? now) - entry.startedAt;
  // 回放数据没有时间戳，不显示耗时，避免误导性的 0ms。
  const durationLabel = entry.startedAt ? formatExecDuration(durationMs) : "";
  const toggleTitle = collapsed ? copy.execExpand : copy.execCollapse;

  return (
    <div className="conversation-exec-terminal">
      <div className="conversation-exec-header">
        <Button
          size="small"
          type="text"
          className="conversation-exec-toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-label={toggleTitle}
          title={toggleTitle}
        >
          {collapsed ? "▸" : "▾"}
        </Button>
        <Typography.Text code className="conversation-exec-command">$ {entry.command}</Typography.Text>
        {status}
        {durationLabel ? (
          <Typography.Text type="secondary" className="conversation-exec-duration">{durationLabel}</Typography.Text>
        ) : null}
        {!entry.done && conversationId && turnId ? (
          <Button size="small" danger loading={stopping} onClick={() => void stop()}>
            {copy.execStop}
          </Button>
        ) : null}
      </div>
      <div className={`conversation-exec-screen${collapsed ? " is-collapsed" : ""}`}>
        <div className="conversation-exec-body" ref={hostRef} />
        {!entry.stdout && !entry.stderr && !collapsed ? (
          <span className="conversation-exec-placeholder">
            {entry.done ? copy.execNoOutput : copy.execWaiting}
          </span>
        ) : null}
      </div>
      {entry.truncated && !collapsed ? <div className="conversation-exec-truncated">{copy.execTruncated}</div> : null}
      {entry.aborted && entry.reason ? (
        <div className="conversation-exec-reason">{copy.execReason.replace("{reason}", entry.reason)}</div>
      ) : null}
      {stopError ? <div className="conversation-exec-error">{stopError}</div> : null}
    </div>
  );
});
