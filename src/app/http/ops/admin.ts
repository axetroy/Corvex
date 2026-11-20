import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";

/**
 * 管理员接口统一挂在 `/api/ops/admin` 命名空间下。
 * 插件内的 onRequest 钩子对整个命名空间校验管理员身份。
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
      });

      admin.get("/users", async (_request, reply) => {
        sendJson(reply, 200, { items: ctx.store.listUsers() });
      });

      admin.put("/users/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const body = readJsonObject(request, reply);
        if (!body) return;
        if (typeof body.admin !== "boolean") {
          sendJson(reply, 400, { error: "admin must be a boolean" });
          return;
        }
        try {
          if (!ctx.store.setUserAdmin(id, body.admin)) {
            sendJson(reply, 404, { error: "user not found" });
            return;
          }
          sendJson(reply, 200, { userId: id, admin: body.admin });
        } catch (error) {
          sendJson(reply, 409, { error: error instanceof Error ? error.message : "could not update administrator" });
        }
      });
    },
    { prefix: "/api/ops/admin" },
  );
}
