import { useEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { Button, Select, Space, Tag, Typography } from "antd";
import { Bubble, Conversations, Prompts, Sender, Welcome } from "@ant-design/x";
import type { BubbleItemType, ConversationItemType, PromptsItemType } from "@ant-design/x";
import "./SessionsPage.css";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate } from "../format.js";
import type { Copy, Locale } from "../i18n.js";
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

interface SessionSummary {
  id: string;
  projectId: number;
  projectName: string;
  targetBranch: string;
  updatedAt: string;
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "queued" | "running" | "completed" | "failed";
  jobId: string | null;
  headSha: string;
  createdAt: string;
}

interface SessionDetail extends SessionSummary {
  messages: SessionMessage[];
}

interface SessionPage {
  items: SessionSummary[];
  total: number;
}

interface Props {
  sessionId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
  onSessionChange: (sessionId: string) => void;
}

/** 会话列表每页条数。 */
const sessionPageSize = 50;
/** GitLab 项目/分支搜索每页条数，与服务端 `per_page` 保持一致。 */
const listPageSize = 50;

/** 判断下拉列表是否已滚动到底部，用于追加下一页。 */
function atListBottom(event: UIEvent<HTMLDivElement>): boolean {
  const target = event.currentTarget;
  return target.scrollTop + target.offsetHeight >= target.scrollHeight - 8;
}

/** 消息处理状态对应的界面文案；完成状态不展示徽标。 */
function messageStatus(message: SessionMessage, copy: Copy): string {
  if (message.status === "queued") return copy.statuses.queued;
  if (message.status === "running") return copy.statuses.analyzing;
  if (message.status === "failed") return copy.statuses.failed;
  return "";
}

