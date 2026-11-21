import type { FastifyReply, FastifyRequest } from "fastify";
import { sendJson } from "../http/respond.js";
import type { AuthUser } from "./model.js";

/** 每个请求的登录用户由认证钩子写入，路由通过 WeakMap 读取，避免污染请求对象类型。 */
const users = new WeakMap<FastifyRequest, AuthUser>();

export function setCurrentUser(request: FastifyRequest, user: AuthUser): void {
  users.set(request, user);
}

export function currentUser(request: FastifyRequest): AuthUser | undefined {
  return users.get(request);
}

/** 需要登录的运维接口统一入口；未登录返回 401 JSON。 */
export function requireUser(request: FastifyRequest, reply: FastifyReply): AuthUser | undefined {
  const user = currentUser(request);
  if (!user) {
    sendJson(reply, 401, { error: "authentication required" });
    return undefined;
  }
  return user;
}

/** 需要管理员的运维接口统一入口；非管理员返回 403。 */
export function requireAdmin(request: FastifyRequest, reply: FastifyReply): AuthUser | undefined {
  const user = requireUser(request, reply);
  if (!user) return undefined;
  if (!user.isAdmin) {
    sendJson(reply, 403, { error: "administrator access required" });
    return undefined;
  }
  return user;
}
