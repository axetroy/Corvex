import { errorMessage } from "../../../errors.js";

/** 模型连接测试结果；错误细节截短，避免把上游返回的密钥或正文带回界面。 */
export interface ModelTestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  status?: number;
  models?: number;
}

function validHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    );
  } catch {
    return false;
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string }; message?: string };
    return (body.error?.message ?? body.message ?? response.statusText).slice(0, 300);
  } catch {
    return response.statusText.slice(0, 300);
  }
}

/** 供应商连接测试：读取 OpenAI 兼容的 /models 列表，不需要预先知道模型名。 */
export async function testProviderConnection(baseUrl: string, apiKey: string): Promise<ModelTestResult> {
  if (!validHttpUrl(baseUrl)) return { ok: false, message: "invalid base url", latencyMs: 0 };
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, message: await responseError(response), status: response.status, latencyMs };
    }
    const body = await response.json() as { data?: unknown[] };
    return {
      ok: true,
      message: "ok",
      models: Array.isArray(body.data) ? body.data.length : undefined,
      latencyMs,
    };
  } catch (error) {
    return { ok: false, message: errorMessage(error).slice(0, 300), latencyMs: Date.now() - started };
  }
}

/** 模型测试：用该模型发一次最小 chat 请求，验证名称、凭据与输出预算。 */
export async function testModelConnection(baseUrl: string, apiKey: string, modelName: string): Promise<ModelTestResult> {
  if (!validHttpUrl(baseUrl)) return { ok: false, message: "invalid base url", latencyMs: 0 };
  if (!modelName.trim()) return { ok: false, message: "model name is required", latencyMs: 0 };
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(apiKey) },
      body: JSON.stringify({
        model: modelName.trim(),
        messages: [{ role: "user", content: "Reply with OK" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, message: await responseError(response), status: response.status, latencyMs };
    }
    return { ok: true, message: "ok", latencyMs };
  } catch (error) {
    return { ok: false, message: errorMessage(error).slice(0, 300), latencyMs: Date.now() - started };
  }
}
