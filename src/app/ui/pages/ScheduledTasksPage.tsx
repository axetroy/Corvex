import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Popconfirm, Popover, Tag, Typography } from "antd";
import { fetchJson, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy, Locale } from "../lib/i18n.js";
import { formatDate } from "../lib/format.js";
import { Loading, PageHeading, Panel } from "../components/common.js";
import type { ScheduledTask, ScheduledTaskRun } from "../lib/types.js";
import "./ScheduledTasksPage.css";

interface Props {
  copy: Copy;
  locale: Locale;
  /** 从账号菜单跳进来的用户需要一键回到对话页用自然语言创建任务。 */
  onNavigateToConversations: () => void;
}

/** 一张任务卡片里的「标签 + 值」，让密集的元数据有稳定的两列基线。 */
function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="scheduled-task-meta-item">
      <span className="scheduled-task-meta-label">{label}</span>
      <span className="scheduled-task-meta-value">{children}</span>
    </div>
  );
}

function ExamplePrompts({ copy }: { copy: Copy }) {
  return (
    <div className="scheduled-task-example-list">
      <code>{copy.scheduledTaskExampleCron}</code>
      <code>{copy.scheduledTaskExampleOnce}</code>
      <code>{copy.scheduledTaskExampleCancel}</code>
    </div>
  );
}

