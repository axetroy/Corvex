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
        sendJson(reply, 200, { items: ctx.store.listScheduledTasks(user.id) });
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
