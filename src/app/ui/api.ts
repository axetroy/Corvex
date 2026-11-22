import type { Copy } from "./i18n.js";

/** 单次运维请求的超时时间；Server 卡住时页面不会永久停在加载态。 */
const requestTimeoutMs = 20_000;
/** 并发请求同时收到 401 时只跳转一次。 */
let authRedirectPending = false;

/**
 * 接口返回 401 时把页面送到登录入口（尚未配置 OAuth 时去安装向导）。
 * API 继续保持 401 JSON 语义：若改成 302，fetch 会自动跟随并拿到 HTML，调用方无法区分。
 */
export function handleUnauthorized(response: Response, body?: string): void {
  if (response.status !== 401 || typeof window === "undefined" || authRedirectPending) return;
  let setupRequired = false;
  if (body) {
    try {
      const parsed: unknown = JSON.parse(body);
      setupRequired = Boolean(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).setupRequired);
    } catch {
      // 非 JSON 响应按普通登录失败处理。
    }
  }
  if (setupRequired && window.location.hash === "#/setup") return;
  authRedirectPending = true;
  window.location.assign(setupRequired ? "/ops/#/setup" : "/auth/gitlab");
}

/** 从只读 Agent 控制台接口取 JSON；超时、网络失败与非 2xx 都会抛出可展示的错误。 */
export async function fetchJson<T>(path: string, copy: Copy): Promise<T> {
  return await requestJson<T>(path, copy);
}

/** 以 JSON 请求体调用 Agent 控制台接口（PUT/POST）；错误信息取服务端返回的 error 字段。 */
export async function sendJson<T>(path: string, body: unknown, copy: Copy, method = "PUT"): Promise<T> {
  return await requestJson<T>(path, copy, { method, body });
}

async function requestJson<T>(
  path: string,
  copy: Copy,
  init?: { method: string; body: unknown },
): Promise<T> {
  let response: Response;
  const headers: Record<string, string> = { accept: "application/json" };
  if (init) headers["content-type"] = "application/json";
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers,
      body: init ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(copy.requestTimeoutTemplate.replace("{seconds}", String(requestTimeoutMs / 1000)), {
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    const text = (await response.text()).trim();
    handleUnauthorized(response, text);
    if (response.status === 401) throw new Error(copy.authRequired);
    let message = text || response.statusText;
    // Agent 控制台接口以 {"error": "..."} 返回失败原因；优先展示该字段而不是原始 JSON。
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const value = (parsed as Record<string, unknown>).error;
        if (typeof value === "string" && value.trim()) message = value.trim();
      }
    } catch {
      // 非 JSON 响应体保持原文。
    }
    throw new Error(
      copy.requestFailedTemplate
        .replace("{status}", String(response.status))
        .replace("{message}", message),
    );
  }
  return await response.json() as T;
}
