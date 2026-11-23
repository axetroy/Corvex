/** 从 OpenAI 兼容 Base URL 推导模型服务根地址，/tokenize 等端点不在 /v1 下。 */
export function providerRootUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export interface TokenCounter {
  /** 返回真实 token 数；服务不支持或失败时返回 undefined，调用方回退启发式估算。 */
  count(text: string, signal?: AbortSignal): Promise<number | undefined>;
  /** 是否已探测到服务支持 token 计数。 */
  readonly available: boolean;
}

const tokenizeTimeoutMs = 1_500;

/**
 * 优先使用模型服务自带的 token 计数接口（如 llama.cpp 的 `/tokenize`）。
 * 探测失败后缓存“不可用”，避免每次请求都多打一次网络。
 */
export function createProviderTokenCounter(baseUrl: string): TokenCounter {
  let available: boolean | undefined;
  let root = "";
  try {
    root = providerRootUrl(baseUrl);
  } catch {
    root = "";
  }
  return {
    get available() {
      return available === true;
    },
    async count(text: string, signal?: AbortSignal) {
      if (available === false || !root || !text) return undefined;
      try {
        const timeout = AbortSignal.timeout(tokenizeTimeoutMs);
        const response = await fetch(`${root}/tokenize`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ content: text, add_special: false }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          cache: "no-store",
        });
        if (!response.ok) {
          available = false;
          return undefined;
        }
        const body: unknown = await response.json();
        const tokens = body && typeof body === "object" && (body as Record<string, unknown>).tokens;
        if (!Array.isArray(tokens)) {
          available = false;
          return undefined;
        }
        available = true;
        return tokens.length;
      } catch {
        available = false;
        return undefined;
      }
    },
  };
}
