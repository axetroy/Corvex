import { useEffect, useState } from "react";
import { Button, Input, Select, Space, Tag, Typography } from "antd";
import { Bubble, Conversations, Sender, Welcome } from "@ant-design/x";
import type { BubbleItemType, ConversationItemType } from "@ant-design/x";
import "./SessionsPage.css";
import { errorMessage, fetchJson } from "../api.js";
import { formatDate } from "../format.js";
import type { Copy, Locale } from "../i18n.js";
import { Empty, ErrorBanner, PageHeading } from "./common.js";

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
        if (!selectedSessionId && page.items[0]) setSelectedSessionId(page.items[0].id);
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

  async function searchProjects() {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ search: projectQuery.trim(), page: "1" });
      setProjects(await fetchJson<ProjectOption[]>(`/api/ops/projects?${params}`, copy));
      setProject(undefined);
      setBranches([]);
      setTargets([]);
      setSelectedBranch("");
      setSelectedTarget(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function selectProject(value: ProjectOption) {
    setProject(value);
    setSelectedBranch("");
    setSelectedTarget(undefined);
    setTargets([]);
    setBranches([]);
    setBranchesSearched(false);
    setTargetsSearched(false);
    if (targetType !== "merge_request") await searchBranches(value, branchQuery, 1, false);
  }

  async function searchBranches(value: ProjectOption, query: string, page: number, append: boolean) {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ search: query.trim(), page: String(page) });
      const result = await fetchJson<BranchOption[]>(`/api/ops/projects/${value.id}/branches?${params}`, copy);
      setBranches((current) => append ? [...current, ...result] : result);
      setBranchesSearched(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function searchTargets() {
    if (!project || targetType === "repository") return;
    setBusy(true);
    setError("");
    setSelectedTarget(undefined);
    setTargetsSearched(false);
    try {
      const kind = targetType === "issue" ? "issues" : "merge-requests";
      const params = new URLSearchParams({ search: targetQuery.trim(), page: "1" });
      setTargets(await fetchJson<TargetOption[]>(`/api/ops/projects/${project.id}/${kind}?${params}`, copy));
      setTargetsSearched(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createSession(message: string) {
    if (!project || !message.trim()) return;
    const branch = targetType === "merge_request" ? selectedTarget?.source_branch : selectedBranch;
    if (!branch || (targetType !== "repository" && !selectedTarget)) return;
    setBusy(true);
    setError("");
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
      <PageHeading
        title={copy.sessionsTitle}
        description={copy.sessionsDescription}
      />
      {error ? <ErrorBanner message={error} /> : null}
      <section className="sessions-layout">
        <aside className="session-sidebar" aria-label={copy.sessionList}>
          <div className="session-sidebar-heading">
            <Typography.Text strong>{copy.sessionList}</Typography.Text>
            <Button size="small" type="primary" onClick={startNewSession}>{copy.newSession}</Button>
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
              <Typography.Title level={4}>{copy.newSession}</Typography.Title>
            ) : session ? (
              <div>
                <Typography.Title level={4}>{session.projectName} · {targetLabel(session, copy)}</Typography.Title>
                <Typography.Text type="secondary">{copy.pinnedRevision}: <code>{session.messages.at(-1)?.headSha ?? copy.none}</code></Typography.Text>
              </div>
            ) : <Typography.Title level={4}>{copy.sessionPlaceholder}</Typography.Title>}
            {hasActiveTurn ? <Tag color="processing">{copy.statuses.analyzing}</Tag> : null}
          </div>
          {showCreate ? (
            <div className="session-target-toolbar">
              <div className="session-project-picker">
                <Input.Search
                  aria-label={copy.projectSearch}
                  size="small"
                  maxLength={100}
                  value={projectQuery}
                  placeholder={copy.projectSearchPlaceholder}
                  enterButton={copy.searchTargets}
                  loading={busy}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  onSearch={() => void searchProjects()}
                />
                {projects.length ? (
                  <Select
                    aria-label={copy.chooseProject}
                    size="small"
                    value={project?.id}
                    placeholder={copy.chooseProject}
                    options={projects.map((value) => ({ value: value.id, label: value.path_with_namespace }))}
                    onChange={(projectId) => {
                      const value = projects.find((candidate) => candidate.id === projectId);
                      if (value) void selectProject(value);
                    }}
                  />
                ) : null}
              </div>
              <Select
                aria-label={copy.targetKind}
                className="session-target-kind"
                size="small"
                value={targetType}
                options={[
                  { value: "repository", label: copy.repositoryTarget },
                  { value: "issue", label: copy.issueTarget },
                  { value: "merge_request", label: copy.mergeRequestTarget },
                ]}
                onChange={(next: typeof targetType) => {
                  setTargetType(next);
                  setSelectedBranch("");
                  setSelectedTarget(undefined);
                  setTargets([]);
                  setTargetsSearched(false);
                  if (project && next !== "merge_request") void searchBranches(project, branchQuery, 1, false);
                }}
              />
              {targetType === "repository" || targetType === "issue" ? (
                <div className="session-target-choice">
                  <Input.Search
                    aria-label={copy.branch}
                    size="small"
                    maxLength={100}
                    value={branchQuery}
                    placeholder={copy.branch}
                    enterButton={copy.searchTargets}
                    loading={busy}
                    disabled={!project}
                    onChange={(event) => setBranchQuery(event.target.value)}
                    onSearch={() => project && void searchBranches(project, branchQuery, 1, false)}
                  />
                  <Select
                    aria-label={copy.branch}
                    size="small"
                    disabled={!project}
                    value={selectedBranch || undefined}
                    placeholder={copy.chooseTarget}
                    options={branches.map((value) => ({ value: value.name, label: value.name }))}
                    onChange={setSelectedBranch}
                  />
                  {branchesSearched && branches.length === 0 ? <span className="session-field-hint">{copy.noBranches}</span> : null}
                  {project && branches.length >= 50 ? (
                    <Button size="small" type="text" onClick={() => void searchBranches(project, branchQuery, Math.floor(branches.length / 50) + 1, true)}>
                      {copy.loadMore}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <div className="session-target-choice">
                  <Input.Search
                    aria-label={copy.target}
                    size="small"
                    maxLength={100}
                    value={targetQuery}
                    placeholder={copy.targetSearchPlaceholder}
                    enterButton={copy.searchTargets}
                    loading={busy}
                    disabled={!project}
                    onChange={(event) => setTargetQuery(event.target.value)}
                    onSearch={() => void searchTargets()}
                  />
                  <Select
                    aria-label={copy.target}
                    size="small"
                    disabled={!project || targets.length === 0}
                    value={selectedTarget?.iid}
                    placeholder={copy.chooseTarget}
                    options={targets.map((value) => ({
                      value: value.iid,
                      label: `!${value.iid} ${value.title}${value.source_branch ? ` · ${value.source_branch}` : ""}`,
                    }))}
                    onChange={(iid) => setSelectedTarget(targets.find((value) => value.iid === iid))}
                  />
                  {targetsSearched && targets.length === 0 ? <span className="session-field-hint">{copy.noTargets}</span> : null}
                </div>
              )}
            </div>
          ) : session ? (
            <div className="session-target-summary">
              <Typography.Text strong>{session.projectName}</Typography.Text>
              <Tag>{targetLabel(session, copy)}</Tag>
            </div>
          ) : null}
          <div className="session-chat">
            <div className="session-transcript-pane">
              {!showCreate && bubbleItems.length ? (
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
