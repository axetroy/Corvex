import { useEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { Button, Select, Space, Tag, Tooltip, Typography } from "antd";
import { Actions, Bubble, Conversations, Prompts, Sender, Welcome } from "@ant-design/x";
import type { BubbleItemType, ConversationItemType, PromptsItemType } from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import "./ConversationsPage.css";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate } from "../format.js";
import type { Copy, Locale } from "../i18n.js";
import type { Conversation, ConversationMessage, ConversationPage, ConversationSummary } from "../types.js";
import { ConversationTurnDrawer } from "./ConversationTurnDrawer.js";
import { Empty, ErrorBanner } from "./common.js";

interface ProjectOption {
  id: number;
  name?: string;
  path_with_namespace?: string;
  default_branch?: string;
}

interface BranchOption {
  name: string;
  commit: { id: string };
}

interface ProjectSelectOption {
  value: number;
  label: string;
  meta?: string;
}

interface BranchSelectOption {
  value: string;
  label: string;
  meta?: string;
}

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
  onConversationChange: (conversationId: string) => void;
}

/** 对话列表每页条数。 */
const conversationPageSize = 50;
/** GitLab 项目/分支搜索每页条数，与服务端 `per_page` 保持一致。 */
const listPageSize = 50;

/** 判断下拉列表是否已滚动到底部，用于追加下一页。 */
function atListBottom(event: UIEvent<HTMLDivElement>): boolean {
  const target = event.currentTarget;
  return target.scrollTop + target.offsetHeight >= target.scrollHeight - 8;
}

/** 消息处理状态对应的界面文案；完成状态不展示徽标。 */
function messageStatus(message: ConversationMessage, copy: Copy): string {
  if (message.status === "queued") return copy.statuses.queued;
  if (message.status === "running") return copy.statuses.analyzing;
  if (message.status === "failed") return copy.statuses.failed;
  return "";
}

/** 最近一轮状态对应的徽标颜色；无轮次返回中性色。 */
function lastTurnColor(status: ConversationSummary["lastTurnStatus"]): string {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "queued" || status === "running") return "processing";
  return "default";
}

