import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { Button, Dropdown, Modal, Space, Tabs, Tag, Typography } from "antd";
import { Actions, Bubble, Prompts, Sender, Welcome } from "@ant-design/x";
import type { BubbleItemType, PromptsItemType } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import { markdownCodeComponents } from "../components/MarkdownCode.js";
import "./ConversationsPage.css";
import { fetchJson, handleUnauthorized, sendBinary, sendJson } from "../lib/api.js";
import { maxUploadBytesCeiling, maxUploadsPerMessage, uploadContentType, uploadUrl, type PendingAttachment } from "../../../upload-constants.js";
import { streamConversationTurn } from "../lib/stream.js";
import { resolveWaitingSince, resolveWaitingStage } from "../lib/conversationWaiting.js";
import { mergeContextNotice } from "../lib/conversationTimelineMerge.js";
import { useTurnNotifications } from "../lib/useTurnNotifications.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatOutputTps, formatTokenCount, formatTraceDuration } from "../lib/format.js";
import type { Copy, Locale } from "../lib/i18n.js";
import type { ConversationDetail, ConversationMessage, ConversationSkill, ConversationStreamContext, ConversationStreamEvent, ConversationStreamTool, ScheduledTaskCard } from "../lib/types.js";
import type { ConversationFollowUp } from "../../../model.js";
import { welcomePromptGroups, welcomePromptText } from "../lib/conversationPrompts.js";
import { appendInputHistory, readInputHistory, writeInputHistory } from "../lib/inputHistory.js";
import { ConversationRecordsTab } from "../components/ConversationRecordsTab.js";
import { ConversationStatsTab } from "../components/ConversationStatsTab.js";
import { ConversationTimeline, type ConversationTimelineSegment } from "../components/ConversationTimeline.js";
import { MiddleEllipsis } from "../components/MiddleEllipsis.js";
import { ConversationTraceTab } from "../components/ConversationTraceTab.js";
import { ContextPanel } from "../components/ContextPanel.js";
import { ContextBrief } from "../components/ContextBrief.js";
import { ComposerModelPicker } from "../components/ComposerModelPicker.js";
import { BranchPicker } from "../components/BranchPicker.js";
import { displayModelName } from "../lib/modelLabel.js";
import { ProjectPicker } from "../components/ProjectPicker.js";
import { RepositoryInfoPopover } from "../components/RepositoryInfoPopover.js";
import { AttachIcon, BookIcon, FileIcon, FilesIcon, InterjectIcon, MoreIcon, RocketIcon, ScrollBottomIcon, SearchIcon, StopIcon, WrenchIcon } from "../components/icons.js";
import { ConversationFilePanel } from "../components/ConversationFilePanel.js";
import { ExecutionHistoryTab } from "../components/ExecutionHistoryTab.js";
import { applyExecDelta, createExecDisplay, replayExecsFromProcess, commandFromToolInput, type ExecDisplay } from "../components/execDisplay.js";
import { ConversationGitGraph } from "../components/ConversationGitGraph.js";
import { ConversationGitChanges } from "../components/ConversationGitChanges.js";
import { ConversationTurnNav } from "../components/ConversationTurnNav.js";
import { ScheduledTaskCardView } from "../components/ScheduledTaskCardView.js";
import type { ProjectOption } from "../lib/projectPicker.js";
import { ErrorBanner, ExpandableText } from "../components/common.js";

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
  onConversationChange: (conversationId: string) => void;
}

/** 对话详情右侧的标签：对话流、调用记录、轮次轨迹与用量统计。 */
type ConversationDetailTab = "chat" | "records" | "trace" | "context" | "stats" | "changes" | "git" | "executions";

/** localStorage 中保存工作区/文件面板布局的键名（由 react-resizable-panels 管理）。 */
const panelLayoutKey = "corvex-ops-conversation-panels-layout";
const workspacePanelId = "workspace";
const filesPanelId = "files";

/** 读取已保存的面板布局；无效数据回退为默认布局。 */
function readPanelLayout(): Layout | undefined {
  try {
    const raw = window.localStorage.getItem(panelLayoutKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Layout;
    // 旧布局还带有 conversation-list 面板；列表已移入左侧导航，丢弃旧键避免面板 ID 不匹配。
    const cleaned = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key === workspacePanelId || key === filesPanelId),
    ) as Layout;
    if (Object.keys(cleaned).length > 0 && Object.values(cleaned).every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100,
    )) return cleaned;
  } catch (error) {
    window.console.warn("read conversation panel layout failed", error);
  }
  return undefined;
}

/** 保存面板布局；写入失败只记录告警。 */
function savePanelLayout(layout: Layout): void {
  try {
    window.localStorage.setItem(panelLayoutKey, JSON.stringify(layout));
  } catch (error) {
    window.console.warn("save conversation panel layout failed", error);
  }
}

/** 消息处理状态对应的界面文案；完成状态不展示徽标。 */
function messageStatus(message: ConversationMessage, copy: Copy): string {
  if (message.status === "queued") return copy.statuses.queued;
  if (message.status === "running") return copy.statuses.running;
  if (message.status === "failed") return copy.statuses.failed;
  return "";
}

/**
 * 等待模型首个输出时的动态反馈：脉冲圆点 + 已等待秒数。
 * 超过阈值后换成安抚文案（并改变配色与节奏），让用户知道系统仍在等待且有停止出口。
 */
function ModelWaiting({ since, copy }: { since: number; copy: Copy }) {
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - since));
  useEffect(() => {
    setElapsedMs(Math.max(0, Date.now() - since));
    const timer = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - since));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [since]);
  const stage = resolveWaitingStage(elapsedMs);
  const label = stage === "long"
    ? copy.conversationWaitingLong
    : stage === "slow"
      ? copy.conversationWaitingSlow
      : copy.conversationThinkingPending;
  return (
    <div className={`conversation-pending is-${stage}`} role="status">
      <span className="conversation-pending-dots" aria-hidden="true"><i /><i /><i /></span>
      <span aria-live="polite">{label}</span>
      {/* 秒数每秒变化，不进入无障碍播报，避免反复朗读。 */}
      <span className="conversation-pending-elapsed" aria-hidden="true">{Math.floor(elapsedMs / 1_000)}s</span>
    </div>
  );
}

