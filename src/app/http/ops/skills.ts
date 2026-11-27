import type { FastifyInstance } from "fastify";
import { currentUser } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { sendJson } from "../respond.js";

/** 启用的技能列表对所有登录用户开放：全局 + 该用户个人，个人同名以 me: 命名空间共存。 */
export function registerSkillRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/skills", async (request, reply) => {
    const user = currentUser(request);
    if (!user) {
      sendJson(reply, 200, { items: [] });
      return;
    }
    await ctx.skillRegistry.ensureUser(user.id);
    const items = ctx.skillRegistry.listForUser(user.id)
      .filter((skill) => skill.enabled && skill.userInvocable && skill.status !== "missing");
    sendJson(reply, 200, { items });
  });
}
