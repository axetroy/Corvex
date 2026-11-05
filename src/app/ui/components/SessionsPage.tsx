import { useEffect, useRef, useState } from "react";
import { Button, Input, Popover, Space, Spin, Tag, Typography } from "antd";
import type { InputRef } from "antd";
import { Bubble, Conversations, Sender, Welcome } from "@ant-design/x";
import type { BubbleItemType, ConversationItemType } from "@ant-design/x";
import "./SessionsPage.css";
import { errorMessage, fetchJson } from "../api.js";
import { formatDate } from "../format.js";
import type { Copy, Locale } from "../i18n.js";
import { Empty, ErrorBanner } from "./common.js";

interface ProjectOption {
  id: number;
  name: string;
  path_with_namespace: string;
  default_branch?: string;
}

interface BranchOption {
  name: string;
  commit: { id: string };
}

interface TargetOption {
  iid: number;
  title: string;
  source_branch?: string;
  target_branch?: string;
  state?: string;
}

interface SessionSummary {
  id: string;
  projectId: number;
  projectName: string;
  targetType: "repository" | "issue" | "merge_request";
  targetIid: number;
  targetBranch: string;
  targetTitle: string;
  updatedAt: string;
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "queued" | "running" | "completed" | "failed";
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
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

const sessionPageSize = 50;

function targetLabel(session: SessionSummary, copy: Copy): string {
  if (session.targetType === "repository") return `${copy.repositoryTarget} · ${session.targetBranch}`;
  const kind = session.targetType === "issue" ? copy.issueTarget : copy.mergeRequestTarget;
  const prefix = session.targetType === "issue" ? "#" : "!";
  return `${kind} ${prefix}${session.targetIid} · ${session.targetTitle || session.targetBranch}`;
}

function messageStatus(message: SessionMessage, copy: Copy): string {
  if (message.status === "queued") return copy.statuses.queued;
  if (message.status === "running") return copy.statuses.analyzing;
  if (message.status === "failed") return copy.statuses.failed;
  return "";
}

export function SessionsPage({ copy, locale, refreshToken, onUpdated, onRefresh }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [session, setSession] = useState<SessionDetail>();
  const [pollToken, setPollToken] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(true);
  const [projectQuery, setProjectQuery] = useState("");
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [project, setProject] = useState<ProjectOption>();
  const [targetType, setTargetType] = useState<"repository" | "issue" | "merge_request">("repository");
  const [branchQuery, setBranchQuery] = useState("");
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchesSearched, setBranchesSearched] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [targets, setTargets] = useState<TargetOption[]>([]);
  const [targetsSearched, setTargetsSearched] = useState(false);
  const [selectedTarget, setSelectedTarget] = useState<TargetOption>();
  const [draftMessage, setDraftMessage] = useState("");
  const [openPicker, setOpenPicker] = useState<"project" | "branch" | "target" | null>(null);
  const projectSearchRequest = useRef(0);
  const branchSearchRequest = useRef(0);
  const targetSearchRequest = useRef(0);
  const pickerInput = useRef<InputRef>(null);

