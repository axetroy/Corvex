import type { FastifyInstance } from "fastify";
import { currentUser, requireUser } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { sendJson } from "../respond.js";
import { registerSkillManagementRoutes } from "./skill-management.js";

/** 个人技能：仅当前登录用户可读写，目录按用户 ID 隔离；路由与全局共用实现。 */
export function registerPersonalSkillRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.register(
    async (me) => {
      me.addHook("onRequest", async (request, reply) => {
        if (!requireUser(request, reply)) return reply;
      });

      registerSkillManagementRoutes(me, {
        storeForRequest: (request) => ctx.skillRegistry.forUser(currentUser(request)!.id),
        gitlabForRequest: (request) => ctx.gitlabForRequest(request),
        gitlabBaseUrl: ctx.config.gitlab.baseUrl,
      });

      // 合并视图供斜杠补全与调试：全局优先，个人同名以 me: 命名空间共存。
      me.get("/skills/all", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        await ctx.skillRegistry.ensureUser(user.id);
        sendJson(reply, 200, { items: ctx.skillRegistry.listForUser(user.id) });
      });
    },
    { prefix: "/api/ops/me" },
  );
}
