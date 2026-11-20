import type { FastifyInstance } from "fastify";
import { currentUser, setCurrentUser } from "../auth/context.js";
import type { GitLabOAuthService } from "../auth/service.js";
import type { EventStore } from "../../events/store.js";
import type { TokenCipher } from "../../tokens.js";
import { sendJson } from "./respond.js";

/** 控制台与运维 API 共用的会话 Cookie 名。 */
export const sessionCookieName = "corvex_session";
/** OAuth CSRF state Cookie 名。 */
export const oauthStateCookieName = "corvex_oauth_state";
/** 会话有效期：7 天。 */
export const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

export interface OperationsAuthContext {
  store: EventStore;
  cipher: TokenCipher;
  oauth: GitLabOAuthService;
}

/** 需要登录的路径前缀；健康检查、Webhook 与 OAuth 回调保持公开。 */
function requiresOperationsAuth(pathname: string): boolean {
  // 构建产物是公开静态资源；安装页与控制台都从 /ops/assets 加载它们。
  if (pathname.startsWith("/ops/assets/")) return false;
  return pathname === "/ops" || pathname.startsWith("/ops/") || pathname.startsWith("/api/ops/");
}

function requestPathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/** 读取请求 Cookie；重复的 Cookie 名取第一个。 */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

/** 安装基于 GitLab OAuth 会话的控制台认证钩子。 */
export function attachOperationsAuth(app: FastifyInstance, ctx: OperationsAuthContext): void {
  app.addHook("onRequest", async (request, reply) => {
    const pathname = requestPathname(request.raw.url);
    const sessionId = readCookie(request.headers.cookie, sessionCookieName);
    if (sessionId) {
      const session = ctx.store.readUserSession(sessionId);
      const user = session ? ctx.store.readUser(session.userId, ctx.cipher) : undefined;
      if (user) {
        setCurrentUser(request, await ctx.oauth.refresh(user));
      }
    }
    if (!requiresOperationsAuth(pathname)) return;
    const user = currentUser(request);
    if (!user && !ctx.oauth.configured) {
      if (pathname.startsWith("/api/ops/")) {
        sendJson(reply, 401, { error: "setup required", setupRequired: true });
        return reply;
      }
      // 页面交给前端：控制台会按 hash 路由跳到 #/setup。
      return;
    }
    if (user) return;
    if (pathname.startsWith("/api/ops/")) {
      sendJson(reply, 401, { error: "authentication required" });
      return reply;
    }
    reply.code(302).header("location", "/auth/gitlab").send();
    return reply;
  });
}
