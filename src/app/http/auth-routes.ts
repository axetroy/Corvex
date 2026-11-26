import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { currentUser } from "../auth/context.js";
import { UserDisabledError, type GitLabOAuthService } from "../auth/service.js";
import type { AppStore } from "../../store.js";
import {
  oauthStateCookieName,
  readCookie,
  sessionCookieName,
  sessionMaxAgeSeconds,
} from "./auth.js";
import { sendJson, sendText } from "./respond.js";

interface AuthRoutesContext {
  oauth: GitLabOAuthService;
  store: AppStore;
  /** Cookie 是否必须带 Secure；由 OAuth 回调地址推断。 */
  secureCookie: boolean;
}

/** 注册 GitLab OAuth 登录、回调、登出与当前用户接口。 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AuthRoutesContext): void {
  app.get("/auth/gitlab", async (_request, reply) => {
    if (!ctx.oauth.configured) {
      sendText(reply, 503, "GitLab OAuth is not configured\n");
      return;
    }
    const state = randomBytes(24).toString("base64url");
    reply.header(
      "set-cookie",
      `${oauthStateCookieName}=${encodeURIComponent(state)}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${ctx.secureCookie ? "; Secure" : ""}`,
    );
    reply.code(302).header("location", ctx.oauth.authorizationUrl(state));
  });

  app.get("/auth/gitlab/callback", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const code = typeof query.code === "string" ? query.code : "";
    const state = typeof query.state === "string" ? query.state : "";
    const expected = readCookie(request.headers.cookie, oauthStateCookieName);
    reply.header(
      "set-cookie",
      `${oauthStateCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${ctx.secureCookie ? "; Secure" : ""}`,
    );
    if (!state || !expected || state !== expected) {
      sendText(reply, 400, "invalid OAuth state\n");
      return;
    }
    try {
      const { sessionId } = await ctx.oauth.complete(code);
      reply.header(
        "set-cookie",
        `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; SameSite=Lax${ctx.secureCookie ? "; Secure" : ""}`,
      );
      reply.code(302).header("location", "/ops#/conversations");
    } catch (error) {
      if (error instanceof UserDisabledError) {
        sendText(reply, 403, "This account has been disabled. Contact an administrator.\n");
        return;
      }
      console.error("GitLab OAuth callback failed", { error: String(error) });
      sendText(reply, 502, "GitLab login failed\n");
    }
  });

  app.post("/auth/logout", async (request, reply) => {
    const sessionId = readCookie(request.headers.cookie, sessionCookieName);
    if (sessionId) ctx.store.deleteUserSession(sessionId);
    reply.header(
      "set-cookie",
      `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${ctx.secureCookie ? "; Secure" : ""}`,
    );
    sendJson(reply, 200, { loggedOut: true });
  });

  /** 前端路由守卫用的轻量状态检查：始终 200，让界面在渲染受保护页面前判断是否需要登录。 */
  app.get("/api/auth/status", async (request, reply) => {
    const user = currentUser(request);
    sendJson(reply, 200, {
      authenticated: Boolean(user),
      oauthConfigured: ctx.oauth.configured,
      setupRequired: !ctx.oauth.configured,
    });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const user = currentUser(request);
    if (!user) {
      // 带上 setupRequired，让前端 401 处理器在未配置 OAuth 时去安装向导而不是登录页。
      sendJson(reply, 401, {
        error: "authentication required",
        setupRequired: !ctx.oauth.configured,
      });
      return;
    }
    sendJson(reply, 200, {
      id: user.id,
      gitlabUserId: user.gitlabUserId,
      username: user.username,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isAdmin: user.isAdmin,
    });
  });
}
