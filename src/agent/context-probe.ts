import { errorMessage } from "../errors.js";

/** llama.cpp 暴露的上下文信息；这里只取推断单请求上限所需的字段。 */
export interface LlamaContextProbe {
  /** 推断出的单个 slot 可用上下文（token）。 */
  contextWindow: number;
  /** 服务端并发 slot 数。 */
  slots: number;
}

/** 去掉 OpenAI 兼容前缀 `/v1`，得到 llama.cpp 自己的 HTTP 根路径。 */
function serverRoot(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Best-effort 探测 llama.cpp 的 `/props`：总上下文按并发 slot 数切分后，
 * 才是单个请求真正可用的上限。探测失败、超时或不是 llama.cpp 时返回 undefined，
 * 绝不阻断启动，也不修改任何配置。
 */
export async function probeLlamaContext(baseUrl: string, timeoutMs = 1_500): Promise<LlamaContextProbe | undefined> {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const response = await fetch(`${serverRoot(baseUrl)}/props`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return undefined;
    const record = body as Record<string, unknown>;
    const settings = record.default_generation_settings as Record<string, unknown> | undefined;
    const total = record.total_slots;
    const context = settings?.n_ctx;
    if (
      !settings ||
      typeof total !== "number" || !Number.isSafeInteger(total) || total < 1 ||
      typeof context !== "number" || !Number.isSafeInteger(context) || context < 1_024
    ) {
      return undefined;
    }
    const contextWindow = Math.floor(context / total);
    return contextWindow >= 1_024 ? { contextWindow, slots: total } : undefined;
  } catch (error) {
    // 普通 OpenAI 兼容服务没有 /props；这是预期情况，不记日志避免噪音。
    void errorMessage(error);
    return undefined;
  }
}
