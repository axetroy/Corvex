import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { secretRuntimeSettingKeys, type RuntimeSettingValue } from "../../config/settings.js";
import { errorMessage } from "../../errors.js";
import { GitLabApiError } from "../../gitlab/client.js";

/** 设置接口中的密钥占位符；真实值从不离开进程。 */
export const secretSettingPlaceholder = "••••••";

/** 设置接口不回显密钥原文；有值时只给占位符，UI 据此显示「已配置」。 */
export function redactSettingValues(
  values: Record<string, RuntimeSettingValue>,
): Record<string, RuntimeSettingValue> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      // 值字段始终为空，避免前端把它当成真实密钥提交回去。
      secretRuntimeSettingKeys.has(key) ? "" : value,
    ]),
  );
}

/** 纯文本响应；状态码与 content-type 与原实现保持一致。 */
export function sendText(reply: FastifyReply, status: number, body: string): void {
  void reply
    .code(status)
    .header("content-type", "text/plain; charset=utf-8")
    .send(body);
}

/** JSON 响应：统一禁用缓存并补充安全响应头。 */
export function sendJson(reply: FastifyReply, status: number, value: unknown): void {
  void reply
    .code(status)
    .header("content-type", "application/json; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "no-referrer")
    .send(JSON.stringify(value));
}

/** Webhook 响应同时记录日志，方便按状态追踪 GitLab 回调结果。 */
export function sendWebhook(
  reply: FastifyReply,
  status: number,
  body: string,
  details: Record<string, string | number | boolean> = {},
): void {
  console.info("GitLab webhook response", { status, ...details });
  sendText(reply, status, body);
}

/** 常量时间比较控制台 Basic 凭据。 */
export function basicCredentialsMatch(
  authorization: string | undefined,
  username: string,
  password: string,
): boolean {
  const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]!, "base64");
  if (provided.toString("base64") !== match[1]) return false;
  const expected = Buffer.from(`${username}:${password}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** 读取单个请求头；重复头取第一个。 */
export function headerValue(
  headers: FastifyRequest["headers"],
  name: string,
): string {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export function optionalInteger(
  value: string | null,
  minimum: number,
  maximum: number,
): number | undefined | false {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : false;
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 读取查询参数；重复参数取第一个，缺失返回 null（与 URLSearchParams.get 一致）。 */
export function queryParam(query: unknown, name: string): string | null {
  const value = (query as Record<string, unknown> | null)?.[name];
  if (value === undefined) return null;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}

/** `/api/ops` 请求体上限：与原有实现一致，控制台接口不接受大请求体。 */
const operationsBodyBytes = 32 << 10;

/**
 * 读取 `/api/ops` 的 JSON 对象请求体。
 *
 * Fastify 已把请求体读成 Buffer，这里保留原有的内容类型、大小与对象结构校验：
 * 非 JSON 请求返回 415，超限返回 400，非法 JSON 或非对象返回 400。
 */
export function readJsonObject(
  request: FastifyRequest,
  reply: FastifyReply,
): Record<string, unknown> | undefined {
  const contentType = headerValue(request.headers, "content-type");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(reply, 415, { error: "application/json is required" });
    return undefined;
  }
  const raw = Buffer.isBuffer(request.body)
    ? request.body
    : typeof request.body === "string"
      ? Buffer.from(request.body)
      : Buffer.alloc(0);
  if (raw.byteLength > operationsBodyBytes) {
    sendJson(reply, 400, { error: `request payload exceeds ${operationsBodyBytes} bytes` });
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      sendJson(reply, 400, { error: "request body must be a JSON object" });
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch (error) {
    sendJson(reply, 400, { error: errorMessage(error) });
    return undefined;
  }
}

/** 校验路径参数：空值或超过 128 个字符视为非法。 */
export function idParam(value: string | undefined): string | undefined {
  return value && value.length <= 128 ? value : undefined;
}

/** `/api/ops` 读取 GitLab 失败时的统一响应。 */
export function sendGitLabReadError(reply: FastifyReply, error: unknown): void {
  if (error instanceof GitLabApiError && [401, 403, 404].includes(error.status)) {
    sendJson(reply, 404, { error: "GitLab resource is not available to the configured token" });
    return;
  }
  console.warn("operations GitLab read failed", { error: errorMessage(error) });
  sendJson(reply, 502, { error: "GitLab request failed" });
}
