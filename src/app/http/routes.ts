import type { FastifyInstance } from "fastify";
import type { OpsContext } from "./context.js";
import { registerAuthRoutes } from "./auth-routes.js";
import { registerSetupRoutes } from "./setup.js";
import { registerOperationsUi } from "./operations-ui.js";
import { registerObservabilityRoutes } from "./ops/observability.js";
import { registerConversationRoutes } from "./ops/conversations.js";
import { registerAdminRoutes } from "./ops/admin.js";
import { registerModelRoutes } from "./ops/models.js";
import { registerUserModelRoutes } from "./ops/user-models.js";
import { registerProjectRoutes } from "./ops/projects.js";
import { registerSettingsRoutes } from "./ops/settings.js";
import { registerStorageRoutes } from "./ops/storage.js";
import { sendJson, sendText } from "./respond.js";
import { requireAdmin } from "../auth/context.js";
import { registerSystemRoutes } from "./system.js";
import { registerWebhookRoute, WebhookHandler } from "./webhook.js";

/**
 * 注册全部 HTTP 路由。
 *
 * 具体路由先注册，末尾的兜底路由负责还原原实现的语义：
 * `/api/ops/*` 未匹配 GET 返回 JSON 404、其它方法返回 JSON 405；
 * `/ops/*` 与 `/ops` 的非 GET/HEAD 方法返回文本 405；其余路径由
 * `setNotFoundHandler` 统一返回文本 404。
 */
export function registerRoutes(app: FastifyInstance, ctx: OpsContext): void {
  // 设置、模型目录与存储维护属于管理员能力；其它运维接口对所有登录用户开放。
  app.addHook("preHandler", async (request, reply) => {
    const path = new URL(request.raw.url ?? "/", "http://localhost").pathname;
    if (
      path.startsWith("/api/ops/settings") ||
      path.startsWith("/api/ops/model-providers") ||
      path.startsWith("/api/ops/storage/")
    ) {
      if (!requireAdmin(request, reply)) return reply;
    }
  });
  registerSystemRoutes(app, ctx.store);
  registerAuthRoutes(app, {
    oauth: ctx.oauth,
    store: ctx.store,
    secureCookie: (ctx.config.gitlab.oauthRedirectUri ?? "").startsWith("https:"),
  });
  registerSetupRoutes(app, { config: ctx.config, store: ctx.store, oauth: ctx.oauth });
  registerWebhookRoute(app, new WebhookHandler(ctx.config, ctx.store, ctx.gitlab, () => ctx.events.wake()));
  registerOperationsUi(app);

  registerProjectRoutes(app, ctx);
  registerConversationRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerUserModelRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerStorageRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerObservabilityRoutes(app, ctx);

  const otherMethods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

  app.route({
    method: ["GET"],
    url: "/api/ops/*",
    handler: async (_request, reply) => {
      sendJson(reply, 404, { error: "not found" });
    },
  });
  app.route({
    method: ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/api/ops/*",
    handler: async (_request, reply) => {
      sendJson(reply, 405, { error: "method not allowed" });
    },
  });

  // `/ops` 只接受 GET/HEAD；非 API 的未知控制台路径统一 404。
  app.route({
    method: [...otherMethods],
    url: "/ops",
    handler: async (_request, reply) => {
      sendText(reply, 405, "method not allowed\n");
    },
  });
  app.route({
    method: [...otherMethods],
    url: "/ops/",
    handler: async (_request, reply) => {
      sendText(reply, 405, "method not allowed\n");
    },
  });
  app.route({
    method: [...otherMethods],
    url: "/ops/*",
    handler: async (_request, reply) => {
      sendText(reply, 405, "method not allowed\n");
    },
  });
}
