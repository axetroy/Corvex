import { useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import { Button, Dropdown, Modal, Space, Tabs, Tag, Typography } from "antd";
import { Actions, Bubble, Conversations, Prompts, Sender, Welcome } from "@ant-design/x";
import type { BubbleItemType, ConversationItemType, PromptsItemType } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import "./ConversationsPage.css";
import { fetchJson, sendJson } from "../api.js";
import { streamConversationTurn } from "../stream.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatOutputTps, formatTraceDuration } from "../format.js";
import type { Copy, Locale } from "../i18n.js";
import { translate } from "../i18n.js";
import type { ConversationDetail, ConversationMessage, ConversationPage, ConversationStreamContext, ConversationStreamTool, ConversationSummary } from "../types.js";
import { activeQuickPrompts, welcomePromptGroups, welcomePromptText } from "../conversationPrompts.js";
import { conversationCommands } from "../../conversation-command.js";
import { ConversationRecordsTab } from "./ConversationRecordsTab.js";
import { ConversationStatsTab } from "./ConversationStatsTab.js";
import { ConversationTimeline, type ConversationTimelineSegment } from "./ConversationTimeline.js";
import { ConversationTraceTab } from "./ConversationTraceTab.js";
import { ComposerModelPicker } from "./ComposerModelPicker.js";
import { BranchPicker } from "./BranchPicker.js";
import { displayModelName } from "../modelLabel.js";
import { ProjectPicker } from "./ProjectPicker.js";
import { RepositoryInfoDrawer } from "./RepositoryInfoDrawer.js";
import { BookIcon, FilesIcon, RocketIcon, SearchIcon, SidebarCollapseIcon, SidebarExpandIcon, WrenchIcon } from "./icons.js";
import { ConversationFilePanel } from "./ConversationFilePanel.js";
import type { ProjectOption } from "../projectPicker.js";
import { Empty, ErrorBanner, ExpandableText } from "./common.js";

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
type ConversationDetailTab = "chat" | "records" | "trace" | "stats";

/** 对话列表每页条数。 */
const conversationPageSize = 50;
/** localStorage 中保存对话分组收起状态的键名。 */
const collapsedGroupsKey = "corvex-ops-conversation-collapsed-groups";
/** localStorage 中保存三个面板布局的键名（由 react-resizable-panels 管理）。 */
const panelLayoutKey = "corvex-ops-conversation-panels-layout";
const listPanelId = "conversation-list";
const workspacePanelId = "workspace";
const filesPanelId = "files";

/** 读取已收起的仓库分组；localStorage 不可用时回退为空集合。 */
function readCollapsedGroups(): Set<string> {
  try {
    const saved = window.localStorage.getItem(collapsedGroupsKey);
    if (saved) return new Set(JSON.parse(saved) as string[]);
  } catch (error) {
    window.console.warn("read conversation group preference failed", error);
  }
  return new Set();
}

/** 保存收起的仓库分组；隐私模式等场景下写入失败只记录告警。 */
function saveCollapsedGroups(collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(collapsedGroupsKey, JSON.stringify([...collapsed]));
  } catch (error) {
    window.console.warn("save conversation group preference failed", error);
  }
}

/** 读取已保存的面板布局；无效数据回退为默认布局。 */
function readPanelLayout(): Layout | undefined {
  try {
    const raw = window.localStorage.getItem(panelLayoutKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Layout;
    if (parsed && typeof parsed === "object" && Object.values(parsed).every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100,
    )) return parsed;
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
  if (message.status === "running") return copy.statuses.analyzing;
  if (message.status === "failed") return copy.statuses.failed;
  return "";
}

/** 对话模式标签文案；未知模式回退为原始值，避免界面留白。 */
function conversationModeText(mode: ConversationSummary["mode"], copy: Copy): string {
  return translate(copy.conversationModes, mode);
}

/** 按仓库 ID 取一个稳定的分组色，让相邻仓库在视觉上立刻能区分。 */
const conversationGroupColors = ["#4f8ef7", "#27a37a", "#b977e0", "#e0923a", "#e46a6a", "#38a8b8"];
function conversationGroupColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return conversationGroupColors[hash % conversationGroupColors.length]!;
}

