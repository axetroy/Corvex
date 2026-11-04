import type { Copy } from "./i18n.js";

/** 单次运维请求的超时时间；Server 卡住时页面不会永久停在加载态。 */
const requestTimeoutMs = 20_000;

/** 从只读运维接口取 JSON；超时、网络失败与非 2xx 都会抛出可展示的错误。 */
export async function fetchJson<T>(path: string, copy: Copy): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { accept: "application/json" },
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
    const body = await response.text();
    throw new Error(
      copy.requestFailedTemplate
        .replace("{status}", String(response.status))
        .replace("{message}", body.trim() || response.statusText),
    );
  }
  return await response.json() as T;
}

/** 把未知的抛出值转换为可展示的错误文本。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
