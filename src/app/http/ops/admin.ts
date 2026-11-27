import type { FastifyInstance } from "fastify";
import { currentUser, requireAdmin } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";
import { registerSkillManagementRoutes } from "./skill-management.js";


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
        const hasAdmin = body.admin !== undefined;
        const hasDisabled = body.disabled !== undefined;
        if (!hasAdmin && !hasDisabled) {
          sendJson(reply, 400, { error: "admin or disabled is required" });
          return;
        }
        if (hasAdmin && typeof body.admin !== "boolean") {
          sendJson(reply, 400, { error: "admin must be a boolean" });
          return;
        }
        if (hasDisabled && typeof body.disabled !== "boolean") {
          sendJson(reply, 400, { error: "disabled must be a boolean" });
          return;
        }
        const actor = currentUser(request);
        // 管理员不能取消自己的管理员身份，避免把自己锁在管理后台之外。
        if (hasAdmin && body.admin === false && actor?.id === id) {
          sendJson(reply, 403, { error: "you cannot revoke your own administrator access" });
          return;
        }
        // 管理员不能禁用自己；要禁用必须先由他人取消管理员身份。
        if (hasDisabled && body.disabled === true && actor?.id === id) {
          sendJson(reply, 403, { error: "an administrator cannot disable itself; revoke admin first" });
          return;
        }
        try {
          if (hasAdmin) {
            if (!ctx.store.setUserAdmin(id, body.admin as boolean, actor?.id)) {
              sendJson(reply, 404, { error: "user not found" });
              return;
            }
          }
          if (hasDisabled) {
            if (!ctx.store.setUserDisabled(id, body.disabled as boolean)) {
              sendJson(reply, 404, { error: "user not found" });
              return;
            }
          }
          sendJson(reply, 200, { userId: id, ...(hasAdmin ? { admin: body.admin } : {}), ...(hasDisabled ? { disabled: body.disabled } : {}) });
        } catch (error) {
          sendJson(reply, 409, { error: error instanceof Error ? error.message : "could not update user" });
        }
      });

      // Global skills are admin-only; disk storage and lock file come from the shared routes.
      registerSkillManagementRoutes(admin, {
        storeForRequest: () => ctx.skills,
        gitlabForRequest: (request) => ctx.gitlabForRequest(request),
        gitlabBaseUrl: ctx.config.gitlab.baseUrl,
      });

      // 执行环境配置：管理员专属，保存前走完整 fail-closed 校验。
      admin.get("/execution", async (_request, reply) => {
        sendJson(reply, 200, ctx.executionConfig.read());
      });

      admin.put("/execution", async (request, reply) => {
        const body = readJsonObject(request, reply);
        if (!body) return;
        const actor = currentUser(request)?.username ?? "admin";
        const result = ctx.executionConfig.save(body, actor);
        if (!result.ok) {
          sendJson(reply, 400, { error: result.error });
          return;
        }
        sendJson(reply, 200, result.payload);
      });

      admin.delete("/execution", async (_request, reply) => {
        sendJson(reply, 200, ctx.executionConfig.reset());
      });

      // 存储管理：只读扫描镜像与工作树目录，大小/修改时间为扫描瞬间的近似值。
      admin.get("/storage", async (_request, reply) => {
        try {
          const storage = await ctx.conversations.describeStorage();
          sendJson(reply, 200, {
            ...storage,
            workspaceSizeLimitBytes: ctx.config.storage.conversationWorkspaceMaxMb * 1024 * 1024,
          });
        } catch (error) {
          sendJson(reply, 500, { error: error instanceof Error ? error.message.slice(0, 8000) : "storage scan failed" });
        }
      });
    },
    { prefix: "/api/ops/admin" },
  );
}
