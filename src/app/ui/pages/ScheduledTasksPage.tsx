import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Popconfirm, Table, Tag, Typography } from "antd";
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
}

/** 计划任务管理页：查看任务、下次运行、最近记录，并可暂停或删除。新建主要通过在对话里用自然语言创建。 */
export function ScheduledTasksPage({ copy, locale }: Props) {
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

  const act = async (task: ScheduledTask, action: "cancel" | "delete") => {
    setBusy(task.id);
    setError("");
    try {
      if (action === "cancel") {
        await sendJson(`/api/ops/me/scheduled-tasks/${encodeURIComponent(task.id)}/cancel`, {}, copy, "POST");
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
      <Panel title={copy.scheduledTaskListTitle}>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={tasks}
          locale={{ emptyText: copy.scheduledTaskEmpty }}
          columns={[
            { title: copy.scheduledTaskColumnId, dataIndex: "id", key: "id", render: (id: string) => <Typography.Text code>{id}</Typography.Text> },
            {
              title: copy.scheduledTaskColumnPrompt,
              dataIndex: "prompt",
              key: "prompt",
              render: (prompt: string) => <span title={prompt}>{prompt.replace(/\s+/g, " ").slice(0, 100)}</span>,
            },
            {
              title: copy.scheduledTaskColumnSchedule,
              key: "schedule",
              render: (_: unknown, task: ScheduledTask) => (
                <Typography.Text code>{task.kind === "cron" ? task.cron : task.runAt}</Typography.Text>
              ),
            },
            {
              title: copy.scheduledTaskColumnNext,
              dataIndex: "nextRunAt",
              key: "nextRunAt",
              render: (value: string) => formatDate(value, copy, locale),
            },
            {
              title: copy.scheduledTaskColumnStatus,
              key: "status",
              render: (_: unknown, task: ScheduledTask) => (
                <Tag color={task.status === "active" ? "success" : task.status === "paused" ? "warning" : "default"}>
                  {task.status === "active" ? copy.scheduledTaskActive : task.status === "paused" ? copy.scheduledTaskPaused : copy.scheduledTaskDone}
                </Tag>
              ),
            },
            {
              title: copy.scheduledTaskColumnLastRun,
              key: "lastRun",
              render: (_: unknown, task: ScheduledTask) => {
                const latest = runs[task.id]?.[0];
                if (!latest) return copy.none;
                return <span title={latest.error}>{formatDate(latest.finishedAt, copy, locale)} · {latest.status}</span>;
              },
            },
            {
              title: copy.scheduledTaskColumnActions,
              key: "actions",
              render: (_: unknown, task: ScheduledTask) => (
                <div className="scheduled-task-actions">
                  {task.status === "active" ? (
                    <Popconfirm title={copy.scheduledTaskCancelConfirm} onConfirm={() => void act(task, "cancel")}>
                      <Button size="small" loading={busy === task.id}>{copy.scheduledTaskPause}</Button>
                    </Popconfirm>
                  ) : null}
                  <Popconfirm title={copy.scheduledTaskDeleteConfirm} onConfirm={() => void act(task, "delete")}>
                    <Button size="small" danger loading={busy === task.id}>{copy.scheduledTaskDelete}</Button>
                  </Popconfirm>
                </div>
              ),
            },
          ]}
        />
      </Panel>
    </div>
  );
}
