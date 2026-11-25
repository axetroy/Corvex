import { memo, useEffect, useRef, useState } from "react";
import type { Terminal, ITheme } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon, ISearchResultChangeEvent } from "@xterm/addon-search";
import { Button, Input, Tag, Tooltip, Typography } from "antd";
import { sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { ExecDisplay } from "./execDisplay.js";
import "@xterm/xterm/css/xterm.css";
import "./ConversationExecTerminal.css";

export { createExecDisplay, applyExecDelta, replayExecsFromProcess, commandFromToolInput } from "./execDisplay.js";
export type { ExecDisplay } from "./execDisplay.js";

interface Props {
  entry: ExecDisplay;
  conversationId?: string;
  turnId?: string;
  copy: Copy;
  disabled?: boolean;
}

type SearchResults = Pick<ISearchResultChangeEvent, "resultIndex" | "resultCount">;

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

/** 搜索高亮色必须是 #RRGGBB；从主题变量读取，读取失败时给出安全回退值。 */
function searchDecorations() {
  const styles = getComputedStyle(document.documentElement);
  const hex = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  };
  return {
    matchBackground: hex("--primary-soft", "#fff3b0"),
    matchBorder: hex("--primary", "#1769aa"),
    matchOverviewRuler: hex("--primary", "#1769aa"),
    activeMatchBackground: hex("--primary", "#1769aa"),
    activeMatchBorder: hex("--primary", "#1769aa"),
    activeMatchColorOverviewRuler: hex("--primary", "#1769aa"),
  };
}

/**
 * 可读终端：用 VS Code 同款 xterm.js 渲染 ANSI 输出，内置虚拟滚动；
 * 支持输出内搜索、复制全部，并可在命令运行期间单独停止（不取消整轮）。
 */
export const ConversationExecTerminal = memo(function ConversationExecTerminal({ entry, conversationId, turnId, copy, disabled }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const disposersRef = useRef<Array<{ dispose(): void }>>([]);
  // 始终持有最新条目的引用：xterm 异步加载完成前到达的 chunk 不能丢。
  const latestRef = useRef(entry);
  latestRef.current = entry;
  const writtenRef = useRef({ stdout: 0, stderr: 0 });
  const pinnedRef = useRef(true);
  const [ready, setReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResults>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    void Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-search"),
    ]).then(([{ Terminal: TerminalCtor }, { FitAddon: FitAddonCtor }, { SearchAddon: SearchAddonCtor }]) => {
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
      const search = new SearchAddonCtor();
      term.loadAddon(fit);
      term.loadAddon(search);
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
      const searchSub = search.onDidChangeResults((event) => {
        setResults(event ? { resultIndex: event.resultIndex, resultCount: event.resultCount } : undefined);
      });
      const resize = new ResizeObserver(() => {
        try { fit.fit(); } catch { /* 尺寸为 0 时忽略 */ }
      });
      resize.observe(host);
      const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      terminalRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;
      disposersRef.current = [scrollSub, searchSub, { dispose: () => resize.disconnect() }, { dispose: () => themeObserver.disconnect() }];
      setReady(true);
    });
    return () => {
      cancelled = true;
      for (const disposable of disposersRef.current) disposable.dispose();
      disposersRef.current = [];
      searchRef.current?.clearDecorations();
      searchRef.current?.dispose();
      fitRef.current?.dispose();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
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

  // 搜索：输入变化即重新查找并高亮全部匹配。
  useEffect(() => {
    const search = searchRef.current;
    if (!search || !ready) return;
    if (!query) {
      search.clearDecorations();
      setResults(undefined);
      return;
    }
    search.findNext(query, { decorations: searchDecorations(), incremental: true });
  }, [query, ready]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const find = (backwards: boolean) => {
    if (!query || !searchRef.current) return;
    const options = { decorations: searchDecorations() };
    if (backwards) searchRef.current.findPrevious(query, options);
    else searchRef.current.findNext(query, options);
  };

  const copyAll = async () => {
    const term = terminalRef.current;
    if (!term) return;
    // 取渲染后的缓冲区文本：保留终端实际显示的顺序，且已去掉 ANSI 控制序列。
    const lines: string[] = [];
    for (let index = 0; index < term.buffer.active.length; index += 1) {
      lines.push(term.buffer.active.getLine(index)?.translateToString(true) ?? "");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n").replace(/\s+$/, ""));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

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
  const durationMs = (entry.finishedAt ?? Date.now()) - entry.startedAt;
  const copyTitle = copyState === "copied" ? copy.execCopied : copyState === "failed" ? copy.execCopyFailed : copy.execCopy;

  return (
    <div className={`conversation-exec-terminal${entry.done ? " is-done" : " is-running"}`}>
      <div className="conversation-exec-header">
        <Typography.Text code className="conversation-exec-command">$ {entry.command}</Typography.Text>
        {status}
        <Typography.Text type="secondary" className="conversation-exec-duration">{durationMs}ms</Typography.Text>
        <div className="conversation-exec-actions">
          {ready ? (
            <>
              <Tooltip title={copyTitle}>
                <Button size="small" type="text" onClick={() => void copyAll()} aria-label={copy.execCopy}>{copyState === "copied" ? copy.execCopied : copy.execCopy}</Button>
              </Tooltip>
              <Tooltip title={copy.execSearch}>
                <Button size="small" type="text" onClick={() => setSearchOpen((value) => !value)} aria-label={copy.execSearch}>{copy.execSearch}</Button>
              </Tooltip>
            </>
          ) : null}
          {!entry.done && conversationId && turnId ? (
            <Button size="small" danger loading={stopping} disabled={disabled} onClick={() => void stop()}>
              {copy.execStop}
            </Button>
          ) : null}
        </div>
      </div>
      {searchOpen ? (
        <div className="conversation-exec-search">
          <Input
            size="small"
            allowClear
            value={query}
            placeholder={copy.execSearchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey); }
              if (event.key === "Escape") { setQuery(""); setSearchOpen(false); }
            }}
          />
          <span className="conversation-exec-search-count">
            {results && results.resultCount > 0
              ? copy.execMatchInfo.replace("{index}", String(results.resultIndex + 1)).replace("{count}", String(results.resultCount))
              : query ? copy.execNoMatches : ""}
          </span>
          <Button size="small" disabled={!query} onClick={() => find(true)} aria-label={copy.execSearchPrev}>↑</Button>
          <Button size="small" disabled={!query} onClick={() => find(false)} aria-label={copy.execSearchNext}>↓</Button>
        </div>
      ) : null}
      <div className="conversation-exec-screen">
        <div className="conversation-exec-body" ref={hostRef} />
        {!entry.stdout && !entry.stderr ? (
          <span className="conversation-exec-placeholder">
            {entry.done ? copy.execNoOutput : copy.execWaiting}
          </span>
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