  useEffect(() => {
    if (!openPicker) return;
    const frame = window.requestAnimationFrame(() => pickerInput.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [openPicker]);

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
        if (!selectedSessionId && page.items[0]) {
          setSelectedSessionId(page.items[0].id);
          setShowCreate(false);
        }
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
        setError("");
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [copy, selectedSessionId, refreshToken, pollToken, onUpdated]);

  const hasActiveTurn = session?.messages.some((message) => message.role === "assistant" &&
    (message.status === "queued" || message.status === "running")) ?? false;

  useEffect(() => {
    if (!hasActiveTurn) return;
    const timer = window.setInterval(() => setPollToken((value) => value + 1), 2_500);
    return () => window.clearInterval(timer);
  }, [hasActiveTurn]);

  async function searchProjects(query = projectQuery) {
    const requestId = ++projectSearchRequest.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ search: query.trim(), page: "1" });
      const result = await fetchJson<ProjectOption[]>(`/api/ops/projects?${params}`, copy);
      if (requestId === projectSearchRequest.current) setProjects(result);
    } catch (cause) {
      if (requestId === projectSearchRequest.current) setError(errorMessage(cause));
    } finally {
      if (requestId === projectSearchRequest.current) setBusy(false);
    }
  }

  async function selectProject(value: ProjectOption) {
    targetSearchRequest.current += 1;
    setProject(value);
    setSelectedBranch("");
    setBranchQuery("");
    setSelectedTarget(undefined);
    setTargets([]);
    setBranches([]);
    setBranchesSearched(false);
    setTargetsSearched(false);
    setOpenPicker(null);
    if (targetType !== "merge_request") await searchBranches(value, "", 1, false);
  }

  async function searchBranches(value: ProjectOption, query: string, page: number, append: boolean) {
    const requestId = ++branchSearchRequest.current;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ search: query.trim(), page: String(page) });
      const result = await fetchJson<BranchOption[]>(`/api/ops/projects/${value.id}/branches?${params}`, copy);
      if (requestId !== branchSearchRequest.current) return;
      setBranches((current) => append ? [...current, ...result] : result);
      setBranchesSearched(true);
    } catch (cause) {
      if (requestId === branchSearchRequest.current) setError(errorMessage(cause));
    } finally {
      if (requestId === branchSearchRequest.current) setBusy(false);
    }
  }

  async function searchTargets(query = targetQuery) {
    if (!project || targetType === "repository") return;
    const requestId = ++targetSearchRequest.current;
    setBusy(true);
    setError("");
    setSelectedTarget(undefined);
    setTargetsSearched(false);
    try {
      const kind = targetType === "issue" ? "issues" : "merge-requests";
      const params = new URLSearchParams({ search: query.trim(), page: "1" });
      const result = await fetchJson<TargetOption[]>(`/api/ops/projects/${project.id}/${kind}?${params}`, copy);
      if (requestId === targetSearchRequest.current) {
        setTargets(result);
        setTargetsSearched(true);
      }
    } catch (cause) {
      if (requestId === targetSearchRequest.current) setError(errorMessage(cause));
    } finally {
      if (requestId === targetSearchRequest.current) setBusy(false);
    }
  }

  async function createSession(message: string) {
    if (!project || !message.trim()) return;
    const branch = targetType === "merge_request" ? selectedTarget?.source_branch : selectedBranch;
    if (!branch || (targetType !== "repository" && !selectedTarget)) return;
    setBusy(true);
    setError("");
    setOpenPicker(null);
    try {
      const result = await fetch("/api/ops/sessions", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          targetType,
          targetIid: selectedTarget?.iid ?? 0,
          targetBranch: branch,
          message,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        if (result.status === 409) throw new Error(copy.targetChanged);
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      const created = await result.json() as { sessionId: string };
      setDraftMessage("");
      setSelectedSessionId(created.sessionId);
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
    if (!session || !message.trim() || hasActiveTurn) return;
    setBusy(true);
    setError("");
    try {
      const result = await fetch(`/api/ops/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ message }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!result.ok) {
        if (result.status === 409) throw new Error(copy.targetChanged);
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      setDraftMessage("");
      setPollToken((value) => value + 1);
      onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function startNewSession() {
    setSelectedSessionId("");
    setSession(undefined);
    setShowCreate(true);
    setProjectQuery("");
    setProjects([]);
    setProject(undefined);
    setTargetType("repository");
    setBranchQuery("");
    setBranches([]);
    setBranchesSearched(false);
    setSelectedBranch("");
    setTargetQuery("");
    setTargets([]);
    setTargetsSearched(false);
    setSelectedTarget(undefined);
    setOpenPicker(null);
    setDraftMessage("");
    setError("");
  }

  function submitMessage(message: string) {
    if (showCreate) void createSession(message);
    else void sendReply(message);
  }

  const targetBranch = targetType === "merge_request" ? selectedTarget?.source_branch : selectedBranch;
  const canCreateSession = Boolean(
    project && targetBranch && (targetType === "repository" || selectedTarget) && !busy,
  );

  const conversationItems: ConversationItemType[] = sessions.map((item) => ({
    key: item.id,
    label: (
      <div className="session-conversation-label">
        <Typography.Text strong ellipsis>{item.projectName}</Typography.Text>
        <Typography.Text type="secondary" ellipsis>{targetLabel(item, copy)}</Typography.Text>
        <Typography.Text type="secondary">{formatDate(item.updatedAt, copy, locale)}</Typography.Text>
      </div>
    ),
  }));
  const bubbleItems: BubbleItemType[] = (session?.messages ?? []).map((message) => ({
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
                onActiveChange={(key) => {
                  setSelectedSessionId(key);
                  setShowCreate(false);
                }}
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
              <Typography.Text strong>{copy.newSession}</Typography.Text>
            ) : session ? (
              <div>
                <Typography.Text strong>{session.projectName} · {targetLabel(session, copy)}</Typography.Text>
                <Typography.Text type="secondary">{copy.pinnedRevision}: <code>{session.messages.at(-1)?.headSha ?? copy.none}</code></Typography.Text>
              </div>
            ) : <Typography.Text strong>{copy.sessionsTitle}</Typography.Text>}
            {hasActiveTurn ? <Tag color="processing">{copy.statuses.analyzing}</Tag> : null}
          </div>
          <div className="session-chat">
            <div className={`session-transcript-pane${showCreate ? " session-setup-pane" : ""}`}>
              {showCreate ? (
                <div className="session-start">
                  <div className="session-start-heading">
                    <Typography.Title level={2}>{copy.sessionWelcomeTitle}</Typography.Title>
                    <Typography.Text type="secondary">{copy.initialMessagePlaceholder}</Typography.Text>
                  </div>
                  <div className="session-shortcuts" role="group" aria-label={copy.targetKind}>
                    {([
                      ["repository", copy.repositoryTarget],
                      ["issue", copy.issueTarget],
                      ["merge_request", copy.mergeRequestTarget],
                    ] as const).map(([value, label]) => (
                      <Button
                        className={`session-shortcut${targetType === value ? " is-active" : ""}`}
                        key={value}
                        aria-pressed={targetType === value}
                        onClick={() => {
                          setTargetType(value);
                          setSelectedBranch("");
                          setSelectedTarget(undefined);
                          setTargets([]);
                          setTargetsSearched(false);
                          targetSearchRequest.current += 1;
                          setOpenPicker(null);
                          if (project && value !== "merge_request") void searchBranches(project, branchQuery, 1, false);
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  <div className="session-picker-row">
                    <Popover
                      trigger="click"
                      placement="bottomLeft"
                      arrow={false}
                      open={openPicker === "project"}
                      onOpenChange={(open) => {
                        setOpenPicker(open ? "project" : null);
                        if (open && projects.length === 0) void searchProjects("");
                      }}
                      content={(
                        <div className="session-picker-popover">
                          <Input
                            ref={pickerInput}
                            aria-label={copy.projectSearch}
                            maxLength={100}
                            value={projectQuery}
                            placeholder={copy.projectSearchPlaceholder}
                            suffix={busy ? <Spin size="small" /> : null}
                            onChange={(event) => {
                              const query = event.target.value.slice(0, 100);
                              setProjectQuery(query);
                              void searchProjects(query);
                            }}
                          />
                          <div className="session-picker-options" role="listbox" aria-label={copy.projectSearch}>
                            {projects.length ? projects.map((value) => (
                              <button
                                className="session-picker-option"
                                type="button"
                                role="option"
                                aria-selected={project?.id === value.id}
                                key={value.id}
                                onClick={() => {
                                  setProjectQuery("");
                                  void selectProject(value);
                                }}
                              >
                                <span>{value.path_with_namespace}</span>
                                <small>{value.name}</small>
                              </button>
                            )) : <div className="session-picker-empty">{projectQuery ? copy.noProjects : copy.chooseProject}</div>}
                          </div>
                        </div>
                      )}
                    >
                      <Button className="session-picker-trigger" size="middle" aria-expanded={openPicker === "project"}>
                        <span className="session-picker-trigger-label">{project?.path_with_namespace ?? copy.projectSearchPlaceholder}</span>
                      </Button>
                    </Popover>
                    {targetType !== "merge_request" ? (
                      <Popover
                        trigger="click"
                        placement="bottomLeft"
                        arrow={false}
                        open={openPicker === "branch"}
                        onOpenChange={(open) => {
                          setOpenPicker(open ? "branch" : null);
                          if (open && project && !branchesSearched) void searchBranches(project, branchQuery, 1, false);
                        }}
                        content={(
                          <div className="session-picker-popover">
                            <Input
                              ref={pickerInput}
                              aria-label={copy.branch}
                              maxLength={100}
                              value={branchQuery}
                              placeholder={copy.branch}
                              disabled={!project}
                              suffix={busy ? <Spin size="small" /> : null}
                              onChange={(event) => {
                                const query = event.target.value.slice(0, 100);
                                setBranchQuery(query);
                                if (project) void searchBranches(project, query, 1, false);
                              }}
                            />
                            <div className="session-picker-options" role="listbox" aria-label={copy.branch}>
                              {branches.length ? branches.map((value) => (
                                <button
                                  className="session-picker-option"
                                  type="button"
                                  role="option"
                                  aria-selected={selectedBranch === value.name}
                                  key={value.name}
                                  onClick={() => {
                                    setSelectedBranch(value.name);
                                    setBranchQuery("");
                                    setOpenPicker(null);
                                  }}
                                >{value.name}</button>
                              )) : <div className="session-picker-empty">{branchesSearched ? copy.noBranches : copy.chooseProject}</div>}
                            </div>
                            {project && branches.length >= 50 ? (
                              <Button className="session-picker-load-more" size="small" type="text" loading={busy} onClick={() => void searchBranches(project, branchQuery, Math.floor(branches.length / 50) + 1, true)}>
                                {copy.loadMore}
                              </Button>
                            ) : null}
                          </div>
                        )}
                      >
                        <Button className="session-picker-trigger" size="middle" disabled={!project} aria-expanded={openPicker === "branch"}>
                          <span className="session-picker-trigger-label">{selectedBranch || copy.branch}</span>
                        </Button>
                      </Popover>
                    ) : null}
                    {targetType !== "repository" ? (
                      <Popover
                        trigger="click"
                        placement="bottomLeft"
                        arrow={false}
                        open={openPicker === "target"}
                        onOpenChange={(open) => {
                          setOpenPicker(open ? "target" : null);
                          if (open && targets.length === 0 && project) void searchTargets(targetQuery);
                        }}
                        content={(
                          <div className="session-picker-popover">
                            <Input
                              ref={pickerInput}
                              aria-label={copy.target}
                              maxLength={100}
                              value={targetQuery}
                              placeholder={copy.targetSearchPlaceholder}
                              disabled={!project}
                              suffix={busy ? <Spin size="small" /> : null}
                              onChange={(event) => {
                                const query = event.target.value.slice(0, 100);
                                setTargetQuery(query);
                                void searchTargets(query);
                              }}
                            />
                            <div className="session-picker-options" role="listbox" aria-label={copy.target}>
                              {targets.length ? targets.map((value) => {
                                const prefix = targetType === "issue" ? "#" : "!";
                                const branch = targetType === "merge_request" ? value.source_branch : value.target_branch;
                                return (
                                  <button
                                    className="session-picker-option"
                                    type="button"
                                    role="option"
                                    aria-selected={selectedTarget?.iid === value.iid}
                                    key={value.iid}
                                    onClick={() => {
                                      setSelectedTarget(value);
                                      setOpenPicker(null);
                                    }}
                                  >
                                    <span>{prefix}{value.iid} {value.title}</span>
                                    {branch ? <small>{branch}</small> : null}
                                  </button>
                                );
                              }) : <div className="session-picker-empty">{targetsSearched ? copy.noTargets : copy.chooseProject}</div>}
                            </div>
                          </div>
                        )}
                      >
                        <Button className="session-picker-trigger" size="middle" disabled={!project} aria-expanded={openPicker === "target"}>
                          <span className="session-picker-trigger-label">
                            {selectedTarget ? `${targetType === "issue" ? "#" : "!"}${selectedTarget.iid} ${selectedTarget.title}` : copy.target}
                          </span>
                        </Button>
                      </Popover>
                    ) : null}
                  </div>
                </div>
              ) : bubbleItems.length ? (
                <Bubble.List
                  className="session-transcript"
                  items={bubbleItems}
                  autoScroll
                  role={{
                    user: { placement: "end", variant: "filled" },
                    ai: { placement: "start", variant: "outlined" },
                  }}
                />
              ) : <Welcome title={copy.sessionPlaceholder} />}
            </div>
            <Sender
              className="session-composer"
              aria-label={copy.initialMessage}
              value={draftMessage}
              placeholder={showCreate ? copy.initialMessagePlaceholder : copy.replyPlaceholder}
              disabled={busy || (showCreate ? !canCreateSession : hasActiveTurn || !session)}
              onChange={(value) => setDraftMessage(value.slice(0, 20_000))}
              onSubmit={submitMessage}
              suffix={(_node, { components: { SendButton } }) => (
                <SendButton aria-label={copy.sendMessage} />
              )}
            />
          </div>
        </section>
      </section>
    </>
  );
}
