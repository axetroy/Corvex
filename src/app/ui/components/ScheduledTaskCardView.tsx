import { Button, Tag } from "antd";
import type { Copy, Locale } from "../lib/i18n.js";
import type { ScheduledTaskCard } from "../lib/types.js";
import { formatDate } from "../lib/format.js";
import { formatSchedule, scheduleStatusLabel } from "../lib/scheduleDisplay.js";
import "./ScheduledTaskCardView.css";

/** 计划任务工具结果在对话里的自定义渲染：服务端数据驱动，带跳转按钮。 */
export function ScheduledTaskCardView({
  card,
  copy,
  locale,
}: {
  card: ScheduledTaskCard;
  copy: Copy;
  locale: Locale;
}) {
  const openPage = () => { window.location.hash = "#/scheduled-tasks"; };
  if (card.type === "cancelled") {
    return (
      <div className="chat-schedule-card">
        <div className="chat-schedule-card-head">
          <span className="chat-schedule-card-title">
            {card.found ? copy.scheduledTaskCardCancelled : copy.scheduledTaskCardNotFound}
          </span>
          <Button type="link" size="small" onClick={openPage}>{copy.scheduledTaskOpenPage}</Button>
        </div>
        <div className="chat-schedule-card-meta"><code>{card.taskId}</code></div>
      </div>
    );
  }

  const tasks = card.type === "created" ? [card.task] : card.tasks;
  return (
    <div className="chat-schedule-card">
      <div className="chat-schedule-card-head">
        <span className="chat-schedule-card-title">
          {card.type === "created" ? copy.scheduledTaskCardCreated : copy.scheduledTaskListTitle}
        </span>
        <Button type="link" size="small" onClick={openPage}>{copy.scheduledTaskOpenPage}</Button>
      </div>
      {tasks.length === 0 ? (
        <div className="chat-schedule-card-empty">{copy.scheduledTaskEmpty}</div>
      ) : (
        <div className="chat-schedule-card-items">
          {tasks.map((task) => (
            <div className="chat-schedule-card-item" key={task.id}>
              <div className="chat-schedule-card-prompt" title={task.prompt}>{task.prompt}</div>
              <div className="chat-schedule-card-meta">
                <span title={task.kind === "cron" ? task.cron : task.runAt}>
                  <b>{copy.scheduledTaskColumnSchedule}</b> {formatSchedule(task, copy, locale)}
                  {task.timezone && task.timezone !== "UTC" ? (
                    <Tag className="chat-schedule-card-tz">{task.timezone}</Tag>
                  ) : null}
                </span>
                <span>
                  <b>{copy.scheduledTaskColumnNext}</b> {formatDate(task.nextRunAt, copy, locale)}
                </span>
                <span><b>{copy.scheduledTaskColumnStatus}</b> {scheduleStatusLabel(task.status, copy)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
