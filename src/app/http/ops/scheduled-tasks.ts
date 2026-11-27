import type { FastifyInstance } from "fastify";
import { requireUser } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";
import { isValidTimeZone, nextRunAt, nextRunAtInZone, parseCron, parseRunAt } from "../../schedule.js";

/** 个人计划任务 API：按 owner 隔离，任务只属于当前登录用户。 */
export function registerScheduledTaskRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.register(
    async (me) => {
      me.addHook("onRequest", async (request, reply) => {
        if (!requireUser(request, reply)) return reply;
      });

      me.get("/scheduled-tasks", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const items = ctx.store.listScheduledTasks(user.id).map((task) => {
          const conversation = ctx.store.getConversation(task.conversationId);
          return {
            ...task,
            projectName: conversation?.projectName ?? "",
            targetBranch: conversation?.targetBranch ?? "",
            conversationTitle: conversation?.title ?? "",
          };
        });
        sendJson(reply, 200, { items });
      });

      me.get("/scheduled-tasks/:id/runs", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const id = (request.params as { id: string }).id;
        const task = ctx.store.getScheduledTask(id);
        if (!task || task.ownerUserId !== user.id) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        sendJson(reply, 200, { items: ctx.store.listScheduledTaskRuns(id) });
      });

      me.post("/scheduled-tasks", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const body = readJsonObject(request, reply);
        if (!body) return;
        const conversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : "";
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const recurring = body.recurring === true;
        const timezone = typeof body.timezone === "string" && body.timezone.trim()
          ? body.timezone.trim() : "UTC";
        if (!isValidTimeZone(timezone)) {
          sendJson(reply, 400, { error: "invalid IANA timezone" });
          return;
        }
        const schedule = typeof body.schedule === "string" ? body.schedule.trim() : "";
        if (!conversationId || !prompt || prompt.length > 8_000 || !schedule || schedule.length > 200) {
          sendJson(reply, 400, { error: "conversationId, prompt and schedule are required" });
          return;
        }
        if (ctx.store.getConversation(conversationId)?.ownerUserId !== user.id) {
          sendJson(reply, 404, { error: "conversation not found" });
          return;
        }
        const now = Date.now();
        let kind: "once" | "cron";
        let cron = "";
        let runAt = "";
        let next: Date | undefined;
        if (recurring) {
          const parsed = parseCron(schedule);
          if (!parsed) {
            sendJson(reply, 400, { error: "invalid cron expression" });
            return;
          }
          kind = "cron";
          cron = schedule;
          next = timezone === "UTC" ? nextRunAt(parsed, new Date(now)) : nextRunAtInZone(parsed, new Date(now), timezone);
        } else {
          const parsed = parseRunAt(schedule, new Date(now));
          if (!parsed || parsed.getTime() <= now) {
            sendJson(reply, 400, { error: "invalid or past run time" });
            return;
          }
          kind = "once";
          runAt = parsed.toISOString();
          next = parsed;
        }
        if (!next) {
          sendJson(reply, 400, { error: "schedule never fires" });
          return;
        }
        const task = ctx.store.createScheduledTask({
          ownerUserId: user.id, conversationId, prompt, kind, cron, timezone, runAt,
          nextRunAt: next.toISOString(),
          expiresAt: recurring ? new Date(now + 30 * 86_400_000).toISOString() : "",
        });
        sendJson(reply, 201, task);
      });

      me.put("/scheduled-tasks/:id", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const id = (request.params as { id: string }).id;
        const task = ctx.store.getScheduledTask(id);
        if (!task || task.ownerUserId !== user.id) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        if (task.status === "done") {
          sendJson(reply, 409, { error: "completed tasks cannot be edited" });
          return;
        }
        const body = readJsonObject(request, reply);
        if (!body) return;
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        const schedule = typeof body.schedule === "string" ? body.schedule.trim() : "";
        const timezone = typeof body.timezone === "string" && body.timezone.trim()
          ? body.timezone.trim() : task.timezone;
        if (!prompt || prompt.length > 8_000 || !schedule || schedule.length > 200) {
          sendJson(reply, 400, { error: "prompt and schedule are required" });
          return;
        }
        if (!isValidTimeZone(timezone)) {
          sendJson(reply, 400, { error: "invalid IANA timezone" });
          return;
        }
        const now = Date.now();
        // 是否循环由计划字符串本身决定：合法 5 段 cron 即循环，否则按一次性时间解析。
        const cronSchedule = parseCron(schedule);
        let kind: "once" | "cron";
        let cron = "";
        let runAt = "";
        let next: Date | undefined;
        if (cronSchedule) {
          kind = "cron";
          cron = schedule;
          next = timezone === "UTC" ? nextRunAt(cronSchedule, new Date(now)) : nextRunAtInZone(cronSchedule, new Date(now), timezone);
        } else {
          const parsed = parseRunAt(schedule, new Date(now));
          if (!parsed || parsed.getTime() <= now) {
            sendJson(reply, 400, { error: "invalid schedule: expected a 5-field cron or a future time" });
            return;
          }
          kind = "once";
          runAt = parsed.toISOString();
          next = parsed;
        }
        if (!next) {
          sendJson(reply, 400, { error: "schedule never fires" });
          return;
        }
        const updated = ctx.store.updateScheduledTask(id, {
          prompt, kind, cron, timezone, runAt,
          nextRunAt: next.toISOString(),
          expiresAt: kind === "cron" ? new Date(now + 30 * 86_400_000).toISOString() : "",
        });
        if (!updated) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        sendJson(reply, 200, updated);
      });

      me.post("/scheduled-tasks/:id/cancel", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const id = (request.params as { id: string }).id;
        const task = ctx.store.getScheduledTask(id);
        if (!task || task.ownerUserId !== user.id) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        ctx.store.setScheduledTaskStatus(id, user.id, "paused");
        sendJson(reply, 200, { id, paused: true });
      });

      me.post("/scheduled-tasks/:id/resume", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const id = (request.params as { id: string }).id;
        const task = ctx.store.getScheduledTask(id);
        if (!task || task.ownerUserId !== user.id) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        if (!ctx.store.setScheduledTaskStatus(id, user.id, "active")) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        // 暂停期间可能已错过触发：只把该任务的 next_run_at 推到未来，避免恢复后立刻补跑。
        ctx.store.advanceScheduledTaskIfOverdue(id, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
        sendJson(reply, 200, { id, resumed: true });
      });

      me.post("/scheduled-tasks/:id/run", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const id = (request.params as { id: string }).id;
        const task = ctx.store.getScheduledTask(id);
        if (!task || task.ownerUserId !== user.id) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        if (task.status !== "active") {
          sendJson(reply, 409, { error: "only active tasks can be run" });
          return;
        }
        const started = await ctx.runScheduledTaskNow(id);
        if (!started) {
          sendJson(reply, 409, { error: "task is already running" });
          return;
        }
        sendJson(reply, 202, { id, started: true });
      });

      me.delete("/scheduled-tasks/:id", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const id = (request.params as { id: string }).id;
        if (!ctx.store.deleteScheduledTask(id, user.id)) {
          sendJson(reply, 404, { error: "scheduled task not found" });
          return;
        }
        sendJson(reply, 200, { id, deleted: true });
      });
    },
    { prefix: "/api/ops/me" },
  );
}