/** 单条消息的正文：助手回复按 Markdown 渲染并提供复制，用户消息保持纯文本。 */
function MessageContent({
  message,
  copy,
  streaming,
  timeline,
}: {
  message: ConversationMessage;
  copy: Copy;
  streaming?: boolean;
  timeline: readonly ConversationTimelineSegment[];
}) {
  if (message.role === "user") {
    return <div className="conversation-message-text">{message.content}</div>;
  }
  // 回复仍在校验/生成中时不提供复制，避免复制到半成品内容。
  const settled = message.status === "completed" || message.status === "failed";
  return (
    <div className={`conversation-message-markdown${streaming && message.content ? " is-streaming" : ""}`}>
      {/* 先按发生顺序展示每次思考与工具调用，再展示最终回答。 */}
      <ConversationTimeline segments={timeline} active={Boolean(streaming)} copy={copy} />
      {/* 模型输出不可信：转义原始 HTML，并把链接放到新标签打开。 */}
      {message.content ? <XMarkdown content={message.content} escapeRawHtml openLinksInNewTab /> : null}
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
    </div>
  );
}

export function ConversationsPage({ conversationId, copy, locale, refreshToken, onUpdated, onRefresh, onConversationChange }: Props) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationOffset, setConversationOffset] = useState(0);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [selectedConversationId, setSelectedConversationId] = useState(conversationId);
  const selectedConversationIdRef = useRef(conversationId);
  const [conversation, setConversation] = useState<ConversationDetail>();
  const pendingReplyTurns = useRef(new Map<string, string>());
  const [pendingReplyConversations, setPendingReplyConversations] = useState<Set<string>>(() => new Set());
  const [pollToken, setPollToken] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(!conversationId);
  const [project, setProject] = useState<ProjectOption>();
  const [selectedBranch, setSelectedBranch] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [detailTab, setDetailTab] = useState<ConversationDetailTab>("chat");
  const [repoInfoOpen, setRepoInfoOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(readCollapsedGroups);
  const [savedLayout] = useState(readPanelLayout);
  const [listCollapsed, setListCollapsed] = useState((savedLayout?.[listPanelId] ?? 22) === 0);
  const [filesCollapsed, setFilesCollapsed] = useState((savedLayout?.[filesPanelId] ?? 0) === 0);
  const listPanelRef = usePanelRef();
  const filesPanelRef = usePanelRef();
  const replySubmitting = useRef(false);
  /** 正在流式输出的轮次与累计正文；仅在轮次运行中展示，落库后以详情为准。 */
  const [streamedReply, setStreamedReply] = useState<{ turnId: string; text: string }>();
  /** 逐条思考与工具调用按轮次留在本次页面会话里，结束后仍可展开查看。 */
  const [timelineByTurn, setTimelineByTurn] = useState<Record<string, ConversationTimelineSegment[]>>({});
  /** 对话流滚动容器：未滚离底部时跟随新内容，向上翻阅时不打断阅读。 */
  const transcriptPaneRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // 确认弹窗必须挂在 ConfigProvider 内，否则拿不到主题与 CSP nonce，样式会被浏览器拦掉。
  const [modal, modalContextHolder] = Modal.useModal();

  useEffect(() => {
    selectedConversationIdRef.current = conversationId;
    setSelectedConversationId(conversationId);
    setConversation(undefined);
    setShowCreate(!conversationId);
    setDraftMessage("");
    setDetailTab("chat");
    setError("");
    setTimelineByTurn({});
    pinnedToBottom.current = true;
  }, [conversationId]);

  useEffect(() => {
    let active = true;
    fetchJson<ConversationPage>(
      `/api/ops/conversations?limit=${conversationPageSize}&offset=${conversationOffset}&archived=${showArchived}`,
      copy,
    )
      .then((page) => {
        if (!active) return;
        setConversations((current) => {
          if (conversationOffset === 0) return page.items;
          const byId = new Map(current.map((item) => [item.id, item]));
          for (const item of page.items) byId.set(item.id, item);
          return [...byId.values()];
        });
        setConversationTotal(page.total);
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [copy, conversationOffset, refreshToken, pollToken, onUpdated, showArchived]);

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
  useEffect(() => {
    let active = true;
    if (!selectedConversationId) {
      setChangePaths([]);
      return () => { active = false; };
    }
    fetchJson<{ paths: string[] }>(
      `/api/ops/conversations/${encodeURIComponent(selectedConversationId)}/changes`, copy,
    ).then((result) => {
      if (active) setChangePaths(result.paths ?? []);
    }).catch(() => {
      if (active) setChangePaths([]);
    });
    return () => { active = false; };
  }, [copy, selectedConversationId, refreshToken, pollToken]);

  useEffect(() => {
    if (!hasActiveTurn && !pendingReplyConversations.has(selectedConversationId)) return;
    const timer = window.setInterval(() => setPollToken((value) => value + 1), 2_500);
    return () => window.clearInterval(timer);
  }, [hasActiveTurn, pendingReplyConversations, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId || !activeTurnId) {
      setStreamedReply(undefined);
      return;
    }
    const controller = new AbortController();
    let closed = false;
    let latestText = "";
    const segments: ConversationTimelineSegment[] = [];
    let flushTimer: number | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!closed) {
        setStreamedReply({ turnId: activeTurnId, text: latestText });
        setTimelineByTurn((current) => ({ ...current, [activeTurnId]: [...segments] }));
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
      } else {
        updateLast("thinking", text);
      }
      schedule();
    };
    const onContext = (notice: ConversationStreamContext) => {
      const key = `context-${notice.id}`;
      const existing = segments.find((segment) => segment.kind === "context" && segment.key === key);
      if (existing?.kind === "context") existing.text = notice.text;
      else segments.push({ kind: "context", key, text: notice.text });
      schedule();
    };
    const onTool = (tool: ConversationStreamTool) => {
      const call = { name: tool.name, input: tool.input, status: tool.status, durationMs: tool.durationMs };
      const existing = segments.find((segment) => segment.kind === "tool" && segment.id === tool.id);
      if (existing?.kind === "tool") existing.call = call;
      else segments.push({ kind: "tool", key: `tool-${tool.id}`, id: tool.id, call });
      schedule();
    };
    setStreamedReply({ turnId: activeTurnId, text: "" });
    void streamConversationTurn(
      selectedConversationId,
      activeTurnId,
      {
        onText: (text, reset) => {
          latestText = reset ? "" : text;
          // 工具调用之间的中间回复也算过程的一部分，按轮次单独成条。
          if (reset) segments.push({ kind: "text", key: `text-${segments.length}`, text });
          else updateLast("text", text);
          schedule();
        },
        onThinking,
        onTool,
        onContext,
        onDone: () => {
          if (flushTimer !== undefined) window.clearTimeout(flushTimer);
          flushTimer = undefined;
          flush();
          setPollToken((value) => value + 1);
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
    });
    return () => {
      closed = true;
      controller.abort();
      if (flushTimer !== undefined) window.clearTimeout(flushTimer);
    };
  }, [selectedConversationId, activeTurnId]);

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
      setConversationOffset(0);
      setPollToken((value) => value + 1);
      onRefresh();
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(message: string) {
    if (!currentConversation || !message.trim() || hasActiveTurn || busy || replySubmitting.current || pendingReplyConversations.has(currentConversation.id)) return;
    const replyConversationId = currentConversation.id;
    replySubmitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await fetch(`/api/ops/conversations/${encodeURIComponent(replyConversationId)}/messages`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ message, responseLanguage: locale === "zh-CN" ? "zh-CN" : "en" }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        if (result.status === 409) {
          const body = await result.json() as { error?: unknown };
          if (body.error === "conversation already has an active turn") {
            throw new Error(copy.conversationTurnActive);
          }
          throw new Error(copy.targetChanged);
        }
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      const queued = await result.json() as { turnId: string };
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

  async function changeArchived(item: ConversationSummary, archived: boolean) {
    setError("");
    try {
      const result = await fetch(`/api/ops/conversations/${encodeURIComponent(item.id)}/archive`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ archived }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      setConversationOffset(0);
      setPollToken((value) => value + 1);
      onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function confirmDelete(item: ConversationSummary) {
    modal.confirm({
      title: copy.conversationDeleteConfirm,
      content: copy.conversationDeleteConfirmDescription,
      okType: "danger",
      onOk: async () => {
        setError("");
        try {
          const result = await fetch(`/api/ops/conversations/${encodeURIComponent(item.id)}`, {
            method: "DELETE",
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(20_000),
          });
          if (!result.ok) {
            throw new Error(copy.requestFailedTemplate
              .replace("{status}", String(result.status))
              .replace("{message}", (await result.text()).trim() || result.statusText));
          }
          if (selectedConversationIdRef.current === item.id) {
            onConversationChange("");
            setSelectedConversationId("");
            selectedConversationIdRef.current = "";
            setConversation(undefined);
            setShowCreate(true);
            setDraftMessage("");
          }
          setPollToken((value) => value + 1);
          onRefresh();
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  function startNewConversation() {
    setSelectedConversationId("");
    selectedConversationIdRef.current = "";
    onConversationChange("");
    setConversation(undefined);
    setShowCreate(true);
    setProject(undefined);
    setSelectedBranch("");
    setDraftMessage("");
    setError("");
  }

  function openConversation(key: string) {
    if (!key || key === selectedConversationIdRef.current) return;
    setSelectedConversationId(key);
    selectedConversationIdRef.current = key;
    setConversation(undefined);
    setDraftMessage("");
    setError("");
    setTimelineByTurn({});
    pinnedToBottom.current = true;
    onConversationChange(key);
    setShowCreate(false);
  }

  function submitMessage(message: string) {
    if (showCreate) void createConversation(message);
    else void sendReply(message);
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
    if (text) setDraftMessage(text.slice(0, 20_000));
  };
  const quickPrompts = activeQuickPrompts(copy);
  // 输入框以 "/" 开头且还没有空格时展示指令补全；普通路径文本不会被误判。
  const commandQuery = /^\/[a-z]*$/.test(draftMessage) ? draftMessage.slice(1).toLowerCase() : null;
  const commandSuggestions = commandQuery === null
    ? []
    : conversationCommands.filter((command) => command.startsWith(commandQuery));
  const canReply = Boolean(currentConversation && !hasActiveTurn && !pendingReplyConversations.has(selectedConversationId));

  // 面板的展开/收起交给 react-resizable-panels，自带键盘操作与尺寸约束。
  function toggleListPanel() {
    const panel = listPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }

  function toggleFilesPanel() {
    const panel = filesPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }

  function handleLayoutChanged(layout: Layout, meta: { requestedLayout?: Layout }) {
    savePanelLayout(meta.requestedLayout ?? layout);
    setListCollapsed((layout[listPanelId] ?? 0) === 0);
    setFilesCollapsed((layout[filesPanelId] ?? 0) === 0);
  }

  // 列表按最近更新排序：分组按首次出现的顺序排列，因此每组及其内部都是最近优先。
  const sortedConversations = [...conversations].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
  const projectNames = new Map<string, string>();
  const conversationItems: ConversationItemType[] = sortedConversations.map((item) => {
    const group = `${item.projectId}`;
    projectNames.set(group, item.projectName);
    const running = item.lastTurnStatus === "queued" || item.lastTurnStatus === "running";
    return {
      key: item.id,
      group,
      label: (
        <Dropdown
          trigger={["contextMenu"]}
          menu={{
            items: [
              {
                key: "archive",
                label: item.archived ? copy.conversationMenuUnarchive : copy.conversationMenuArchive,
              },
              { key: "delete", label: copy.conversationMenuDelete, danger: true },
            ],
            onClick: ({ key }) => {
              if (key === "archive") void changeArchived(item, !item.archived);
              else confirmDelete(item);
            },
          }}
        >
          <div
            className={`conversation-summary-label${item.archived ? " is-archived" : ""}`}
            title={item.archived ? copy.conversationArchived : undefined}
          >
            <Typography.Text ellipsis>{item.title || item.projectName}</Typography.Text>
            {running ? <span className="conversation-summary-active" aria-label={copy.statuses.analyzing} /> : null}
          </div>
        </Dropdown>
      ),
    };
  });
  // 新仓库分组默认展开：只把用户明确收起的分组从展开列表里剔除，并按当前列表收敛旧记录。
  const groupKeys = [...new Set(conversationItems.map((item) => item.group!))];
  const expandedGroups = groupKeys.filter((group) => !collapsedGroups.has(group));
  const transcriptMessages = (currentConversation?.messages ?? []).map((message) =>
    message.role === "assistant" && message.status === "running" && streamedReply?.turnId === message.turnId
      ? { ...message, content: streamedReply.text }
      : message,
  );
  const bubbleItems: BubbleItemType[] = transcriptMessages.map((message) => {
    const streaming = message.role === "assistant" && message.status === "running" &&
      streamedReply?.turnId === message.turnId;
    const streamedSegments = message.turnId ? timelineByTurn[message.turnId] ?? [] : [];
    // 刷新后用落库的过程快照还原每次思考、中间回复与工具调用；旧数据回退到工具摘要。
    const persistedSegments: ConversationTimelineSegment[] = message.process.length
      ? message.process.map((entry, index) => entry.kind === "tool"
          ? {
              kind: "tool",
              key: `persisted-${index}`,
              id: entry.id ?? `persisted-${index}`,
              call: {
                name: entry.name,
                input: entry.input,
                status: entry.status,
                durationMs: entry.durationMs,
              },
            }
          : { kind: entry.kind, key: `persisted-${index}`, text: entry.text })
      : message.toolCalls.map((call, index) => ({
          kind: "tool",
          key: `legacy-${index}`,
          id: `legacy-${index}`,
          call,
        }));
    const timeline = (streamedSegments.length ? streamedSegments : persistedSegments)
      .filter((segment) => {
        if (segment.kind === "tool") return true;
        if (!segment.text.trim()) return false;
        // 最终回答已在助手气泡里展示，过程块里不再重复；中间回复照常保留。
        return !(streaming && segment.kind === "text" && streamedReply?.text.trim() === segment.text.trim());
      });
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
      content: <MessageContent message={message} copy={copy} streaming={streaming} timeline={timeline} />,
      // 有思考、正文或工具记录后改为展示内容，避免 loading 覆盖正在进行的读取过程。
      loading: message.role === "assistant" && !message.content && timeline.length === 0 &&
        (message.status === "queued" || message.status === "running"),
      status: message.status === "failed" ? "error" : message.status === "completed" ? "success" : undefined,
    };
  });

  function handleTranscriptScroll() {
    const pane = transcriptPaneRef.current;
    if (!pane) return;
    pinnedToBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 72;
  }

  // Bubble.List 关闭内置滚动后由整个对话窗格统一滚动：新消息/新 token 到达时只有
  // 用户还在底部附近才跟随，向上翻阅历史不会被强行拉回。
  useEffect(() => {
    // 欢迎页从顶部阅读：分组提示词比旧版更高，自动滚到底会藏掉标题和仓库选择器。
    if (showCreate) return;
    const pane = transcriptPaneRef.current;
    if (!pane || !pinnedToBottom.current) return;
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
          defaultLayout={savedLayout ?? { [listPanelId]: 25, [workspacePanelId]: 75, [filesPanelId]: 0 }}
          onLayoutChanged={handleLayoutChanged}
        >
        <Panel
          id={listPanelId}
          panelRef={listPanelRef}
          className="conversation-list-panel"
          collapsible
          collapsedSize={0}
          defaultSize={288}
          minSize={190}
          maxSize={480}
        >
        <aside className="conversation-sidebar" aria-label={copy.conversationList}>
          <div className="conversation-sidebar-heading">
            <Button className="conversation-new-button" type="primary" onClick={startNewConversation}>
              <span aria-hidden="true">+</span>
              {copy.newConversation}
            </Button>
            <Button
              className={`conversation-archived-toggle${showArchived ? " is-active" : ""}`}
              type="text"
              size="small"
              aria-pressed={showArchived}
              onClick={() => {
                setShowArchived((value) => !value);
                setConversationOffset(0);
              }}
            >
              {showArchived ? copy.conversationShowActive : copy.conversationShowArchived}
            </Button>
          </div>
          {listCollapsed ? null : <div className="conversation-sidebar-list">
            {conversationItems.length ? (
              <Conversations
                items={conversationItems}
                activeKey={selectedConversationId || undefined}
                onActiveChange={(key) => {
                  // Ant Design X 点击当前项会回调空值表示取消选中；会话页必须保持选中。
                  if (key) openConversation(key);
                }}
                groupable={{
                  label: (group) => (
                    <span className="conversation-group-label">
                      <span
                        className="conversation-group-dot"
                        style={{ backgroundColor: conversationGroupColor(String(group)) }}
                        aria-hidden="true"
                      />
                      <span className="conversation-group-name">{projectNames.get(String(group)) ?? String(group)}</span>
                    </span>
                  ),
                  collapsible: true,
                  expandedKeys: expandedGroups,
                  onExpand: (keys) => {
                    const collapsed = new Set(groupKeys.filter((group) => !keys.includes(group)));
                    setCollapsedGroups(collapsed);
                    saveCollapsedGroups(collapsed);
                  },
                }}
              />
            ) : <Empty>{copy.noConversations}</Empty>}
            {conversations.length < conversationTotal ? (
              <Button className="conversation-load-more" type="text" onClick={() => setConversationOffset((value) => value + conversationPageSize)}>
                {copy.loadMore}
              </Button>
            ) : null}
          </div>}
        </aside>
        </Panel>
        <Separator id="separator-list-workspace" className="conversation-separator" />
        <Panel id={workspacePanelId} className="conversation-workspace-panel" defaultSize={620} minSize={240}>
        <section className="conversation-workspace">
          <Tabs
            className="conversation-tabs"
            activeKey={detailTab}
            onChange={(key) => setDetailTab(key as ConversationDetailTab)}
            destroyOnHidden
            tabBarExtraContent={{
              // 展开/收起按钮放在「对话」标签之前；收起后列表完全隐藏。
              left: (
                <Button
                  className="conversation-list-toggle"
                  type="text"
                  size="small"
                  aria-label={listCollapsed ? copy.expandConversationList : copy.collapseConversationList}
                  aria-expanded={!listCollapsed}
                  title={listCollapsed ? copy.expandConversationList : copy.collapseConversationList}
                  onClick={toggleListPanel}
                >
                  {listCollapsed ? <SidebarExpandIcon /> : <SidebarCollapseIcon />}
                </Button>
              ),
              // 仓库信息与标签页同处一行，减少纵向占用。
              right: (
                <div className="conversation-workspace-meta">
                  {showCreate ? (
                    <Typography.Text strong className="conversation-workspace-project">{copy.newConversation}</Typography.Text>
                  ) : currentConversation ? (
                    <>
                      <button
                        type="button"
                        className="conversation-workspace-repo"
                        onClick={() => setRepoInfoOpen(true)}
                        aria-label={copy.conversationRepositoryInfo}
                      >
                        <Typography.Text strong className="conversation-workspace-project" ellipsis>
                          {currentConversation.projectName}
                        </Typography.Text>
                      </button>
                      <Tag className="conversation-branch-tag">{currentConversation.targetBranch}</Tag>
                      <Tag className="conversation-mode-tag">{conversationModeText(currentConversation.mode, copy)}</Tag>
                      <Typography.Text type="secondary" className="conversation-pinned">
                        {copy.pinnedRevision}: <code>{currentConversation.messages.at(-1)?.headSha?.slice(0, 12) ?? copy.none}</code>
                      </Typography.Text>
                      {hasActiveTurn ? <Tag color="processing">{copy.statuses.analyzing}</Tag> : null}
                      {changePaths.length ? (
                        <>
                          <Tag className="conversation-changes-tag" title={changePaths.join("\n")}>
                            {copy.conversationChangesTemplate.replace("{count}", String(changePaths.length))}
                          </Tag>
                          <Button
                            className="conversation-discard-changes"
                            type="link"
                            size="small"
                            disabled={hasActiveTurn}
                            onClick={() => void (async () => {
                              try {
                                await sendJson(
                                  `/api/ops/conversations/${encodeURIComponent(selectedConversationId)}/changes`,
                                  {}, copy, "DELETE",
                                );
                                setChangePaths([]);
                                setPollToken((value) => value + 1);
                              } catch (cause) {
                                setError(errorMessage(cause));
                              }
                            })()}
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
                      className={`conversation-transcript-pane${showCreate ? " conversation-setup-pane" : ""}`}
                      ref={transcriptPaneRef}
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
                    <div className="conversation-composer-area">
                    {!showCreate && currentConversation && bubbleItems.length ? (
                      <div className="conversation-quick-prompts">
                        <span className="conversation-quick-prompts-label">{copy.conversationQuickPrompts}</span>
                        <div className="conversation-quick-prompts-list">
                          {quickPrompts.map((prompt) => (
                            <button
                              key={prompt.key}
                              type="button"
                              className="conversation-quick-prompt"
                              disabled={!canReply}
                              title={prompt.label}
                              onClick={() => setDraftMessage(prompt.label.slice(0, 20_000))}
                            >
                              {prompt.label.split(/\s+/)[0]}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {commandSuggestions.length ? (
                      <div className="conversation-command-suggestions" aria-label={copy.commandHint}>
                        {commandSuggestions.map((command) => (
                          <button
                            key={command}
                            type="button"
                            className="conversation-command-suggestion"
                            onClick={() => setDraftMessage(`/${command} `)}
                          >
                            <code>/{command}</code>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <Sender
                      className="conversation-composer"
                      style={{ width: "100%" }}
                      aria-label={copy.initialMessage}
                      value={draftMessage}
                      placeholder={showCreate ? copy.initialMessagePlaceholder : copy.replyPlaceholder}
                      disabled={busy || (showCreate ? !project : !canReply)}
                      autoSize={{ minRows: 3, maxRows: 10 }}
                      onChange={(value) => setDraftMessage(value.slice(0, 20_000))}
                      onSubmit={submitMessage}
                      footer={<ComposerModelPicker copy={copy} disabled={busy} />}
                      suffix={(_node, { components: { SendButton } }) => (
                        <SendButton aria-label={showCreate ? copy.createConversationLabel : copy.sendMessage} />
                      )}
                    />
                    </div>
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
      <RepositoryInfoDrawer
        open={repoInfoOpen}
        onClose={() => setRepoInfoOpen(false)}
        projectId={currentConversation?.projectId ?? 0}
        copy={copy}
        currentBranch={currentConversation?.targetBranch}
        pinnedSha={currentConversation?.messages.at(-1)?.headSha}
      />
    </>
  );
}