/** 单条消息的正文：助手回复按 Markdown 渲染并提供复制，用户消息保持纯文本。 */
function MessageContent({ message, copy }: { message: ConversationMessage; copy: Copy }) {
  if (message.role === "user") {
    return <div className="conversation-message-text">{message.content}</div>;
  }
  // 回复仍在校验/生成中时不提供复制，避免复制到半成品内容。
  const settled = message.status === "completed" || message.status === "failed";
  return (
    <div className="conversation-message-markdown">
      {/* 模型输出不可信：转义原始 HTML，并把链接放到新标签打开。 */}
      <XMarkdown content={message.content} escapeRawHtml openLinksInNewTab />
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
  const [conversation, setConversation] = useState<Conversation>();
  const pendingReplyJobs = useRef(new Map<string, string>());
  const [pendingReplyConversations, setPendingReplyConversations] = useState<Set<string>>(() => new Set());
  const [pollToken, setPollToken] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(!conversationId);
  const [projectQuery, setProjectQuery] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectPage, setProjectPage] = useState(0);
  const [projectHasMore, setProjectHasMore] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const [project, setProject] = useState<ProjectOption>();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchPage, setBranchPage] = useState(0);
  const [branchHasMore, setBranchHasMore] = useState(false);
  const [branchLoading, setBranchLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [turnJobId, setTurnJobId] = useState("");
  const projectSearchRequest = useRef(0);
  const branchSearchRequest = useRef(0);
  const replySubmitting = useRef(false);

  useEffect(() => {
    selectedConversationIdRef.current = conversationId;
    setSelectedConversationId(conversationId);
    setConversation(undefined);
    setShowCreate(!conversationId);
    setDraftMessage("");
    setError("");
  }, [conversationId]);

  useEffect(() => {
    let active = true;
    fetchJson<ConversationPage>(`/api/ops/conversations?limit=${conversationPageSize}&offset=${conversationOffset}`, copy)
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
  }, [copy, conversationOffset, refreshToken, onUpdated]);

  useEffect(() => {
    if (!selectedConversationId) {
      setConversation(undefined);
      return;
    }
    let active = true;
    fetchJson<Conversation>(`/api/ops/conversations/${encodeURIComponent(selectedConversationId)}`, copy)
      .then((value) => {
        if (!active) return;
        setConversation(value);
        const pendingJobId = pendingReplyJobs.current.get(value.id);
        if (pendingJobId && value.messages.some((message) => message.jobId === pendingJobId)) {
          pendingReplyJobs.current.delete(value.id);
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

  useEffect(() => {
    if (!hasActiveTurn && !pendingReplyConversations.has(selectedConversationId)) return;
    const timer = window.setInterval(() => setPollToken((value) => value + 1), 2_500);
    return () => window.clearInterval(timer);
  }, [hasActiveTurn, pendingReplyConversations, selectedConversationId]);

  async function loadProjects(query: string, page: number, append: boolean) {
    const requestId = ++projectSearchRequest.current;
    setProjectLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ search: query.trim(), page: String(page) });
      const result = await fetchJson<ProjectOption[]>(`/api/ops/projects?${params}`, copy);
      if (requestId !== projectSearchRequest.current) return;
      setProjects((current) => (append ? [...current, ...result] : result));
      setProjectPage(page);
      setProjectHasMore(result.length >= listPageSize);
    } catch (cause) {
      if (requestId === projectSearchRequest.current) setError(errorMessage(cause));
    } finally {
      if (requestId === projectSearchRequest.current) setProjectLoading(false);
    }
  }

  async function loadBranches(value: ProjectOption, query: string, page: number, append: boolean) {
    const requestId = ++branchSearchRequest.current;
    setBranchLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ search: query.trim(), page: String(page) });
      const result = await fetchJson<BranchOption[]>(`/api/ops/projects/${value.id}/branches?${params}`, copy);
      if (requestId !== branchSearchRequest.current) return;
      setBranches((current) => (append ? [...current, ...result] : result));
      setBranchPage(page);
      setBranchHasMore(result.length >= listPageSize);
    } catch (cause) {
      if (requestId === branchSearchRequest.current) setError(errorMessage(cause));
    } finally {
      if (requestId === branchSearchRequest.current) setBranchLoading(false);
    }
  }

  function selectProject(id: number) {
    const value = projects.find((item) => item.id === id);
    if (!value) return;
    setProject(value);
    setSelectedBranch(value.default_branch ?? "");
    setBranches([]);
    setBranchQuery("");
    setBranchPage(0);
    setBranchHasMore(false);
    setError("");
    void loadBranches(value, "", 1, false);
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
        body: JSON.stringify({ projectId: project.id, targetBranch: selectedBranch, message }),
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
        body: JSON.stringify({ message }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        if (result.status === 409) {
          const body = await result.json() as { error?: unknown };
          if (body.error === "chat conversation already has an active message") {
            throw new Error(copy.conversationTurnActive);
          }
          throw new Error(copy.targetChanged);
        }
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      const queued = await result.json() as { jobId: string };
      pendingReplyJobs.current.set(replyConversationId, queued.jobId);
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

  function startNewConversation() {
    setSelectedConversationId("");
    selectedConversationIdRef.current = "";
    onConversationChange("");
    setConversation(undefined);
    setShowCreate(true);
    setProjectQuery("");
    setProjects([]);
    setProjectPage(0);
    setProjectHasMore(false);
    setProject(undefined);
    setBranches([]);
    setBranchPage(0);
    setBranchHasMore(false);
    setSelectedBranch("");
    setBranchQuery("");
    setDraftMessage("");
    setError("");
  }

  function openConversation(key: string) {
    setSelectedConversationId(key);
    selectedConversationIdRef.current = key;
    setConversation(undefined);
    setDraftMessage("");
    setError("");
    onConversationChange(key);
    setShowCreate(false);
  }

  function submitMessage(message: string) {
    if (showCreate) void createConversation(message);
    else void sendReply(message);
  }

  const projectOptions: ProjectSelectOption[] = projects.map((item) => ({
    value: item.id,
    label: item.path_with_namespace ?? item.name ?? String(item.id),
    meta: item.name && item.name !== item.path_with_namespace ? item.name : undefined,
  }));
  const branchOptions: BranchSelectOption[] = branches.map((item) => ({
    value: item.name,
    label: item.name,
    meta: item.commit.id.slice(0, 12),
  }));
  const suggestionItems: PromptsItemType[] = [
    { key: "explain", label: copy.conversationPromptExplain },
    { key: "locate", label: copy.conversationPromptLocate },
    { key: "improve", label: copy.conversationPromptImprove },
    { key: "onboard", label: copy.conversationPromptOnboard },
  ];
  const canReply = Boolean(currentConversation && !hasActiveTurn && !pendingReplyConversations.has(selectedConversationId));

  const conversationItems: ConversationItemType[] = conversations.map((item) => ({
    key: item.id,
    label: (
      <div className="conversation-summary-label">
        <Typography.Text strong ellipsis>{item.projectName}</Typography.Text>
        <Typography.Text type="secondary" ellipsis>{item.targetBranch}</Typography.Text>
        <div className="conversation-summary-meta">
          <Tag className="conversation-summary-turns" color={lastTurnColor(item.lastTurnStatus)}>
            {(item.turnCount === 1 ? copy.conversationTurnTemplate : copy.conversationTurnsTemplate).replace("{count}", String(item.turnCount))}
          </Tag>
          <Typography.Text type="secondary" className="conversation-summary-time">
            {formatDate(item.updatedAt, copy, locale)}
          </Typography.Text>
        </div>
      </div>
    ),
  }));
  const bubbleItems: BubbleItemType[] = (currentConversation?.messages ?? []).map((message) => {
    const showTurn = message.role === "assistant" && Boolean(message.jobId) && (message.traceCount > 0 || message.eventCount > 0);
    return {
      key: message.id,
      role: message.role === "user" ? "user" : "ai",
      header: (
        <Space size={8} wrap>
          <Typography.Text strong>{message.role === "user" ? copy.userRole : copy.assistantRole}</Typography.Text>
          <Typography.Text type="secondary">{formatDate(message.createdAt, copy, locale)}</Typography.Text>
          {messageStatus(message, copy) ? <Tag>{messageStatus(message, copy)}</Tag> : null}
          {showTurn ? (
            <Tooltip title={copy.conversationTurnTooltip}>
              <Button
                className="conversation-turn-button"
                type="link"
                size="small"
                onClick={() => setTurnJobId(message.jobId ?? "")}
              >
                {copy.conversationTurnButton}
              </Button>
            </Tooltip>
          ) : null}
        </Space>
      ),
      content: <MessageContent message={message} copy={copy} />,
      loading: message.role === "assistant" && !message.content && (message.status === "queued" || message.status === "running"),
      status: message.status === "failed" ? "error" : message.status === "completed" ? "success" : undefined,
    };
  });

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <section className="conversations-layout" aria-label={copy.conversationsDescription}>
        <aside className="conversation-sidebar" aria-label={copy.conversationList}>
          <div className="conversation-sidebar-heading">
            <Typography.Text strong className="conversation-sidebar-title">{copy.conversationsTitle}</Typography.Text>
            <Button className="conversation-new-button" type="primary" onClick={startNewConversation}>
              <span aria-hidden="true">+</span>
              {copy.newConversation}
            </Button>
          </div>
          <div className="conversation-sidebar-list">
            {conversationItems.length ? (
              <Conversations
                items={conversationItems}
                activeKey={selectedConversationId || undefined}
                onActiveChange={(key) => openConversation(key)}
              />
            ) : <Empty>{copy.noConversations}</Empty>}
            {conversations.length < conversationTotal ? (
              <Button className="conversation-load-more" type="text" onClick={() => setConversationOffset((value) => value + conversationPageSize)}>
                {copy.loadMore}
              </Button>
            ) : null}
          </div>
        </aside>
        <section className="conversation-workspace">
          <div className="conversation-workspace-heading">
            {showCreate ? (
              <Typography.Text strong className="conversation-workspace-title">{copy.newConversation}</Typography.Text>
            ) : currentConversation ? (
              <div className="conversation-workspace-title">
                <Space size={8} wrap>
                  <Typography.Text strong>{currentConversation.projectName}</Typography.Text>
                  <Tag className="conversation-branch-tag">{currentConversation.targetBranch}</Tag>
                </Space>
                <Typography.Text type="secondary" className="conversation-pinned">
                  {copy.pinnedRevision}: <code>{currentConversation.messages.at(-1)?.headSha ?? copy.none}</code>
                </Typography.Text>
              </div>
            ) : <Typography.Text strong className="conversation-workspace-title">{copy.conversationsTitle}</Typography.Text>}
            {hasActiveTurn ? <Tag color="processing">{copy.statuses.analyzing}</Tag> : null}
          </div>
          <div className="conversation-chat">
            <div className={`conversation-transcript-pane${showCreate ? " conversation-setup-pane" : ""}`}>
              {showCreate ? (
                <div className="conversation-start">
                  <Welcome
                    className="conversation-welcome"
                    variant="borderless"
                    icon={<span className="conversation-welcome-icon" aria-hidden="true">C</span>}
                    title={copy.conversationWelcomeTitle}
                    description={copy.conversationWelcomeDescription}
                  />
                  <div className="conversation-picker-row">
                    <Select<number, ProjectSelectOption>
                      className="conversation-select"
                      aria-label={copy.projectSearch}
                      showSearch
                      filterOption={false}
                      placeholder={copy.projectSearchPlaceholder}
                      value={project?.id}
                      loading={projectLoading}
                      options={projectOptions}
                      notFoundContent={<span className="conversation-select-empty">{projectQuery ? copy.noProjects : copy.chooseProject}</span>}
                      optionRender={(option) => (
                        <div className="conversation-option">
                          <span className="conversation-option-label">{option.data.label}</span>
                          {option.data.meta ? <span className="conversation-option-meta">{option.data.meta}</span> : null}
                        </div>
                      )}
                      onOpenChange={(open) => {
                        if (open && projects.length === 0) void loadProjects("", 1, false);
                      }}
                      onSearch={(value) => {
                        setProjectQuery(value);
                        void loadProjects(value, 1, false);
                      }}
                      onPopupScroll={(event) => {
                        if (!projectHasMore || projectLoading || !atListBottom(event)) return;
                        void loadProjects(projectQuery, projectPage + 1, true);
                      }}
                      onChange={(value) => selectProject(value)}
                    />
                    <Select<string, BranchSelectOption>
                      className="conversation-select"
                      aria-label={copy.branch}
                      showSearch
                      filterOption={false}
                      placeholder={copy.branchSearchPlaceholder}
                      value={selectedBranch || undefined}
                      disabled={!project}
                      loading={branchLoading}
                      options={branchOptions}
                      notFoundContent={<span className="conversation-select-empty">{copy.noBranches}</span>}
                      optionRender={(option) => (
                        <div className="conversation-option">
                          <span className="conversation-option-label">{option.data.label}</span>
                          {option.data.meta ? <span className="conversation-option-meta">{option.data.meta}</span> : null}
                        </div>
                      )}
                      onOpenChange={(open) => {
                        if (open && project && branches.length === 0) void loadBranches(project, "", 1, false);
                      }}
                      onSearch={(value) => {
                        setBranchQuery(value);
                        if (project) void loadBranches(project, value, 1, false);
                      }}
                      onPopupScroll={(event) => {
                        if (!project || !branchHasMore || branchLoading || !atListBottom(event)) return;
                        void loadBranches(project, branchQuery, branchPage + 1, true);
                      }}
                      onChange={(value) => setSelectedBranch(value)}
                    />
                  </div>
                  <Prompts
                    className="conversation-prompts"
                    title={copy.conversationSuggestions}
                    items={suggestionItems}
                    wrap
                    onItemClick={({ data }) => setDraftMessage(String(data.label ?? ""))}
                  />
                </div>
              ) : currentConversation && bubbleItems.length ? (
                <Bubble.List
                  className="conversation-transcript"
                  items={bubbleItems}
                  autoScroll
                  role={{
                    user: { placement: "end", variant: "filled" },
                    ai: { placement: "start", variant: "outlined" },
                  }}
                />
              ) : <Welcome className="conversation-welcome conversation-welcome-empty" title={copy.conversationPlaceholder} />}
            </div>
            <Sender
              className="conversation-composer"
              aria-label={copy.initialMessage}
              value={draftMessage}
              placeholder={showCreate ? copy.initialMessagePlaceholder : copy.replyPlaceholder}
              disabled={busy || (!showCreate && !canReply)}
              onChange={(value) => setDraftMessage(value.slice(0, 20_000))}
              onSubmit={submitMessage}
              suffix={(_node, { components: { SendButton } }) => (
                <SendButton aria-label={showCreate ? copy.createConversationLabel : copy.sendMessage} />
              )}
            />
          </div>
        </section>
      </section>
      <ConversationTurnDrawer
        conversationId={selectedConversationId}
        jobId={turnJobId}
        copy={copy}
        locale={locale}
        refreshToken={refreshToken}
        onClose={() => setTurnJobId("")}
        onUpdated={onUpdated}
      />
    </>
  );
}