/** 单条消息的正文：助手回复按 Markdown 渲染并提供复制，用户消息保持纯文本。 */
function MessageContent({
  message,
  copy,
  streaming,
  timeline,
  waitingSince,
  onSuggestion,
  showSuggestions,
  execs,
  conversationId,
  cards,
  locale,
}: {
  message: ConversationMessage;
  copy: Copy;
  locale: Locale;
  conversationId?: string;
  /** 计划任务工具的结构化结果；在过程块之外始终可见，可点击跳转管理页。 */
  cards?: readonly ScheduledTaskCard[];
  streaming?: boolean;
  timeline: readonly ConversationTimelineSegment[];
  waitingSince?: number | null;
  onSuggestion?: (text: string) => void;
  /** 命令终端状态：execId → 显示条目；流式期间用实时状态，刷新后从落库输出还原。 */
  execs?: ReadonlyMap<string, ExecDisplay>;
  /** 只有最新一轮的回答才展示建议；用户发起下一轮后旧建议过期。 */
  showSuggestions?: boolean;
}) {
  const codeComponentsProps = useMemo(() => ({
    code: {
      copy,
      copiedLabel: copy.codeCopied,
      failedLabel: copy.codeCopyFailed,
      diagramLoadingLabel: copy.diagramLoading,
      diagramFailedLabel: copy.diagramFailed,
    },
  }), [copy]);
  if (message.role === "user") {
    return <div className="conversation-message-text" data-turn-id={message.id}>{message.content}</div>;
  }
  // 回复仍在校验/生成中时不提供复制，避免复制到半成品内容。
  const settled = message.status === "completed" || message.status === "failed";
  return (
    <div className={`conversation-message-markdown${streaming && message.content ? " is-streaming" : ""}`}>
      {/* 先按发生顺序展示每次思考与工具调用，再展示最终回答。 */}
      <ConversationTimeline
        segments={timeline}
        active={Boolean(streaming)}
        copy={copy}
        execs={execs}
        conversationId={conversationId}
        turnId={message.turnId ?? undefined}
      />
      {cards?.map((card, index) => (
        <ScheduledTaskCardView key={`${message.id}-card-${index}`} card={card} copy={copy} locale={locale} />
      ))}
      {/* 放在过程块之后，长过程滚动时仍贴近屏幕底部；每次模型调用都会重新出现。 */}
      {streaming && waitingSince !== null && waitingSince !== undefined ? (
        <ModelWaiting since={waitingSince} copy={copy} />
      ) : null}
      {/* 模型输出不可信：转义原始 HTML，并把链接放到新标签打开。 */}
      {message.content ? (
        <XMarkdown
          content={message.content}
          escapeRawHtml
          openLinksInNewTab
          components={markdownCodeComponents}
          componentsProps={codeComponentsProps}
        />
      ) : null}
      {settled ? (
        <div className="conversation-message-actions">
          <Actions
            variant="borderless"
            items={[
              {
                key: "copy",
                label: copy.copyMessage,
                actionRender: <Actions.Copy text={message.content} />,
              },
            ]}
          />
          {message.tps !== null ? (
            <Typography.Text type="secondary" className="conversation-message-metric" title={copy.traceTps}>
              <span className="conversation-message-metric-label">{copy.conversationMessageTps}</span>{" "}
              {formatOutputTps(message.tps, copy)}
            </Typography.Text>
          ) : null}
          {message.cacheHitRate !== null && message.cacheTokens ? (
            <Typography.Text
              type="secondary"
              className="conversation-message-metric"
              title={copy.conversationMessageCacheHint
                .replace("{read}", formatTokenCount(message.cacheTokens.read))
                .replace("{total}", formatTokenCount(
                  message.cacheTokens.input + message.cacheTokens.read + message.cacheTokens.write,
                ))}
            >
              <span className="conversation-message-metric-label">{copy.conversationMessageCache}</span>{" "}
              {message.cacheHitRate}%
            </Typography.Text>
          ) : null}
          {message.durationMs !== null ? (
            <Typography.Text type="secondary" className="conversation-message-metric" title={copy.duration}>
              <span className="conversation-message-metric-label">{copy.conversationMessageDuration}</span>{" "}
              {formatTraceDuration(message.durationMs, copy)}
            </Typography.Text>
          ) : null}
          {message.model ? (
            <Typography.Text type="secondary" className="conversation-message-model">{displayModelName(message.model)}</Typography.Text>
          ) : null}
        </div>
      ) : null}
      {settled && showSuggestions && message.suggestions.length > 0 && onSuggestion ? (
        <div className="conversation-followup-suggestions" aria-label={copy.suggestNextStep}>
          <span className="conversation-followup-suggestions-label">{copy.suggestNextStep}</span>
          {message.suggestions.map((text) => (
            <button
              key={text}
              type="button"
              className="conversation-followup-suggestion"
              title={text}
              onClick={() => onSuggestion(text)}
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ConversationsPage({ conversationId, copy, locale, refreshToken, onUpdated, onRefresh, onConversationChange }: Props) {
  const [selectedConversationId, setSelectedConversationId] = useState(conversationId);
  const selectedConversationIdRef = useRef(conversationId);
  const [conversation, setConversation] = useState<ConversationDetail>();
  const pendingReplyTurns = useRef(new Map<string, string>());
  const [pendingReplyConversations, setPendingReplyConversations] = useState<Set<string>>(() => new Set());
  const [pollToken, setPollToken] = useState(0);
  /** 插话送达状态提示：queued 等待模型处理，delivered 已进入上下文，短暂展示后消失。 */
  const [interjectNotice, setInterjectNotice] = useState<"queued" | "delivered" | null>(null);
  const [followUps, setFollowUps] = useState<ConversationFollowUp[]>([]);
  const followUpStateRef = useRef<{ conversationId: string; count: number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showCreate, setShowCreate] = useState(!conversationId);
  const [project, setProject] = useState<ProjectOption>();
  const [selectedBranch, setSelectedBranch] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [skills, setSkills] = useState<ConversationSkill[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const composerRef = useRef<React.ElementRef<typeof Sender>>(null);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const draftBeforeHistory = useRef("");
  const historyNavigation = useRef(false);
  const historyKey = `corvex-ops-input-history:${selectedConversationId || "new"}`;
  useEffect(() => {
    setInputHistory(readInputHistory(window.localStorage, historyKey));
    setHistoryIndex(-1);
    draftBeforeHistory.current = "";
  }, [historyKey]);
  useEffect(() => {
    let active = true;
    fetchJson<{ items: ConversationSkill[] }>("/api/ops/skills", copy)
      .then((result) => { if (active) setSkills(result.items ?? []); })
      .catch(() => { if (active) setSkills([]); });
    return () => { active = false; };
  }, [copy, refreshToken]);
  const [detailTab, setDetailTab] = useState<ConversationDetailTab>("chat");
  const [repoInfoOpen, setRepoInfoOpen] = useState(false);
  const [savedLayout] = useState(readPanelLayout);
  const [filesCollapsed, setFilesCollapsed] = useState((savedLayout?.[filesPanelId] ?? 0) === 0);
  const filesPanelRef = usePanelRef();
  const replySubmitting = useRef(false);
  /** 已上传、等待随下一条消息发送的附件；切换会话时清空，避免串到别的对话。 */
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  /** 服务端运行时限额；拉取失败时退回默认常量，避免阻塞输入框。 */
  const [uploadLimits, setUploadLimits] = useState({ maxBytes: maxUploadBytesCeiling, maxPerMessage: maxUploadsPerMessage });
  const [draggingAttachment, setDraggingAttachment] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  /** 正在流式输出的轮次与累计正文；仅在轮次运行中展示，落库后以详情为准。 */
  const [streamedReply, setStreamedReply] = useState<{ turnId: string; text: string }>();
  /** 逐条思考与工具调用按轮次留在本次页面会话里，结束后仍可展开查看。 */
  const [timelineByTurn, setTimelineByTurn] = useState<Record<string, ConversationTimelineSegment[]>>({});
  /** 本页收到的计划任务结构化卡片，按轮次索引；刷新后由过程快照还原。 */
  const [scheduleCardsByTurn, setScheduleCardsByTurn] = useState<Record<string, ScheduledTaskCard[]>>({});
  /** 命令执行状态：execId（工具调用 ID）→ 终端显示条目，由 SSE exec 事件逐段更新。 */
  const [execsByTurn, setExecsByTurn] = useState<Record<string, Map<string, ExecDisplay>>>({});
  /** 对话流滚动容器：未滚离底部时跟随新内容，向上翻阅时不打断阅读。 */
  const transcriptPaneRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  /** 记录上一次的对话与标签，用于识别「切换」并在切换时回到最新消息。 */
  const lastTranscriptNav = useRef({ conversationId: "", tab: "" as ConversationDetailTab });
  /** 切换导航后等待新 transcript 挂载再强制滚到底部的标记。 */
  const forceScrollToLatest = useRef(false);
  /**
   * 切回 Chat 时 rc-tabs 会先跑 effect、后挂载 pane，普通 effect 看不到节点；
   * 用 ref 回调在新节点挂载的瞬间消费标记并滚到底部。
   */
  const attachTranscriptPane = useCallback((node: HTMLDivElement | null) => {
    transcriptPaneRef.current = node;
    if (!node || !forceScrollToLatest.current || detailTab !== "chat") return;
    forceScrollToLatest.current = false;
    node.scrollTop = node.scrollHeight;
    pinnedToBottom.current = true;
    setShowScrollBottom(false);
  }, [detailTab]);
  /** 离开底部一段距离后显示「滚动到底部」，避免刚打开对话就弹出按钮。 */
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [activeTurnNavId, setActiveTurnNavId] = useState("");
  const { request: requestNotifications, notify: notifyTurn } = useTurnNotifications();
  // 确认弹窗必须挂在 ConfigProvider 内，否则拿不到主题与 CSP nonce，样式会被浏览器拦掉。
  const [modal, modalContextHolder] = Modal.useModal();

  useEffect(() => {
    selectedConversationIdRef.current = conversationId;
    setSelectedConversationId(conversationId);
    setConversation(undefined);
    setShowCreate(!conversationId);
    setDraftMessage("");
    setAttachments([]);
    setDetailTab("chat");
    setError("");
    setTimelineByTurn({});
    pinnedToBottom.current = true;
  }, [conversationId]);


  useEffect(() => {
    if (!selectedConversationId) {
      setConversation(undefined);
      return;
    }
    let active = true;
    fetchJson<ConversationDetail>(`/api/ops/conversations/${encodeURIComponent(selectedConversationId)}`, copy)
      .then((value) => {
        if (!active) return;
        setConversation(value);
        const pendingTurnId = pendingReplyTurns.current.get(value.id);
        if (pendingTurnId && value.messages.some((message) => message.turnId === pendingTurnId)) {
          pendingReplyTurns.current.delete(value.id);
          setPendingReplyConversations((current) => {
            const next = new Set(current);
            next.delete(value.id);
            return next;
          });
        }
        setError("");
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [copy, selectedConversationId, refreshToken, pollToken, onUpdated]);

  const currentConversation = conversation?.id === selectedConversationId && selectedConversationId === conversationId ? conversation : undefined;
  const hasActiveTurn = currentConversation?.messages.some((message) => message.role === "assistant" &&
    (message.status === "queued" || message.status === "running")) ?? false;
  // 当前正在运行的轮次：订阅它的 SSE 正文，等它落库后由详情接管。
  const activeTurnId = currentConversation?.messages.find((message) =>
    message.role === "assistant" && message.status === "running" && message.turnId)?.turnId ?? undefined;

  const [changePaths, setChangePaths] = useState<string[]>([]);
  const [changeSha, setChangeSha] = useState("");
  /** 当前轮正在等待模型输出；null 表示已有内容/工具在执行/轮次结束。 */
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    if (!selectedConversationId) {
      setChangePaths([]);
      setChangeSha("");
      return () => { active = false; };
    }
    fetchJson<{ paths: string[]; sha?: string }>(
      `/api/ops/conversations/${encodeURIComponent(selectedConversationId)}/changes`, copy,
    ).then((result) => {
      if (active) {
        setChangePaths(result.paths ?? []);
        setChangeSha(result.sha ?? "");
      }
    }).catch(() => {
      if (active) {
        setChangePaths([]);
        setChangeSha("");
      }
    });
    return () => { active = false; };
  }, [copy, selectedConversationId, refreshToken, pollToken]);

  useEffect(() => {
    if (!hasActiveTurn && !pendingReplyConversations.has(selectedConversationId)) return;
    const timer = window.setInterval(() => setPollToken((value) => value + 1), 2_500);
    return () => window.clearInterval(timer);
  }, [hasActiveTurn, pendingReplyConversations, selectedConversationId]);

  useEffect(() => {
    let active = true;
    void fetchJson<{ maxBytes: number; maxPerMessage: number }>("/api/ops/me/upload-limits", copy)
      .then((limits) => {
        if (!active) return;
        setUploadLimits({ maxBytes: limits.maxBytes, maxPerMessage: limits.maxPerMessage });
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [copy]);

  // 「已送达」只短暂提示，避免长期占据界面；「等待模型处理」保留到送达为止。
  useEffect(() => {
    if (interjectNotice !== "delivered") return;
    const timer = window.setTimeout(() => setInterjectNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [interjectNotice]);

  const loadFollowUps = useCallback(async () => {
    if (!selectedConversationId) {
      followUpStateRef.current = null;
      setFollowUps([]);
      return;
    }
    try {
      const result = await fetchJson<{ items: ConversationFollowUp[] }>(
        `/api/ops/conversations/${encodeURIComponent(selectedConversationId)}/followups`, copy,
      );
      const items = result.items ?? [];
      const previous = followUpStateRef.current;
      followUpStateRef.current = { conversationId: selectedConversationId, count: items.length };
      setFollowUps(items);
      // 排队消息在后台被消费时没有活跃轮次的轮询，主动刷新详情才能发现新轮次。
      if (previous?.conversationId === selectedConversationId && previous.count !== items.length) {
        setPollToken((value) => value + 1);
      }
    } catch {
      setFollowUps([]);
    }
  }, [copy, selectedConversationId]);

  useEffect(() => {
    void loadFollowUps();
  }, [loadFollowUps, refreshToken, pollToken]);

  useEffect(() => {
    if (!selectedConversationId) return;
    const timer = window.setInterval(() => void loadFollowUps(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadFollowUps, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId || !activeTurnId) {
      setStreamedReply(undefined);
      setWaitingSince(null);
      return;
    }
    const controller = new AbortController();
    let closed = false;
    let latestText = "";
    const segments: ConversationTimelineSegment[] = [];
    const execs = new Map<string, ExecDisplay>();
    let flushTimer: number | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!closed) {
        setStreamedReply({ turnId: activeTurnId, text: latestText });
        setTimelineByTurn((current) => ({ ...current, [activeTurnId]: [...segments] }));
        setExecsByTurn((current) => ({ ...current, [activeTurnId]: new Map(execs) }));
      }
    };
    // 合并高频 token 事件：约 60ms 刷新一次，保持逐字观感的同时避免整段
    // Markdown 被每个 token 重新解析。
    const schedule = () => {
      if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 60);
    };
    const updateLast = (kind: "thinking" | "text", text: string) => {
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const segment = segments[index];
        if (segment?.kind === kind) {
          segment.text = text;
          return;
        }
      }
    };
    const onThinking = (text: string, reset: boolean) => {
      if (reset) {
        // 新一轮模型输出：新增一条思考；工具事件会插在它后面。
        segments.push({ kind: "thinking", key: `thinking-${segments.length}`, text });
        setWaitingSince((current) => resolveWaitingSince(current, { type: "start" }, Date.now()));
      } else {
        updateLast("thinking", text);
        if (text.trim()) setWaitingSince((current) => resolveWaitingSince(current, { type: "content" }, Date.now()));
      }
      schedule();
    };
    const onContext = (notice: ConversationStreamContext) => {
      mergeContextNotice(segments, notice.id, notice.text, (key, text): ConversationTimelineSegment => ({ kind: "context", key, text }));
      schedule();
    };
    const onTool = (tool: ConversationStreamTool) => {
      const call = { name: tool.name, input: tool.input, status: tool.status, durationMs: tool.durationMs };
      const existing = segments.find((segment) => segment.kind === "tool" && segment.id === tool.id);
      if (existing?.kind === "tool") existing.call = call;
      else segments.push({ kind: "tool", key: `tool-${tool.id}`, id: tool.id, call });
      // run_command 开始时先建终端条目，命令原文取自工具参数。
      if (tool.name === "run_command" && tool.status === "running" && !execs.has(tool.id)) {
        execs.set(tool.id, createExecDisplay(tool.id, commandFromToolInput(tool.input)));
      }
      // 工具执行中不算等待模型；工具结束后模型会被再次调用，重新进入等待。
      setWaitingSince((current) => resolveWaitingSince(
        current,
        { type: tool.status === "running" ? "toolRunning" : "toolSettled" },
        Date.now(),
      ));
      schedule();
    };
    const onExec = (delta: Extract<ConversationStreamEvent, { type: "exec" }>) => {
      const entry = execs.get(delta.execId) ?? createExecDisplay(delta.execId, "");
      execs.set(delta.execId, applyExecDelta(entry, delta));
      schedule();
    };
    setStreamedReply({ turnId: activeTurnId, text: "" });
    setWaitingSince(Date.now());
    void streamConversationTurn(
      selectedConversationId,
      activeTurnId,
      {
        onText: (text, reset) => {
          latestText = reset ? "" : text;
          // 工具调用之间的中间回复也算过程的一部分，按轮次单独成条。
          if (reset) {
            segments.push({ kind: "text", key: `text-${segments.length}`, text });
            setWaitingSince((current) => resolveWaitingSince(current, { type: "start" }, Date.now()));
          } else {
            updateLast("text", text);
            if (text.trim()) setWaitingSince((current) => resolveWaitingSince(current, { type: "content" }, Date.now()));
          }
          schedule();
        },
        onThinking,
        onTool,
        onExec,
        onContext,
        onInterjection: (interjectionTurnId, status, text) => {
          setInterjectNotice(status);
          // 插话属于当前轮次：插进同一条过程时间线，而不是另起一条用户消息。
          const clean = text.trim();
          if (clean) {
            setTimelineByTurn((current) => {
              const existing = current[interjectionTurnId] ?? [];
              if (existing.some((segment) => segment.kind === "interjection" && segment.text === clean)) return current;
              return {
                ...current,
                [interjectionTurnId]: [
                  ...existing,
                  { kind: "interjection", key: `interjection-${interjectionTurnId}-${existing.length}`, text: clean },
                ],
              };
            });
          }
          setPollToken((value) => value + 1);
        },
        onScheduledTaskCard: (card) => {
          setScheduleCardsByTurn((current) => ({
            ...current,
            [activeTurnId]: [...(current[activeTurnId] ?? []), card],
          }));
          setPollToken((value) => value + 1);
        },
        onQueue: () => void loadFollowUps(),
        onDone: (status) => {
          if (flushTimer !== undefined) window.clearTimeout(flushTimer);
          flushTimer = undefined;
          setWaitingSince((current) => resolveWaitingSince(current, { type: "done" }, Date.now()));
          flush();
          setPollToken((value) => value + 1);
          const userMessages = currentConversation?.messages ?? [];
          const assistantIndex = userMessages.findIndex((item) => item.turnId === activeTurnId);
          const request = assistantIndex > 0 ? userMessages[assistantIndex - 1]?.content ?? "" : "";
          const summary = (request || currentConversation?.title || activeTurnId).replace(/\s+/g, " ").slice(0, 80);
          notifyTurn({
            conversationId: selectedConversationId,
            turnId: activeTurnId,
            title: copy.notificationTitle,
            body: copy.notificationBodyTemplate
              .replace("{status}", copy.statuses[status] ?? status)
              .replace("{summary}", summary),
          });
        },
      },
      controller.signal,
    ).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      // 流断开只影响逐字效果：轮询仍在继续，下一轮详情会把状态收敛回来。
      console.warn("conversation stream stopped", errorMessage(cause));
      setPollToken((value) => value + 1);
    }).finally(() => {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
      flushTimer = undefined;
      // 流断开后由轮询接管，不再显示「等待模型」。
      setWaitingSince(null);
    });
    return () => {
      closed = true;
      controller.abort();
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    };
  }, [selectedConversationId, activeTurnId, loadFollowUps]);

  function selectProject(value: ProjectOption | undefined) {
    setProject(value);
    setError("");
    // 分支列表由 BranchPicker 自己加载；这里只把默认分支作为初始选中值。
    setSelectedBranch(value?.default_branch ?? "");
  }

  async function createConversation(message: string) {
    if (!message.trim()) return;
    if (!project || !selectedBranch) {
      setError(copy.chooseProject);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await fetch("/api/ops/conversations", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, targetBranch: selectedBranch, message, responseLanguage: locale === "zh-CN" ? "zh-CN" : "en" }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      const created = await result.json() as { conversationId: string };
      setDraftMessage("");
      setSelectedConversationId(created.conversationId);
      selectedConversationIdRef.current = created.conversationId;
      onConversationChange(created.conversationId);
      setShowCreate(false);
      setPollToken((value) => value + 1);
      onRefresh();
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 客户端只拦截「明显是二进制」的文件；.py/.ts/.html/.sh 等源码文件即使浏览器
   * 给出空 MIME 或 text/x-* 也应放行，最终按真实字节由服务端判定。
   */
  function isTextAttachment(file: File): boolean {
    const mime = file.type.toLowerCase();
    if (/^(image|audio|video)\//.test(mime) || ["application/pdf", "application/zip"].includes(mime)) return false;
    return !/\.(png|jpe?g|gif|webp|bmp|avif|pdf|zip|tar|gz|xz|7z|rar|exe|dll|so|dylib|app|dmg|deb|rpm|apk|msi)$/i.test(file.name);
  }

  function uploadErrorToCopy(error: string): string {
    if (error.includes("exceeds") || error.includes("size limit") || error.includes("too large")) return copy.attachmentTooLarge;
    if (["unsupported", "UTF-8", "binary", "filename", "executable", "script", "image", "PDF", "archive"]
      .some((token) => error.toLowerCase().includes(token.toLowerCase()))) {
      return copy.attachmentUnsupported;
    }
    return error;
  }

  async function uploadFiles(files: readonly File[]) {
    if (showCreate || !currentConversation || files.length === 0) return;
    const room = uploadLimits.maxPerMessage - attachments.length;
    if (room <= 0) {
      setError(copy.attachmentLimit);
      return;
    }
    setUploadingAttachment(true);
    setError("");
    try {
      for (const file of files.slice(0, room)) {
        // 客户端只按硬顶预检；实际限额由服务端运行时设置决定，超限会返回明确错误。
        if (file.size === 0 || file.size > uploadLimits.maxBytes) throw new Error(copy.attachmentTooLarge);
        if (!isTextAttachment(file)) throw new Error(copy.attachmentUnsupported);
        const created = await sendBinary<PendingAttachment>(
          uploadUrl(currentConversation.id, file.name, file.type || "text/plain"),
          await file.arrayBuffer(),
          uploadContentType,
          copy,
        );
        setAttachments((current) => [...current, {
          id: created.id, filename: created.filename, sizeBytes: created.sizeBytes,
        }]);
      }
    } catch (cause) {
      setError(uploadErrorToCopy(errorMessage(cause)));
    } finally {
      setUploadingAttachment(false);
    }
  }

  async function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
    if (!currentConversation) return;
    // 上传失败/取消不应阻断用户；服务端残留由会话删除清理兜底。
    try {
      await sendJson(`/api/ops/conversations/${encodeURIComponent(currentConversation.id)}/uploads/${encodeURIComponent(id)}`, {}, copy, "DELETE");
    } catch {
      // 已本地移除，不再打扰用户。
    }
  }

  async function sendReply(message: string, delivery?: "steer" | "queue" | "interrupt") {
    if (!currentConversation || !message.trim() || busy || replySubmitting.current || pendingReplyConversations.has(currentConversation.id)) return;
    const replyConversationId = currentConversation.id;
    replySubmitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await fetch(`/api/ops/conversations/${encodeURIComponent(replyConversationId)}/messages`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          message,
          responseLanguage: locale === "zh-CN" ? "zh-CN" : "en",
          ...(delivery ? { delivery } : {}),
          uploadIds: attachments.map((item) => item.id),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (result.status === 401) {
        handleUnauthorized(result, await result.clone().text());
        throw new Error(copy.authRequired);
      }
      if (!result.ok) {
        if (result.status === 409) {
          const body = await result.json() as { error?: unknown };
          if (body.error === "conversation already has an active turn") {
            throw new Error(copy.conversationTurnActive);
          }
          if (body.error === "conversation turn is not running") {
            throw new Error(copy.interruptUnavailable);
          }
          if (typeof body.error === "string" && (
            body.error.includes("uploads can only be attached") || body.error.includes("wait for the current turn")
          )) {
            throw new Error(copy.attachmentTurnActive);
          }
          throw new Error(copy.targetChanged);
        }
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      const queued = await result.json() as { turnId: string; delivery?: "steer" | "queued" | "queue" };
      // 附件已随消息绑定到本轮，输入框上的待发列表清空（失败时保留，用户可重试）。
      if (selectedConversationIdRef.current === replyConversationId) {
        setAttachments([]);
        // 发送等价于「回到现场」：即使之前在上翻历史，也跟随自己刚发的消息。
        pinnedToBottom.current = true;
        forceScrollToLatest.current = true;
        setShowScrollBottom(false);
        scrollTranscriptToBottom();
      }
      if (queued.delivery === "steer") {
        // 插话复用正在运行的轮次：没有新的 turnId，也不能进入 pendingReplyTurns。
        if (selectedConversationIdRef.current === replyConversationId) setDraftMessage("");
        setPollToken((value) => value + 1);
        onRefresh();
        return;
      }
      if (queued.delivery === "queue") {
        if (selectedConversationIdRef.current === replyConversationId) setDraftMessage("");
        void loadFollowUps();
        onRefresh();
        return;
      }
      pendingReplyTurns.current.set(replyConversationId, queued.turnId);
      setPendingReplyConversations((current) => new Set(current).add(replyConversationId));
      if (selectedConversationIdRef.current === replyConversationId) setDraftMessage("");
      setPollToken((value) => value + 1);
      onRefresh();
    } catch (cause) {
      if (selectedConversationIdRef.current === replyConversationId) setError(errorMessage(cause));
    } finally {
      replySubmitting.current = false;
      setBusy(false);
    }
  }

  async function downloadChangesPatch(conversationId: string, sha: string) {
    if (!sha) return;
    try {
      const result = await fetchJson<{ patch: string; truncated: boolean }>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/git/commit/${encodeURIComponent(sha)}/patch`,
        copy,
      );
      const blob = new Blob([result.patch], { type: "text/x-patch;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${sha.slice(0, 8)}.patch`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function confirmDiscardChanges() {
    const conversationId = selectedConversationId;
    const paths = changePaths;
    modal.confirm({
      title: copy.discardChangesConfirmTitle,
      content: (
        <div>
          <Typography.Paragraph>{copy.discardChangesConfirmDescription}</Typography.Paragraph>
          <ul className="conversation-discard-changes-list">
            {paths.slice(0, 5).map((path) => <li key={path}><code>{path}</code></li>)}
          </ul>
          {paths.length > 5 ? (
            <Typography.Text type="secondary">
              {copy.discardChangesConfirmMore.replace("{count}", String(paths.length - 5))}
            </Typography.Text>
          ) : null}
          {changeSha ? (
            <Button
              type="link"
              size="small"
              className="conversation-discard-download"
              onClick={() => void downloadChangesPatch(conversationId, changeSha)}
            >
              {copy.discardChangesDownloadPatch}
            </Button>
          ) : null}
        </div>
      ),
      okType: "danger",
      okText: copy.conversationDiscardChanges,
      onOk: async () => {
        // 弹框打开期间用户可能切到别的对话，此时不要误删其它对话的改动。
        if (selectedConversationIdRef.current !== conversationId) return;
        setError("");
        try {
          await sendJson(
            `/api/ops/conversations/${encodeURIComponent(conversationId)}/changes`,
            {}, copy, "DELETE",
          );
          setChangePaths([]);
          setPollToken((value) => value + 1);
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  function submitMessage(message: string, delivery?: "steer" | "queue" | "interrupt") {
    if (message.trim()) {
      // 发送是用户手势：首次发送时顺带申请通知权限，之后由侧边栏按钮控制开关。
      void requestNotifications().catch(() => undefined);
      const next = appendInputHistory(inputHistory, message);
      setInputHistory(next);
      writeInputHistory(window.localStorage, historyKey, next);
    }
    setHistoryIndex(-1);
    draftBeforeHistory.current = "";
    if (showCreate) void createConversation(message);
    else void sendReply(message, delivery);
  }

  /** 上下键浏览历史输入；只在光标位于首行/末行时接管，保留多行编辑。 */
  function handleComposerKeyDown(event: ReactKeyboardEvent) {
    // 技能补全打开时优先接管键盘；不改草稿，避免列表因过滤变化而跳动。
    if (commandSuggestions.length > 0) {
      const count = commandSuggestions.length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setCommandIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
        return false;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = commandSuggestions[commandIndex] ?? commandSuggestions[0];
        if (selected) {
          setDraftMessage(`/${selected.command} `);
          setCommandIndex(0);
          composerRef.current?.focus();
        }
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDraftMessage("");
        setCommandIndex(0);
        return false;
      }
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
    const target = event.target as HTMLTextAreaElement | HTMLInputElement;
    const value = typeof target.value === "string" ? target.value : "";
    const cursor = target.selectionStart ?? value.length;
    if (event.key === "ArrowUp") {
      if (!inputHistory.length) return;
      const firstBreak = value.indexOf("\n");
      if (firstBreak >= 0 && cursor > firstBreak) return;
      if (historyIndex < 0) draftBeforeHistory.current = draftMessage;
      const next = Math.min(historyIndex + 1, inputHistory.length - 1);
      historyNavigation.current = true;
      setHistoryIndex(next);
      setDraftMessage(inputHistory[next] ?? "");
      return false;
    }
    if (!inputHistory.length || historyIndex < 0) return;
    const lastBreak = value.lastIndexOf("\n");
    if (lastBreak >= 0 && cursor < lastBreak + 1) return;
    historyNavigation.current = true;
    if (historyIndex === 0) {
      setHistoryIndex(-1);
      setDraftMessage(draftBeforeHistory.current);
    } else {
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setDraftMessage(inputHistory[next] ?? "");
    }
    return false;
  }

  // 快捷提示词按类型分组：外层是分类卡片，Prompts 会把 children 渲染成纵向子列表。
  const promptGroups = welcomePromptGroups(copy);
  const groupIcons = {
    understand: <BookIcon />,
    locate: <SearchIcon />,
    improve: <WrenchIcon />,
    onboard: <RocketIcon />,
  };
  const suggestionItems: PromptsItemType[] = promptGroups.map((group) => ({
    key: group.key,
    label: (
      <span className="conversation-prompt-group-label">
        {groupIcons[group.key]}
        {group.label}
      </span>
    ),
    children: group.prompts.map((prompt) => ({ key: prompt.key, label: prompt.label })),
  }));
  const applyPrompt = (key: string) => {
    const text = welcomePromptText(promptGroups, key);
    if (text) {
      setDraftMessage(text.slice(0, 20_000));
      composerRef.current?.focus();
    }
  };
  const applySuggestion = (text: string) => {
    setDraftMessage(text.slice(0, 20_000));
    composerRef.current?.focus();
  };
  // 输入 "/" 或 "/abc" 且尚未输入空格时展示技能补全；普通路径文本不会被误判。
  const commandQuery = /^\/[a-z-]*$/.test(draftMessage) ? draftMessage.slice(1).toLowerCase() : null;
  const commandSuggestions = commandQuery === null
    ? []
    : skills
      .filter((skill) => skill.name.startsWith(commandQuery))
      .map((skill) => ({
        command: skill.name,
        description: skill.description.length > 90 ? `${skill.description.slice(0, 90)}…` : skill.description,
        fullDescription: skill.description,
      }));
  // 过滤条件变化时回到第一项；选中项超出可视区时只在菜单内部滚动。
  useEffect(() => { setCommandIndex(0); }, [commandQuery]);
  useEffect(() => {
    const list = commandMenuRef.current;
    const item = list?.querySelector<HTMLElement>(".conversation-command-suggestion.is-selected");
    if (!list || !item) return;
    const top = item.offsetTop - list.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + item.offsetHeight - list.clientHeight;
    }
  }, [commandIndex, commandSuggestions.length]);
  const isTurnActive = hasActiveTurn || pendingReplyConversations.has(selectedConversationId);

  async function cancelActiveTurn() {
    const turnId = activeTurnId ?? pendingReplyTurns.current.get(selectedConversationId);
    if (!turnId || !currentConversation) {
      setError(copy.cancelTurnUnavailable);
      return;
    }
    setCancelling(true);
    setError("");
    try {
      await sendJson(
        `/api/ops/conversations/${encodeURIComponent(currentConversation.id)}/turns/${encodeURIComponent(turnId)}/cancel`,
        {}, copy, "POST",
      );
      pendingReplyTurns.current.delete(currentConversation.id);
      setPendingReplyConversations((current) => {
        const next = new Set(current);
        next.delete(currentConversation.id);
        return next;
      });
      setPollToken((value) => value + 1);
      onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setCancelling(false);
    }
  }

  async function changeFollowUp(itemId: string, action: "remove" | "up" | "down") {
    setError("");
    try {
      const base = `/api/ops/conversations/${encodeURIComponent(selectedConversationId)}/followups/${encodeURIComponent(itemId)}`;
      if (action === "remove") await sendJson(base, {}, copy, "DELETE");
      else await sendJson(`${base}/move`, { direction: action }, copy, "POST");
      void loadFollowUps();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  // 输入框在任何时候都可编辑（繁忙时除外），只有发送按钮要求仓库/分支与内容齐备。
  const canSend = !busy && (showCreate
    ? Boolean(project && selectedBranch && draftMessage.trim())
    // 轮次执行中也可发送：服务端会把消息作为插话送进当前轮次。
    : Boolean(currentConversation && draftMessage.trim() && !pendingReplyConversations.has(currentConversation.id)));

  function toggleFilesPanel() {
    const panel = filesPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }

  function handleLayoutChanged(layout: Layout, meta: { requestedLayout?: Layout }) {
    savePanelLayout(meta.requestedLayout ?? layout);
    setFilesCollapsed((layout[filesPanelId] ?? 0) === 0);
  }

  // 插话显示在所属轮次的过程时间线里，不再作为顶层用户气泡出现，避免看起来像另开了一段对话。
  const transcriptMessages = (currentConversation?.messages ?? [])
    .filter((message) => message.kind !== "interjection")
    .map((message) =>
    message.role === "assistant" && message.status === "running" && streamedReply?.turnId === message.turnId
      ? { ...message, content: streamedReply.text }
      : message,
  );
  // 只有最后一条消息（最新一轮）的建议才有效；用户继续提问后旧建议隐藏。
  const lastMessageId = transcriptMessages.at(-1)?.id;
  const bubbleItems: BubbleItemType[] = transcriptMessages.map((message) => {
    const streaming = message.role === "assistant" && message.status === "running" &&
      streamedReply?.turnId === message.turnId;
    const streamedSegments = message.turnId ? timelineByTurn[message.turnId] ?? [] : [];
    // 刷新后用落库的过程快照还原每次思考、中间回复与工具调用；旧数据回退到工具摘要。
    const persistedSegments: ConversationTimelineSegment[] = [];
    if (message.process.length) {
      message.process.forEach((entry, index) => {
        if (entry.kind === "tool") {
          persistedSegments.push({
            kind: "tool",
            key: `persisted-${index}`,
            id: entry.id ?? `persisted-${index}`,
            call: {
              name: entry.name,
              input: entry.input,
              status: entry.status,
              durationMs: entry.durationMs,
            },
          });
        } else if (entry.kind === "context") {
          mergeContextNotice(persistedSegments, entry.id, entry.text, (key, text): ConversationTimelineSegment => ({ kind: "context", key, text }));
        } else if (entry.kind === "scheduleCard") {
          // 卡片单独渲染在过程块之外，这里不重复放进时间线。
        } else {
          persistedSegments.push({ kind: entry.kind, key: `persisted-${index}`, text: entry.text });
        }
      });
    } else {
      message.toolCalls.forEach((call, index) => persistedSegments.push({
        kind: "tool",
        key: `legacy-${index}`,
        id: `legacy-${index}`,
        call,
      }));
    }
    const timeline = (streamedSegments.length ? streamedSegments : persistedSegments)
      .filter((segment) => {
        if (segment.kind === "tool") return true;
        if (!segment.text.trim()) return false;
        // 最终回答已在助手气泡里展示，过程块里不再重复；中间回复照常保留。
        return !(streaming && segment.kind === "text" && streamedReply?.text.trim() === segment.text.trim());
      });
    // 运行中展示实时 exec 流；已结束则从落库输出回放，刷新后终端仍在。
    const execs = streaming
      ? (message.turnId ? execsByTurn[message.turnId] : undefined)
      : replayExecsFromProcess(message.process);
    // 实时事件与刷新后的过程快照可能同时存在，按内容去重。
    const cards: ScheduledTaskCard[] = [];
    const seenCards = new Set<string>();
    const rawCards = [
      ...(message.turnId ? scheduleCardsByTurn[message.turnId] ?? [] : []),
      ...message.process.flatMap((entry) => entry.kind === "scheduleCard" ? [entry.card] : []),
    ];
    for (const card of rawCards) {
      const key = JSON.stringify(card);
      if (seenCards.has(key)) continue;
      seenCards.add(key);
      cards.push(card);
    }
    return {
      key: message.id,
      role: message.role === "user" ? "user" : "ai",
      header: (
        <Space size={8} wrap>
          <Typography.Text strong>{message.role === "user" ? copy.userRole : copy.assistantRole}</Typography.Text>
          <Typography.Text type="secondary">{formatDate(message.createdAt, copy, locale)}</Typography.Text>
          {messageStatus(message, copy) ? <Tag>{messageStatus(message, copy)}</Tag> : null}
        </Space>
      ),
      content: <MessageContent
        message={message}
        copy={copy}
        locale={locale}
        cards={cards}
        streaming={streaming}
        timeline={timeline}
        waitingSince={streaming ? waitingSince : null}
        execs={execs}
        conversationId={selectedConversationId}
        onSuggestion={(text) => applySuggestion(text)}
        showSuggestions={message.id === lastMessageId}
      />,
      // 首 token 前的等待提示由 MessageContent 自己渲染，避免与 Bubble 的 loading 重复。
      loading: false,
      status: message.status === "failed" ? "error" : message.status === "completed" ? "success" : undefined,
    };
  });

  let userTurnNumber = 0;
  const turnNavItems = transcriptMessages.flatMap((message) => {
    if (message.role !== "user") return [];
    userTurnNumber += 1;
    return [{
      id: message.id,
      index: userTurnNumber,
      summary: message.content.trim().replace(/\s+/g, " ").slice(0, 120) || copy.none,
      createdAt: message.createdAt,
    }];
  });

  function handleTranscriptScroll() {
    const pane = transcriptPaneRef.current;
    if (!pane) return;
    const distance = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
    pinnedToBottom.current = distance < 72;
    setShowScrollBottom(distance > 160);
    const paneTop = pane.getBoundingClientRect().top;
    let active = turnNavItems[0]?.id ?? "";
    for (const item of turnNavItems) {
      const element = pane.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(item.id)}"]`);
      if (element && element.getBoundingClientRect().top - paneTop <= 80) active = item.id;
    }
    setActiveTurnNavId(active);
  }

  function scrollToTurn(turnId: string) {
    const pane = transcriptPaneRef.current;
    const target = pane?.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(turnId)}"]`);
    if (!pane || !target) return;
    const top = target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12;
    pane.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    pinnedToBottom.current = false;
    setShowScrollBottom(true);
    setActiveTurnNavId(turnId);
  }

  function scrollTranscriptToBottom() {
    const pane = transcriptPaneRef.current;
    if (!pane) return;
    pane.scrollTo({ top: pane.scrollHeight, behavior: "smooth" });
    pinnedToBottom.current = true;
    setShowScrollBottom(false);
  }

  useEffect(() => {
    if (!turnNavItems.length) {
      setActiveTurnNavId("");
      return;
    }
    // 初次进入或新消息到达时先高亮最新一轮，滚动后由 handleTranscriptScroll 修正。
    setActiveTurnNavId(turnNavItems[turnNavItems.length - 1]?.id ?? "");
  }, [turnNavItems.length]);

  // Bubble.List 关闭内置滚动后由整个对话窗格统一滚动：新消息/新 token 到达时只有
  // 用户还在底部附近才跟随，向上翻阅历史不会被强行拉回。
  // 切换工作区标签或切换对话时，无论之前是否在上翻历史，都回到最新一条消息。
  // 这个 effect 不依赖 transcript 节点：切到其它标签时它会被卸载，仍要记下导航变化。
  useEffect(() => {
    // 欢迎页从顶部阅读：分组提示词比旧版更高，自动滚到底会藏掉标题和仓库选择器。
    if (showCreate) return;
    const switched = lastTranscriptNav.current.conversationId !== selectedConversationId
      || lastTranscriptNav.current.tab !== detailTab;
    if (!switched) return;
    lastTranscriptNav.current = { conversationId: selectedConversationId, tab: detailTab };
    pinnedToBottom.current = true;
    forceScrollToLatest.current = true;
    setShowScrollBottom(false);
  }, [showCreate, selectedConversationId, detailTab]);

  useEffect(() => {
    if (showCreate) return;
    const pane = transcriptPaneRef.current;
    // 切到其它标签时 pane 被卸载，标记留到它重新挂载后再消费。
    if (!pane) return;
    // 只在 Chat 标签真正挂载时消费：切走的那一帧旧 pane 可能还在，提前消费会丢掉标记。
    if (forceScrollToLatest.current && detailTab === "chat") {
      forceScrollToLatest.current = false;
      pane.scrollTop = pane.scrollHeight;
      pinnedToBottom.current = true;
      setShowScrollBottom(false);
      return;
    }
    if (!pinnedToBottom.current) return;
    pane.scrollTop = pane.scrollHeight;
  }, [showCreate, selectedConversationId, detailTab, currentConversation?.messages.length, streamedReply?.text, timelineByTurn]);

  const composerSetup = showCreate ? (
    <div className="conversation-composer-setup">
      <span className="conversation-composer-model-label">{copy.composerProject}</span>
      <ProjectPicker
        copy={copy}
        value={project}
        disabled={busy}
        onChange={selectProject}
      />
      <span className="conversation-composer-model-label">{copy.branch}</span>
      <BranchPicker
        copy={copy}
        value={selectedBranch}
        projectId={project?.id}
        disabled={busy}
        onChange={setSelectedBranch}
      />
    </div>
  ) : null;

  return (
    <>
      {modalContextHolder}
      {error ? <ErrorBanner message={error} /> : null}
      <section className="conversations-layout" aria-label={copy.conversationsDescription}>
        <Group
          id="conversation-panels"
          className="conversation-panel-group"
          defaultLayout={savedLayout ?? { [workspacePanelId]: 100, [filesPanelId]: 0 }}
          onLayoutChanged={handleLayoutChanged}
        >
        <Panel id={workspacePanelId} className="conversation-workspace-panel" defaultSize={100} minSize={240}>
        <section className="conversation-workspace">
          <Tabs
            className="conversation-tabs"
            activeKey={detailTab}
            onChange={(key) => setDetailTab(key as ConversationDetailTab)}
            destroyOnHidden
            tabBarExtraContent={{
              // 仓库信息与标签页同处一行，减少纵向占用。
              right: (
                <div className="conversation-workspace-meta">
                  {showCreate ? (
                    <Typography.Text strong className="conversation-workspace-project">{copy.newConversation}</Typography.Text>
                  ) : currentConversation ? (
                    <>
                      <RepositoryInfoPopover
                        open={repoInfoOpen}
                        onOpenChange={setRepoInfoOpen}
                        projectId={currentConversation.projectId}
                        copy={copy}
                        currentBranch={currentConversation.targetBranch}
                        pinnedSha={currentConversation.messages.at(-1)?.headSha}
                        baseSha={currentConversation.baseSha}
                      >
                        <button
                          type="button"
                          className="conversation-workspace-repo"
                          aria-label={copy.conversationRepositoryInfo}
                          aria-expanded={repoInfoOpen}
                        >
                          <MiddleEllipsis text={currentConversation.projectName} className="conversation-workspace-project" />
                        </button>
                      </RepositoryInfoPopover>
                      {hasActiveTurn ? <Tag color="processing">{copy.statuses.running}</Tag> : null}
                      {changePaths.length ? (
                        <>
                          <Tag
                            className="conversation-changes-tag is-clickable"
                            title={changePaths.join("\n")}
                            role="button"
                            tabIndex={0}
                            onClick={() => setDetailTab("changes")}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setDetailTab("changes");
                              }
                            }}
                          >
                            {copy.conversationChangesTemplate.replace("{count}", String(changePaths.length))}
                          </Tag>
                          <Button
                            className="conversation-discard-changes"
                            type="link"
                            size="small"
                            disabled={hasActiveTurn}
                            onClick={() => confirmDiscardChanges()}
                          >
                            {copy.conversationDiscardChanges}
                          </Button>
                        </>
                      ) : null}
                    </>
                  ) : (
                    <Typography.Text strong className="conversation-workspace-project">{copy.conversationsTitle}</Typography.Text>
                  )}
                  <Button
                    className={`conversation-file-toggle${filesCollapsed ? "" : " is-active"}`}
                    type="text"
                    size="small"
                    aria-label={filesCollapsed ? copy.filePanelOpen : copy.filePanelClose}
                    aria-pressed={!filesCollapsed}
                    title={filesCollapsed ? copy.filePanelOpen : copy.filePanelClose}
                    onClick={toggleFilesPanel}
                  >
                    <FilesIcon />
                  </Button>
                </div>
              ),
            }}
            items={[
              {
                key: "chat",
                label: copy.conversationTabChat,
                children: (
                  <div className="conversation-chat">
                    <div
                      className={`conversation-transcript-pane${showCreate ? " conversation-setup-pane" : " has-turn-nav"}`}
                      ref={attachTranscriptPane}
                      onScroll={handleTranscriptScroll}
                    >
                      {!showCreate && currentConversation?.systemPrompt ? (
                        <ExpandableText
                          label={copy.traceSystemPrompt}
                          value={currentConversation.systemPrompt}
                          className="conversation-system-prompt"
                        />
                      ) : null}
                      {showCreate ? (
                        <div className="conversation-start">
                          <Welcome
                            className="conversation-welcome"
                            variant="borderless"
                            icon={<span className="conversation-welcome-icon" aria-hidden="true">C</span>}
                            title={copy.conversationWelcomeTitle}
                            description={copy.conversationWelcomeDescription}
                          />
                          <div className="conversation-welcome-setup">{composerSetup}</div>
                          <Prompts
                            className="conversation-prompts"
                            title={copy.conversationSuggestions}
                            items={suggestionItems}
                            wrap
                            onItemClick={({ data }) => applyPrompt(data.key)}
                          />
                        </div>
                      ) : currentConversation && bubbleItems.length ? (
                        <Bubble.List
                          className="conversation-transcript"
                          items={bubbleItems}
                          role={{
                            user: { placement: "end", variant: "filled" },
                            ai: { placement: "start", variant: "outlined" },
                          }}
                        />
                      ) : <Welcome className="conversation-welcome conversation-welcome-empty" variant="borderless" title={copy.conversationPlaceholder} />}
                    </div>
                    {!showCreate ? (
                      <ConversationTurnNav
                        items={turnNavItems}
                        activeId={activeTurnNavId}
                        copy={copy}
                        locale={locale}
                        onSelect={scrollToTurn}
                      />
                    ) : null}
                    <div
                      className={`conversation-composer-area${draggingAttachment ? " is-dragging-attachment" : ""}`}
                      onDragOver={(event) => {
                        if (showCreate || uploadingAttachment) return;
                        event.preventDefault();
                        setDraggingAttachment(true);
                      }}
                      onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingAttachment(false);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDraggingAttachment(false);
                        void uploadFiles(Array.from(event.dataTransfer.files));
                      }}
                    >
                    {draggingAttachment ? <div className="conversation-drop-overlay">{copy.dropFileHint}</div> : null}
                    {interjectNotice ? (
                      <div className={`conversation-interject-notice${interjectNotice === "delivered" ? " is-delivered" : ""}`} role="status">
                        {interjectNotice === "queued" ? copy.interjectQueued : copy.interjectDelivered}
                      </div>
                    ) : null}
                    {showScrollBottom ? (
                      <button
                        type="button"
                        className="conversation-scroll-bottom"
                        onClick={scrollTranscriptToBottom}
                        aria-label={copy.scrollToBottom}
                        title={copy.scrollToBottom}
                      >
                        <ScrollBottomIcon />
                        {copy.scrollToBottom}
                      </button>
                    ) : null}
                    {commandSuggestions.length ? (
                      <div ref={commandMenuRef} className="conversation-command-suggestions" aria-label={copy.commandHint}>
                        {commandSuggestions.map(({ command, description, fullDescription }, index) => (
                          <button
                            key={command}
                            type="button"
                            className={`conversation-command-suggestion${index === commandIndex ? " is-selected" : ""}`}
                            title={fullDescription}
                            onMouseEnter={() => setCommandIndex(index)}
                            onClick={() => {
                              setDraftMessage(`/${command} `);
                              setCommandIndex(0);
                              composerRef.current?.focus();
                            }}
                          >
                            <code>/{command}</code>
                            <span>{description}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {followUps.length ? (
                      <div className="conversation-followup-queue" aria-label={copy.followUpQueueLabel}>
                        <div className="conversation-followup-queue-head">
                          <span>{copy.followUpQueueLabel}</span>
                          <span>{copy.followUpQueueHint}</span>
                        </div>
                        {followUps.map((item, index) => (
                          <div className="conversation-followup-item" key={item.id}>
                            <span className="conversation-followup-index">{index + 1}</span>
                            <span className="conversation-followup-content" title={item.content}>
                              {item.content.replace(/\s+/g, " ").slice(0, 120)}
                            </span>
                            <button type="button" aria-label={copy.moveUp} title={copy.moveUp} disabled={index === 0} onClick={() => void changeFollowUp(item.id, "up")}>↑</button>
                            <button type="button" aria-label={copy.moveDown} title={copy.moveDown} disabled={index === followUps.length - 1} onClick={() => void changeFollowUp(item.id, "down")}>↓</button>
                            <button type="button" aria-label={copy.removeQueued} title={copy.removeQueued} onClick={() => void changeFollowUp(item.id, "remove")}>×</button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {attachments.length ? (
                      <div className="conversation-attachment-chips">
                        {attachments.map((item) => (
                          <span key={item.id} className="conversation-attachment-chip" title={item.filename}>
                            <FileIcon />
                            <span className="conversation-attachment-name">{item.filename}</span>
                            <button
                              type="button"
                              aria-label={`${copy.removeAttachment}: ${item.filename}`}
                              title={copy.removeAttachment}
                              onClick={() => void removeAttachment(item.id)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      multiple
                      accept="text/*,.md,.txt,.csv,.json,.jsonl,.yaml,.yml,.toml,.xml,.py,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.html,.htm,.css,.scss,.less,.java,.go,.rs,.c,.h,.cc,.cpp,.hpp,.cs,.rb,.php,.sh,.bash,.zsh,.sql,.lua,.swift,.kt,.scala,.vue,.svelte,.ini,.cfg,.conf,.env,.gitignore,.dockerfile,.gradle,.tf,.proto,.graphql"
                      style={{ display: "none" }}
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        void uploadFiles(files);
                      }}
                    />
                    <Sender
                      ref={composerRef}
                      className="conversation-composer"
                      style={{ width: "100%" }}
                      aria-label={copy.initialMessage}
                      value={draftMessage}
                      placeholder={showCreate ? copy.initialMessagePlaceholder : copy.replyPlaceholder}
                      disabled={busy}
                      autoSize={{ minRows: 3, maxRows: 10 }}
                      onChange={(value) => {
                        if (historyNavigation.current) historyNavigation.current = false;
                        else setHistoryIndex(-1);
                        setDraftMessage(value.slice(0, 20_000));
                      }}
                      onKeyDown={handleComposerKeyDown}
                      onSubmit={(message) => submitMessage(message)}
                      footer={(
                        <div className="conversation-composer-footer">
                          {!showCreate ? (
                            <button
                              type="button"
                              className="conversation-attach-button"
                              aria-label={copy.attachFile}
                              title={copy.attachFileHint}
                              disabled={busy || uploadingAttachment || attachments.length >= uploadLimits.maxPerMessage}
                              onClick={() => attachmentInputRef.current?.click()}
                            >
                              <AttachIcon />
                              <span>{uploadingAttachment ? copy.uploadingAttachment : copy.attachFile}</span>
                            </button>
                          ) : null}
                          <ComposerModelPicker copy={copy} disabled={busy} />
                        </div>
                      )}
                      suffix={(_node, { components: { SendButton } }) => (isTurnActive ? (
                        <div className="conversation-active-actions">
                          <button
                            type="button"
                            className="conversation-interject-button"
                            aria-label={copy.interject}
                            title={copy.interjectHint}
                            disabled={!canSend}
                            onClick={() => submitMessage(draftMessage)}
                          >
                            <InterjectIcon />
                            <span>{copy.interject}</span>
                          </button>
                          <Dropdown
                            trigger={["click"]}
                            placement="topRight"
                            menu={{
                              items: [
                                {
                                  key: "queue",
                                  label: copy.queue,
                                  title: copy.queueHint,
                                  disabled: !canSend,
                                },
                                {
                                  key: "interrupt",
                                  label: copy.interrupt,
                                  title: copy.interruptHint,
                                  disabled: !canSend || !activeTurnId,
                                },
                              ],
                              onClick: ({ key }) => {
                                if (key === "queue") submitMessage(draftMessage, "queue");
                                else if (key === "interrupt") submitMessage(draftMessage, "interrupt");
                              },
                            }}
                          >
                            <button
                              type="button"
                              className="conversation-active-more"
                              aria-label={copy.moreActions}
                              title={copy.moreActions}
                            >
                              <MoreIcon />
                            </button>
                          </Dropdown>
                          <button
                            type="button"
                            className="conversation-stop-button"
                            aria-label={cancelling ? copy.cancelTurning : copy.cancelTurn}
                            title={cancelling ? copy.cancelTurning : copy.cancelTurn}
                            disabled={cancelling}
                            onClick={() => void cancelActiveTurn()}
                          >
                            <StopIcon />
                          </button>
                        </div>
                      ) : (
                        <SendButton
                          aria-label={showCreate ? copy.createConversationLabel : copy.sendMessage}
                          disabled={!canSend}
                        />
                      ))}
                    />
                    {!showCreate && selectedConversationId ? (
                      <ContextBrief
                        conversationId={selectedConversationId}
                        copy={copy}
                        locale={locale}
                        refreshToken={refreshToken}
                        onOpen={() => setDetailTab("context")}
                      />
                    ) : null}
                    </div>
                  </div>
                ),
              },
              {
                key: "changes",
                label: copy.conversationTabChanges,
                children: (
                  <div className="conversation-tab-pane">
                    {selectedConversationId ? <ConversationGitChanges conversationId={selectedConversationId} copy={copy} /> : null}
                  </div>
                ),
              },
              {
                key: "context",
                label: copy.conversationTabContext,
                children: (
                  <div className="conversation-tab-pane">
                    {selectedConversationId ? (
                      <ContextPanel
                        conversationId={selectedConversationId}
                        copy={copy}
                        locale={locale}
                        refreshToken={refreshToken}
                      />
                    ) : null}
                  </div>
                ),
              },
              {
                key: "trace",
                label: copy.conversationTabTrace,
                children: (
                  <div className="conversation-tab-pane conversation-trace-pane">
                    <ConversationTraceTab
                      conversationId={selectedConversationId}
                      messages={currentConversation?.messages ?? []}
                      copy={copy}
                      locale={locale}
                      refreshToken={refreshToken}
                      onUpdated={onUpdated}
                    />
                  </div>
                ),
              },
              {
                key: "git",
                label: copy.conversationTabGit,
                children: (
                  <div className="conversation-tab-pane">
                    {selectedConversationId ? <ConversationGitGraph conversationId={selectedConversationId} copy={copy} /> : null}
                  </div>
                ),
              },
              {
                key: "executions",
                label: copy.conversationTabExecutions,
                children: (
                  <div className="conversation-tab-pane">
                    {selectedConversationId ? (
                      <ExecutionHistoryTab
                        conversationId={selectedConversationId}
                        copy={copy}
                        locale={locale}
                        refreshToken={refreshToken}
                      />
                    ) : null}
                  </div>
                ),
              },
              {
                key: "stats",
                label: copy.conversationTabStats,
                children: (
                  <div className="conversation-tab-pane">
                    <ConversationStatsTab
                      conversationId={selectedConversationId}
                      copy={copy}
                      locale={locale}
                      refreshToken={refreshToken}
                      onUpdated={onUpdated}
                    />
                  </div>
                ),
              },
              {
                key: "records",
                label: copy.traceRecords,
                children: (
                  <div className="conversation-tab-pane">
                    <ConversationRecordsTab
                      conversationId={selectedConversationId}
                      copy={copy}
                      locale={locale}
                      refreshToken={refreshToken}
                      onUpdated={onUpdated}
                    />
                  </div>
                ),
              },
            ]}
          />
        </section>
        </Panel>
        <Separator id="separator-workspace-files" className="conversation-separator" />
        <Panel
          id={filesPanelId}
          panelRef={filesPanelRef}
          className="conversation-files-panel"
          collapsible
          collapsedSize={0}
          defaultSize={340}
          minSize={220}
          maxSize={720}
        >
          {filesCollapsed ? null : (
            <ConversationFilePanel
              conversationId={selectedConversationId}
              copy={copy}
              onClose={toggleFilesPanel}
            />
          )}
        </Panel>
        </Group>
      </section>
    </>
  );
}
