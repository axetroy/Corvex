import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ScheduledTask } from "../model.js";
import { nextRunAt, parseCron, parseRunAt } from "../app/schedule.js";

/** 计划任务工具所需的最小存储接口；由 PiAgent 注入现有 AppStore。 */
export interface ScheduledTaskStore {
  create(input: {
    ownerUserId: string;
    conversationId: string;
    prompt: string;
    kind: "once" | "cron";
    cron: string;
    runAt: string;
    nextRunAt: string;
    expiresAt: string;
  }): ScheduledTask;
  list(ownerUserId: string): ScheduledTask[];
  get(id: string): ScheduledTask | undefined;
  cancel(id: string, ownerUserId: string): boolean;
  /** 校验对话是否属于该用户，避免跨用户给别人的对话建任务。 */
  conversationOwner(conversationId: string): string | undefined;
}

export interface ScheduledTaskToolOptions {
  conversationId?: string;
  store?: ScheduledTaskStore;
}

const maxPromptCharacters = 8_000;

/** 把任务渲染成简短一行，供列表工具回显。 */
function describeTask(task: ScheduledTask): string {
  const schedule = task.kind === "cron" ? task.cron : task.runAt;
  const summary = task.prompt.replace(/\s+/g, " ").slice(0, 80);
  return `${task.id} [${task.status}] ${schedule} — ${summary}`;
}

/**
 * 注册计划任务三工具：create / list / cancel。
 * 只在对话轮次且有 store + owner 时注册；无 store 时退化为空（不影响标题等非对话任务）。
 */
export function createScheduledTaskExtension(options: ScheduledTaskToolOptions = {}): (pi: ExtensionAPI) => void {
  const { conversationId, store } = options;
  const ownerUserId = conversationId && store ? store.conversationOwner(conversationId) : undefined;
  return (pi) => {
    if (!store || !ownerUserId || !conversationId) return;

    pi.registerTool({
      name: "schedule_task",
      label: "Schedule task",
      executionMode: "parallel",
      description:
        "Schedule a prompt to run later as a normal conversation turn. Convert the user's natural-language time into a 5-field cron expression (minute hour day-of-month month day-of-week) for recurring tasks, or a relative time like 'in 45m' for one-shot reminders. Always echo the chosen schedule back to the user. The task runs with your own credentials in this conversation; a missed run is not replayed.",
      promptSnippet: "schedule_task: create a one-shot reminder or a recurring cron task in this conversation.",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: maxPromptCharacters }),
        schedule: Type.String({ minLength: 1, maxLength: 200 }),
        recurring: Type.Optional(Type.Boolean()),
        conversationId: Type.Optional(Type.String({ maxLength: 128 })),
      }),
      execute: async (_toolCallId, params) => {
        const targetConversation = params.conversationId ?? conversationId;
        if (store.conversationOwner(targetConversation) !== ownerUserId) {
          return { content: [{ type: "text", text: "That conversation does not belong to the current user." }], details: {} };
        }
        const prompt = params.prompt.trim().slice(0, maxPromptCharacters);
        const recurring = params.recurring === true;
        const now = Date.now();
        let kind: "once" | "cron";
        let cron = "";
        let runAt = "";
        let next: Date | undefined;
        if (recurring) {
          const parsed = parseCron(params.schedule.trim());
          if (!parsed) {
            return { content: [{ type: "text", text: `Invalid cron expression: ${params.schedule}. Use 5 fields: minute hour day-of-month month day-of-week.` }], details: {} };
          }
          kind = "cron";
          cron = params.schedule.trim();
          next = nextRunAt(parsed, new Date(now));
        } else {
          const parsed = parseRunAt(params.schedule, new Date(now));
          if (!parsed || parsed.getTime() <= now) {
            return { content: [{ type: "text", text: `Invalid or past time: ${params.schedule}. Use e.g. "in 45m" or an ISO timestamp.` }], details: {} };
          }
          kind = "once";
          runAt = parsed.toISOString();
          next = parsed;
        }
        if (!next) {
          return { content: [{ type: "text", text: "The schedule never fires; pick a different expression." }], details: {} };
        }
        const expiresAt = recurring ? new Date(now + 30 * 86_400_000).toISOString() : "";
        const task = store.create({
          ownerUserId, conversationId: targetConversation, prompt, kind, cron, runAt,
          nextRunAt: next.toISOString(), expiresAt,
        });
        return {
          content: [{ type: "text", text: `Scheduled ${kind} task ${task.id}. Next run: ${next.toISOString()} (UTC). Echo this schedule to the user to confirm.` }],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: "list_scheduled_tasks",
      label: "List scheduled tasks",
      executionMode: "parallel",
      description: "List the current user's scheduled tasks with their ID, schedule, next run and status.",
      promptSnippet: "list_scheduled_tasks: show scheduled tasks and their next run times.",
      parameters: Type.Object({}),
      execute: async () => {
        const tasks = store.list(ownerUserId);
        const text = tasks.length > 0
          ? tasks.map(describeTask).join("\n")
          : "No scheduled tasks.";
        return { content: [{ type: "text", text }], details: {} };
      },
    });

    pi.registerTool({
      name: "cancel_scheduled_task",
      label: "Cancel scheduled task",
      executionMode: "parallel",
      description: "Cancel (delete) one of the current user's scheduled tasks by its short ID.",
      promptSnippet: "cancel_scheduled_task: remove a scheduled task by ID.",
      parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 16 }) }),
      execute: async (_toolCallId, params) => {
        const removed = store.cancel(params.id, ownerUserId);
        return {
          content: [{ type: "text", text: removed ? `Cancelled task ${params.id}.` : `Task ${params.id} not found.` }],
          details: {},
        };
      },
    });
  };
}
