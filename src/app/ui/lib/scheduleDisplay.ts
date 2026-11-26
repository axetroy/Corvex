/** 计划任务的展示格式化：任务管理页与对话里的结构化卡片共用。 */

import type { ScheduledTask } from "./types.js";
import type { Copy, Locale } from "./i18n.js";
import { formatDate } from "./format.js";

/** 计划列显示 cron 或一次性时间；完整原文由调用方放进 title。 */
export function formatSchedule(
  task: Pick<ScheduledTask, "kind" | "cron" | "runAt">,
  copy: Copy,
  locale: Locale,
): string {
  return task.kind === "cron" ? task.cron : formatDate(task.runAt, copy, locale);
}

export function scheduleStatusLabel(status: string, copy: Copy): string {
  return status === "active" ? copy.scheduledTaskActive
    : status === "paused" ? copy.scheduledTaskPaused
      : copy.scheduledTaskDone;
}
