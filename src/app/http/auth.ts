import type { FastifyInstance } from "fastify";
import type { CorvexConfig } from "../../config/config.js";
import { basicCredentialsMatch, sendText } from "./respond.js";

/** 控制台与运维 API 共用的 Basic 认证域。 */
const authenticationRealm = 'Basic realm="Corvex GitLab Cloud Agent", charset="UTF-8"';

/** 需要控制台凭据的路径前缀；其余健康检查与 webhook 保持公开。 */
function requiresOperationsAuth(pathname: string): boolean {
  return pathname === "/ops" || pathname.startsWith("/ops/") || pathname.startsWith("/api/ops/");
}

/**
 * 解析请求路径。使用 `URL` 而不是直接切分字符串，是为了和原实现一样先归一化
 * `..`，避免用 `/ops/../api/ops/...` 之类的路径绕过认证。
 */
function requestPathname(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

/**
 * 安装控制台认证钩子。凭据未配置时整个控制台（含 API）按「不存在」处理，
 * 避免暴露一个未受保护的管理面。
 */
export function attachOperationsAuth(app: FastifyInstance, config: CorvexConfig): void {
  app.addHook("onRequest", async (request, reply) => {
    const pathname = requestPathname(request.raw.url);
    if (!requiresOperationsAuth(pathname)) return;
    if (!config.operations.username || !config.operations.password) {
      sendText(reply, 404, "not found\n");
      return reply;
    }
    if (!basicCredentialsMatch(request.headers.authorization, config.operations.username, config.operations.password)) {
      reply.header("www-authenticate", authenticationRealm);
      sendText(reply, 401, "authentication required\n");
      return reply;
    }
  });
}