/** 计划任务管理页：卡片式布局，查看任务、下次运行、最近记录，并可暂停或删除。新建主要通过在对话里用自然语言创建。 */
export function ScheduledTasksPage({ copy, locale, onNavigateToConversations }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>();
  const [runs, setRuns] = useState<Record<string, ScheduledTaskRun[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    setError("");
    fetchJson<{ items: ScheduledTask[] }>("/api/ops/me/scheduled-tasks", copy)
      .then(async (response) => {
        setTasks(response.items);
        const entries = await Promise.all(response.items.map(async (task) => {
          try {
            const result = await fetchJson<{ items: ScheduledTaskRun[] }>(
              `/api/ops/me/scheduled-tasks/${encodeURIComponent(task.id)}/runs`, copy,
            );
            return [task.id, result.items] as const;
          } catch {
            return [task.id, []] as const;
          }
        }));
        setRuns(Object.fromEntries(entries));
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [copy]);

  useEffect(load, [load]);

  const act = async (task: ScheduledTask, action: "cancel" | "resume" | "run" | "delete") => {
    setBusy(task.id);
    setError("");
    try {
      if (action === "cancel") {
        await sendJson(`/api/ops/me/scheduled-tasks/${encodeURIComponent(task.id)}/cancel`, {}, copy, "POST");
      } else if (action === "resume") {
        await sendJson(`/api/ops/me/scheduled-tasks/${encodeURIComponent(task.id)}/resume`, {}, copy, "POST");
      } else if (action === "run") {
        await sendJson(`/api/ops/me/scheduled-tasks/${encodeURIComponent(task.id)}/run`, {}, copy, "POST");
      } else {
        await sendJson(`/api/ops/me/scheduled-tasks/${encodeURIComponent(task.id)}`, {}, copy, "DELETE");
      }
      load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  };

  if (!tasks) return <Loading>{copy.loading}</Loading>;

  return (
    <div className="scheduled-tasks-page">
      <PageHeading title={copy.scheduledTaskTitle} description={copy.scheduledTaskHint} />
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError("")} /> : null}
      <Panel title={copy.scheduledTaskGuideTitle}>
        <ol className="scheduled-task-guide-steps">
          <li>{copy.scheduledTaskGuideStep1}</li>
          <li>{copy.scheduledTaskGuideStep2}</li>
          <li>{copy.scheduledTaskGuideStep3}</li>
        </ol>
        <div className="scheduled-task-guide-examples">
          <span className="scheduled-task-meta-label">{copy.scheduledTaskGuideExampleTitle}</span>
          <ExamplePrompts copy={copy} />
        </div>
      </Panel>
      <Panel title={copy.scheduledTaskListTitle}>
        {tasks.length === 0 ? (
          <div className="scheduled-task-empty">
            <Typography.Title level={5} className="scheduled-task-empty-title">{copy.scheduledTaskEmpty}</Typography.Title>
            <p className="scheduled-task-empty-hint">{copy.scheduledTaskGuideStep1}</p>
            <ExamplePrompts copy={copy} />
            <Button type="primary" onClick={onNavigateToConversations}>{copy.scheduledTaskGoToConversations}</Button>
          </div>
        ) : (
          <div className="scheduled-task-grid">
            {tasks.map((task) => {
              const history = runs[task.id] ?? [];
              const latest = history[0];
              const lastRun = latest ? (
                <span className="scheduled-task-last-run" title={latest.error || undefined}>
                  {formatDate(latest.finishedAt, copy, locale)} · {latest.status}
                </span>
              ) : (
                <span>{copy.none}</span>
              );
              const statusLabel = task.status === "active"
                ? copy.scheduledTaskActive
                : task.status === "paused"
                  ? copy.scheduledTaskPaused
                  : copy.scheduledTaskDone;
              return (
                <article className="scheduled-task-card" key={task.id}>
                  <div className="scheduled-task-card-head">
                    <div className="scheduled-task-card-main">
                      <span className="scheduled-task-meta-label">{copy.scheduledTaskColumnPrompt}</span>
                      <span className="scheduled-task-card-title" title={task.prompt}>
                        {task.prompt.replace(/\s+/g, " ")}
                      </span>
                    </div>
                    <Tag className="scheduled-task-status" title={copy.scheduledTaskColumnStatus} color={task.status === "active" ? "success" : task.status === "paused" ? "warning" : "default"}>
                      {statusLabel}
                    </Tag>
                  </div>
                  <div className="scheduled-task-meta">
                    <MetaItem label={copy.scheduledTaskColumnId}>
                      <Typography.Text code className="scheduled-task-id" title={task.id}>{task.id.slice(0, 8)}</Typography.Text>
                    </MetaItem>
                    <MetaItem label={copy.scheduledTaskColumnSchedule}>
                      <Typography.Text code title={task.kind === "cron" ? task.cron : task.runAt}>
                        {task.kind === "cron" ? task.cron : formatDate(task.runAt, copy, locale)}
                      </Typography.Text>
                      {task.timezone && task.timezone !== "UTC" ? (
                        <Tag className="scheduled-task-tz">{task.timezone}</Tag>
                      ) : null}
                    </MetaItem>
                    <MetaItem label={copy.scheduledTaskColumnNext}>
                      {formatDate(task.nextRunAt, copy, locale)}
                    </MetaItem>
                    <MetaItem label={copy.scheduledTaskColumnLastRun}>
                      {history.length > 1 ? (
                        <Popover
                          trigger="click"
                          title={copy.scheduledTaskHistoryTitle}
                          content={
                            <div className="scheduled-task-history">
                              {history.map((run) => (
                                <div className="scheduled-task-history-row" key={run.id}>
                                  <span>{formatDate(run.finishedAt, copy, locale)}</span>
                                  <span>{run.status}</span>
                                  <span title={run.error}>{run.turnId || copy.none}</span>
                                </div>
                              ))}
                            </div>
                          }
                        >
                          {lastRun}
                        </Popover>
                      ) : lastRun}
                    </MetaItem>
                  </div>
                  <div className="scheduled-task-actions" aria-label={copy.scheduledTaskColumnActions}>
                    {task.status === "active" ? (
                      <>
                        <Popconfirm title={copy.scheduledTaskRunConfirm} onConfirm={() => void act(task, "run")}>
                          <Button size="small" loading={busy === task.id}>{copy.scheduledTaskRunNow}</Button>
                        </Popconfirm>
                        <Popconfirm title={copy.scheduledTaskCancelConfirm} onConfirm={() => void act(task, "cancel")}>
                          <Button size="small" loading={busy === task.id}>{copy.scheduledTaskPause}</Button>
                        </Popconfirm>
                      </>
                    ) : (
                      <Button size="small" loading={busy === task.id} onClick={() => void act(task, "resume")}>
                        {copy.scheduledTaskResume}
                      </Button>
                    )}
                    <Popconfirm title={copy.scheduledTaskDeleteConfirm} onConfirm={() => void act(task, "delete")}>
                      <Button size="small" danger loading={busy === task.id}>{copy.scheduledTaskDelete}</Button>
                    </Popconfirm>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
