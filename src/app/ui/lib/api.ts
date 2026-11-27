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

/** 从只读接口取纯文本（如附件内容）；复用统一的鉴权失败与错误提示处理。 */
export async function fetchText(path: string, copy: Copy): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { accept: "text/plain" },
      cache: "no-store",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(copy.requestTimeoutTemplate.replace("{seconds}", String(requestTimeoutMs / 1000)), { cause: error });
    }
    throw error;
  }
  if (response.status === 401) {
    handleUnauthorized(response, await response.clone().text());
    throw new Error(copy.authRequired);
  }
  if (!response.ok) {
    throw new Error(copy.requestFailedTemplate
      .replace("{status}", String(response.status))
      .replace("{message}", (await response.text()).trim() || response.statusText));
  }
  return await response.text();
}

/** 以 JSON 请求体调用 Agent 控制台接口（PUT/POST）；错误信息取服务端返回的 error 字段。 */
export async function sendJson<T>(path: string, body: unknown, copy: Copy, method = "PUT"): Promise<T> {
  return await requestJson<T>(path, copy, { method, body });
}

/** 上传原始二进制（例如技能导入 ZIP）；同源 fetch 会自动带上控制台会话凭据。 */
export async function sendBinary<T>(path: string, body: ArrayBuffer, contentType: string, copy: Copy): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": contentType },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(copy.requestTimeoutTemplate.replace("{seconds}", String(requestTimeoutMs / 1000)), { cause: error });
    }
    throw error;
  }
  return await readResponse<T>(response, copy);
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
  return await readResponse<T>(response, copy);
}

/** 统一的响应处理：401 跳转、错误文案提取与 JSON 解析。 */
async function readResponse<T>(response: Response, copy: Copy): Promise<T> {
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