export function SessionsPage({ sessionId, copy, locale, refreshToken, onUpdated, onRefresh, onSessionChange }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState(sessionId);
  const selectedSessionIdRef = useRef(sessionId);
  const [session, setSession] = useState<SessionDetail>();
  const pendingReplyJobs = useRef(new Map<string, string>());
  const [pendingReplySessions, setPendingReplySessions] = useState<Set<string>>(() => new Set());
  const [pollToken, setPollToken] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(!sessionId);
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
  const projectSearchRequest = useRef(0);
  const branchSearchRequest = useRef(0);
  const replySubmitting = useRef(false);

  useEffect(() => {
    selectedSessionIdRef.current = sessionId;
    setSelectedSessionId(sessionId);
    setSession(undefined);
    setShowCreate(!sessionId);
    setDraftMessage("");
    setError("");
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    fetchJson<SessionPage>(`/api/ops/sessions?limit=${sessionPageSize}&offset=${sessionOffset}`, copy)
      .then((page) => {
        if (!active) return;
        setSessions((current) => {
          if (sessionOffset === 0) return page.items;
          const byId = new Map(current.map((item) => [item.id, item]));
          for (const item of page.items) byId.set(item.id, item);
          return [...byId.values()];
        });
        setSessionTotal(page.total);
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [copy, sessionOffset, refreshToken, onUpdated]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSession(undefined);
      return;
    }
    let active = true;
    fetchJson<SessionDetail>(`/api/ops/sessions/${encodeURIComponent(selectedSessionId)}`, copy)
      .then((value) => {
        if (!active) return;
        setSession(value);
        const pendingJobId = pendingReplyJobs.current.get(value.id);
        if (pendingJobId && value.messages.some((message) => message.jobId === pendingJobId)) {
          pendingReplyJobs.current.delete(value.id);
          setPendingReplySessions((current) => {
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
  }, [copy, selectedSessionId, refreshToken, pollToken, onUpdated]);

  const currentSession = session?.id === selectedSessionId && selectedSessionId === sessionId ? session : undefined;
  const hasActiveTurn = currentSession?.messages.some((message) => message.role === "assistant" &&
    (message.status === "queued" || message.status === "running")) ?? false;

  useEffect(() => {
    if (!hasActiveTurn && !pendingReplySessions.has(selectedSessionId)) return;
    const timer = window.setInterval(() => setPollToken((value) => value + 1), 2_500);
    return () => window.clearInterval(timer);
  }, [hasActiveTurn, pendingReplySessions, selectedSessionId]);

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

  async function createSession(message: string) {
    if (!message.trim()) return;
    if (!project || !selectedBranch) {
      setError(copy.chooseProject);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await fetch("/api/ops/sessions", {
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
      const created = await result.json() as { sessionId: string };
      setDraftMessage("");
      setSelectedSessionId(created.sessionId);
      selectedSessionIdRef.current = created.sessionId;
      onSessionChange(created.sessionId);
      setShowCreate(false);
      setSessionOffset(0);
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
    if (!currentSession || !message.trim() || hasActiveTurn || busy || replySubmitting.current || pendingReplySessions.has(currentSession.id)) return;
    const replySessionId = currentSession.id;
    replySubmitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await fetch(`/api/ops/sessions/${encodeURIComponent(replySessionId)}/messages`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ message }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        if (result.status === 409) {
          const body = await result.json() as { error?: unknown };
          if (body.error === "chat session already has an active message") {
            throw new Error(copy.sessionTurnActive);
          }
          throw new Error(copy.targetChanged);
        }
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      const queued = await result.json() as { jobId: string };
      pendingReplyJobs.current.set(replySessionId, queued.jobId);
      setPendingReplySessions((current) => new Set(current).add(replySessionId));
      if (selectedSessionIdRef.current === replySessionId) setDraftMessage("");
      setPollToken((value) => value + 1);
      onRefresh();
    } catch (cause) {
      if (selectedSessionIdRef.current === replySessionId) setError(errorMessage(cause));
    } finally {
      replySubmitting.current = false;
      setBusy(false);
    }
  }

  function startNewSession() {
    setSelectedSessionId("");
    selectedSessionIdRef.current = "";
    onSessionChange("");
    setSession(undefined);
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

  function openSession(key: string) {
    setSelectedSessionId(key);
    selectedSessionIdRef.current = key;
    setSession(undefined);
    setDraftMessage("");
    setError("");
    onSessionChange(key);
    setShowCreate(false);
  }

  function submitMessage(message: string) {
    if (showCreate) void createSession(message);
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
    { key: "explain", label: copy.sessionPromptExplain },
    { key: "locate", label: copy.sessionPromptLocate },
    { key: "improve", label: copy.sessionPromptImprove },
    { key: "onboard", label: copy.sessionPromptOnboard },
  ];
  const canReply = Boolean(currentSession && !hasActiveTurn && !pendingReplySessions.has(selectedSessionId));

  const conversationItems: ConversationItemType[] = sessions.map((item) => ({
    key: item.id,
    label: (
      <div className="session-conversation-label">
        <Typography.Text strong ellipsis>{item.projectName}</Typography.Text>
        <Typography.Text type="secondary" ellipsis>{item.targetBranch}</Typography.Text>
        <Typography.Text type="secondary" className="session-conversation-time">
          {formatDate(item.updatedAt, copy, locale)}
        </Typography.Text>
      </div>
    ),
  }));
  const bubbleItems: BubbleItemType[] = (currentSession?.messages ?? []).map((message) => ({
    key: message.id,
    role: message.role === "user" ? "user" : "ai",
    header: (
      <Space size={8} wrap>
        <Typography.Text strong>{message.role === "user" ? copy.userRole : copy.assistantRole}</Typography.Text>
        <Typography.Text type="secondary">{formatDate(message.createdAt, copy, locale)}</Typography.Text>
        {messageStatus(message, copy) ? <Tag>{messageStatus(message, copy)}</Tag> : null}
      </Space>
    ),
    content: message.content,
    loading: message.role === "assistant" && !message.content && (message.status === "queued" || message.status === "running"),
    status: message.status === "failed" ? "error" : message.status === "completed" ? "success" : undefined,
  }));

  return (
    <>
      {error ? <ErrorBanner message={error} /> : null}
      <section className="sessions-layout" aria-label={copy.sessionsDescription}>
        <aside className="session-sidebar" aria-label={copy.sessionList}>
          <div className="session-sidebar-heading">
            <Typography.Text strong className="session-sidebar-title">{copy.sessionsTitle}</Typography.Text>
            <Button className="session-new-button" type="primary" onClick={startNewSession}>
              <span aria-hidden="true">+</span>
              {copy.newSession}
            </Button>
          </div>
          <div className="session-sidebar-list">
            {conversationItems.length ? (
              <Conversations
                items={conversationItems}
                activeKey={selectedSessionId || undefined}
                onActiveChange={(key) => openSession(key)}
              />
            ) : <Empty>{copy.noSessions}</Empty>}
            {sessions.length < sessionTotal ? (
              <Button className="session-load-more" type="text" onClick={() => setSessionOffset((value) => value + sessionPageSize)}>
                {copy.loadMore}
              </Button>
            ) : null}
          </div>
        </aside>
        <section className="session-workspace">
          <div className="session-workspace-heading">
            {showCreate ? (
              <Typography.Text strong className="session-workspace-title">{copy.newSession}</Typography.Text>
            ) : currentSession ? (
              <div className="session-workspace-title">
                <Space size={8} wrap>
                  <Typography.Text strong>{currentSession.projectName}</Typography.Text>
                  <Tag className="session-branch-tag">{currentSession.targetBranch}</Tag>
                </Space>
                <Typography.Text type="secondary" className="session-pinned">
                  {copy.pinnedRevision}: <code>{currentSession.messages.at(-1)?.headSha ?? copy.none}</code>
                </Typography.Text>
              </div>
            ) : <Typography.Text strong className="session-workspace-title">{copy.sessionsTitle}</Typography.Text>}
            {hasActiveTurn ? <Tag color="processing">{copy.statuses.analyzing}</Tag> : null}
          </div>
          <div className="session-chat">
            <div className={`session-transcript-pane${showCreate ? " session-setup-pane" : ""}`}>
              {showCreate ? (
                <div className="session-start">
                  <Welcome
                    className="session-welcome"
                    variant="borderless"
                    icon={<span className="session-welcome-icon" aria-hidden="true">C</span>}
                    title={copy.sessionWelcomeTitle}
                    description={copy.sessionWelcomeDescription}
                  />
                  <div className="session-picker-row">
                    <Select<number, ProjectSelectOption>
                      className="session-select"
                      aria-label={copy.projectSearch}
                      showSearch
                      filterOption={false}
                      placeholder={copy.projectSearchPlaceholder}
                      value={project?.id}
                      loading={projectLoading}
                      options={projectOptions}
                      notFoundContent={<span className="session-select-empty">{projectQuery ? copy.noProjects : copy.chooseProject}</span>}
                      optionRender={(option) => (
                        <div className="session-option">
                          <span className="session-option-label">{option.data.label}</span>
                          {option.data.meta ? <span className="session-option-meta">{option.data.meta}</span> : null}
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
                      className="session-select"
                      aria-label={copy.branch}
                      showSearch
                      filterOption={false}
                      placeholder={copy.branchSearchPlaceholder}
                      value={selectedBranch || undefined}
                      disabled={!project}
                      loading={branchLoading}
                      options={branchOptions}
                      notFoundContent={<span className="session-select-empty">{copy.noBranches}</span>}
                      optionRender={(option) => (
                        <div className="session-option">
                          <span className="session-option-label">{option.data.label}</span>
                          {option.data.meta ? <span className="session-option-meta">{option.data.meta}</span> : null}
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
                    className="session-prompts"
                    title={copy.sessionSuggestions}
                    items={suggestionItems}
                    wrap
                    onItemClick={({ data }) => setDraftMessage(String(data.label ?? ""))}
                  />
                </div>
              ) : currentSession && bubbleItems.length ? (
                <Bubble.List
                  className="session-transcript"
                  items={bubbleItems}
                  autoScroll
                  role={{
                    user: { placement: "end", variant: "filled" },
                    ai: { placement: "start", variant: "outlined" },
                  }}
                />
              ) : <Welcome className="session-welcome session-welcome-empty" title={copy.sessionPlaceholder} />}
            </div>
            <Sender
              className="session-composer"
              aria-label={copy.initialMessage}
              value={draftMessage}
              placeholder={showCreate ? copy.initialMessagePlaceholder : copy.replyPlaceholder}
              disabled={busy || (!showCreate && !canReply)}
              onChange={(value) => setDraftMessage(value.slice(0, 20_000))}
              onSubmit={submitMessage}
              suffix={(_node, { components: { SendButton } }) => (
                <SendButton aria-label={showCreate ? copy.createSession : copy.sendMessage} />
              )}
            />
          </div>
        </section>
      </section>
    </>
  );
}
