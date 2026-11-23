import type { FastifyInstance } from "fastify";
import type { OpsContext } from "../context.js";
import { sendJson } from "../respond.js";

/** 启用的技能列表对所有登录用户开放；增删改由管理员命名空间负责。 */
export function registerSkillRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/skills", async (_request, reply) => {
    sendJson(reply, 200, { items: ctx.store.listConversationSkills(true) });
  });
}
