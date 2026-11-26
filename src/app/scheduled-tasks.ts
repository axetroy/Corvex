import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import type { ConversationRunner } from "./conversation-runner.js";
import type { AppStore } from "../store.js";
import type { GitLabClient } from "../gitlab/client.js";
import type { ScheduledTask } from "../model.js";
import { errorMessage } from "../errors.js";
import { nextRunAt, nextRunAtInZone, parseCron, scheduleJitterMs, type CronSchedule } from "./schedule.js";

/** 调度器依赖；由 Server 注入，便于单测替换时间源与客户端解析。 */
export interface ScheduledTasksContext {
  config: CorvexConfig;
  store: AppStore;
  conversations: ConversationRunner;
  clientForUser: (userId: string) => Promise<GitLabClient | undefined>;
  now?: () => number;
}

/** tick 间隔：1 分钟粒度，30 秒检查一次足够及时且不浪费内存。 */
const tickIntervalMs = 30_000;

/**
 * 计划任务调度循环：到期任务作为一轮普通对话执行，复用 runTurn 的全部安全边界。
 * 不引入 cron 库；用可中止的 sleep 循环，与 Server 的 retention 任务同构。
 */
export class ScheduledTasksScheduler {
  private readonly now: () => number;
  /** 防止同一任务在单进程内被重复领取（DB 原子领取之外的第二道闸）。 */
  private readonly inFlight = new Set<string>();
  private readonly pending = new Set<Promise<void>>();
  /** 当前进程关闭信号；定时轮次与 HTTP 轮次一样，关服时应被中止。 */
  private shutdownSignal: AbortSignal = new AbortController().signal;

  constructor(private readonly ctx: ScheduledTasksContext) {
    this.now = ctx.now ?? Date.now;
  }

  /** 进程启动时把过期的 next_run_at 推到未来，避免重启后批量补跑错过的触发。 */
  recover(): void {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    for (const task of this.ctx.store.dueScheduledTasks(nowIso)) {
      // 一次性任务错过的触发不补跑，直接标完成；循环任务跳到 cron 推导的下一个未来时刻。
      const next = task.kind === "once"
        ? "9999-12-31T23:59:59.999Z"
        : this.advanceSchedule(task, new Date(nowMs));
      this.ctx.store.claimDueScheduledTask(task.id, task.nextRunAt, next);
    }
  }

  /** 手动触发一次（等价事件触发），复用与到期执行相同的授权与快照逻辑。 */
  async runNow(taskId: string): Promise<boolean> {
    const task = this.ctx.store.getScheduledTask(taskId);
    if (!task || task.status !== "active" || this.inFlight.has(taskId)) return false;
    this.inFlight.add(taskId);
    try {
      // 一次性任务直接删除；循环任务只记录本次运行，不改动下次触发时间。
      await this.execute(task, new Date(this.now()).toISOString(), true);
      return true;
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  /** 可中止的调度循环；由 Server.run() 的 finally abort 并 await。 */
  async run(signal: AbortSignal): Promise<void> {
    this.shutdownSignal = signal;
    while (!signal.aborted) {
      try {
        this.tick();
      } catch (error) {
        console.warn("scheduled tasks tick failed", { error: errorMessage(error) });
      }
      try {
        await sleep(tickIntervalMs, undefined, { signal });
      } catch {
        if (!signal.aborted) throw errorForSleep();
      }
    }
    // 关服时等在途任务收敛，避免 app.close() 后被后台轮次继续写库。
    await Promise.allSettled([...this.pending]);
  }

  /**
   * 执行一次到期扫描。注入 now 便于 hermetic 测试。
   * 先原子领取并推进 next_run_at，再执行；一次性任务执行后删除，循环任务重算下次时间。
   */
  tick(): void {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    for (const task of this.ctx.store.dueScheduledTasks(nowIso)) {
      if (this.inFlight.has(task.id)) continue;
      this.inFlight.add(task.id);
      // 不 await：多个任务并行触发，单任务失败不影响其它；finally 统一清理。
      const promise = this.execute(task, nowIso).finally(() => {
        this.inFlight.delete(task.id);
        this.pending.delete(promise);
      });
      this.pending.add(promise);
    }
  }

  /** 处理单个已到期的任务；手动触发时 keepSchedule=true 不改动下次触发时间。 */
  private async execute(task: ScheduledTask, dueAt: string, keepSchedule = false): Promise<void> {
    if (!keepSchedule) {
      const advanced = this.advanceSchedule(task, new Date(dueAt));
      const claimed = this.ctx.store.claimDueScheduledTask(task.id, task.nextRunAt, advanced);
      if (!claimed) return;
    }

    let status = "failed";
    let turnId = "";
    let errorText = "";
    try {
      const client = await this.ctx.clientForUser(task.ownerUserId);
      if (!client) throw new Error("the task owner's GitLab token is unavailable");
      const conversation = this.ctx.store.getConversation(task.conversationId);
      if (!conversation || conversation.ownerUserId !== task.ownerUserId) {
        throw new Error("the bound conversation is unavailable for this task owner");
      }
      // 到点重新取分支快照，不能用创建任务时的 SHA，否则轮次会被判 stale。
      const headSha = (await client.getBranch(conversation.projectId, conversation.targetBranch)).commit.id;
      const created = this.ctx.store.addConversationMessage(task.conversationId, {
        ownerUserId: task.ownerUserId,
        projectId: conversation.projectId,
        targetBranch: conversation.targetBranch,
        headSha,
        actorId: 0,
        request: task.prompt,
      });
      turnId = created.turnId;
      // 第五参 false：定时轮次不消费用户手动排队的消息。
      await this.ctx.conversations.runTurn(
        turnId, this.shutdownSignal, client, this.ctx.config.agent.responseLanguage, false,
      );
      status = "succeeded";
    } catch (error) {
      errorText = errorMessage(error);
      console.warn("scheduled task run failed", { taskId: task.id, error: errorText });
    } finally {
      this.ctx.store.completeScheduledTask({
        id: task.id,
        status,
        turnId,
        error: errorText,
        delete: task.kind === "once",
        finishedAt: new Date(this.now()).toISOString(),
      });
    }
  }

  /** 计算领取后写入的 next_run_at：一次性任务设为很远的未来（执行后即删除）；循环任务按 cron 推导。 */
  private advanceSchedule(task: ScheduledTask, dueAt: Date): string {
    if (task.kind === "once") return "9999-12-31T23:59:59.999Z";
    const schedule = parseCron(task.cron);
    if (!schedule) return new Date(dueAt.getTime() + 86_400_000).toISOString();
    const next = this.computeNext(schedule, task, dueAt);
    if (!next) return new Date(dueAt.getTime() + 86_400_000).toISOString();
    // 按任务 ID 确定性错峰：同一任务每次偏移一致，重启后仍稳定，不会逐次漂移。
    const jitter = scheduleJitterMs(task.id, dueAt, next, new Date(this.now()));
    return new Date(next.getTime() + jitter).toISOString();
  }

  /** 按任务时区选择下次时间计算方式；UTC 走原来的快速路径。 */
  private computeNext(schedule: CronSchedule, task: ScheduledTask, after: Date): Date | undefined {
    return task.timezone && task.timezone !== "UTC"
      ? nextRunAtInZone(schedule, after, task.timezone)
      : nextRunAt(schedule, after);
  }
}

function errorForSleep(): Error {
  return new Error("scheduled tasks timer failed");
}
