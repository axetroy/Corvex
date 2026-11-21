import type { FastifyInstance, FastifyReply } from "fastify";
import type { OpsContext } from "../context.js";
import { testModelConnection, testProviderConnection } from "./model-test.js";
import { idParam, readJsonObject, secretSettingPlaceholder, sendJson } from "../respond.js";

/** 接口不回显 API Key：有值时只显示占位符，空值保持为空。 */
function redactProvider<T extends { apiKey: string }>(provider: T): T {
  return { ...provider, apiKey: provider.apiKey ? secretSettingPlaceholder : "" };
}

function httpUrl(raw: string): boolean {
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

function parseProviderBody(
  body: Record<string, unknown>,
): { name: string; baseUrl: string; apiKey: string } | undefined {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!name || name.length > 200 || !baseUrl || baseUrl.length > 500 || apiKey.length > 2_000) return undefined;
  if (!httpUrl(baseUrl)) return undefined;
  return { name, baseUrl, apiKey };
}

function parseModelBody(
  body: Record<string, unknown>,
): { name: string; contextWindow: number; maxOutputTokens: number } | undefined {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const contextWindow = body.contextWindow;
  const maxOutputTokens = body.maxOutputTokens;
  if (!name || name.length > 200) return undefined;
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1_024 || contextWindow > 10_000_000) return undefined;
  if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8_192) return undefined;
  return { name, contextWindow, maxOutputTokens };
}

function methodNotAllowed(reply: FastifyReply): void {
  sendJson(reply, 405, { error: "method not allowed" });
}

/** Web 模型目录：供应商持有连接参数，供应商下挂模型；接口不回显 API Key。 */
export function registerModelRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/model-providers", async (_request, reply) => {
    sendJson(reply, 200, { items: ctx.store.listModelProviders().map((provider) => redactProvider(provider)) });
  });

  // 静态 /test 路径优先于下方的 /:id 参数路由。
  app.post("/api/ops/model-providers/test", async (request, reply) => {
    const body = readJsonObject(request, reply);
    if (!body) return;
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    sendJson(reply, 200, await testProviderConnection(baseUrl, apiKey));
  });

  app.post("/api/ops/model-providers/:id/models/test", async (request, reply) => {
    const providerId = idParam((request.params as { id: string }).id);
    const body = readJsonObject(request, reply);
    if (!providerId || !body) return;
    const provider = ctx.store.getModelProvider(providerId);
    if (!provider) {
      sendJson(reply, 404, { error: "model provider not found" });
      return;
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const apiKey = typeof body.apiKey === "string" && body.apiKey && body.apiKey !== secretSettingPlaceholder
      ? body.apiKey
      : provider.apiKey;
    sendJson(reply, 200, await testModelConnection(provider.baseUrl, apiKey, name));
  });

  app.post("/api/ops/model-providers", async (request, reply) => {
    const body = readJsonObject(request, reply);
    if (!body) return;
    const input = parseProviderBody(body);
    if (!input) {
      sendJson(reply, 400, { error: "invalid model provider" });
      return;
    }
    const provider = ctx.store.createModelProvider(input);
    sendJson(reply, 201, redactProvider(provider));
  });

  app.put("/api/ops/model-providers/:id", async (request, reply) => {
    const providerId = idParam((request.params as { id: string }).id);
    const body = readJsonObject(request, reply);
    if (!providerId || !body) return;
    const input = parseProviderBody(body);
    if (!input) {
      sendJson(reply, 400, { error: "invalid model provider" });
      return;
    }
    const existing = ctx.store.getModelProvider(providerId);
    if (!existing) {
      sendJson(reply, 404, { error: "model provider not found" });
      return;
    }
    // API Key 留空表示保留原值。
    if (!input.apiKey) input.apiKey = existing.apiKey;
    const updated = ctx.store.updateModelProvider(providerId, input);
    if (!updated) {
      sendJson(reply, 404, { error: "model provider not found" });
      return;
    }
    ctx.settings.applyActiveModel();
    sendJson(reply, 200, redactProvider(updated));
  });

  app.delete("/api/ops/model-providers/:id", async (request, reply) => {
    const providerId = idParam((request.params as { id: string }).id);
    if (!providerId) {
      methodNotAllowed(reply);
      return;
    }
    if (!ctx.store.deleteModelProvider(providerId)) {
      sendJson(reply, 404, { error: "model provider not found" });
      return;
    }
    ctx.settings.applyActiveModel();
    sendJson(reply, 200, { deleted: true });
  });

  app.post("/api/ops/model-providers/:id/models", async (request, reply) => {
    const providerId = idParam((request.params as { id: string }).id);
    const body = readJsonObject(request, reply);
    if (!providerId || !body) return;
    const input = parseModelBody(body);
    if (!input) {
      sendJson(reply, 400, { error: "invalid model" });
      return;
    }
    const model = ctx.store.createProviderModel(providerId, input);
    if (!model) {
      sendJson(reply, 404, { error: "model provider not found" });
      return;
    }
    if (model.active) ctx.settings.applyActiveModel();
    sendJson(reply, 201, model);
  });

  app.put("/api/ops/model-providers/:id/models/:modelId", async (request, reply) => {
    const params = request.params as { id: string; modelId: string };
    const providerId = idParam(params.id);
    const modelId = idParam(params.modelId);
    const body = readJsonObject(request, reply);
    if (!providerId || !modelId || !body) return;
    const input = parseModelBody(body);
    if (!input) {
      sendJson(reply, 400, { error: "invalid model" });
      return;
    }
    const updated = ctx.store.updateProviderModel(providerId, modelId, input);
    if (!updated) {
      sendJson(reply, 404, { error: "model not found" });
      return;
    }
    if (updated.active) ctx.settings.applyActiveModel();
    sendJson(reply, 200, updated);
  });

  app.delete("/api/ops/model-providers/:id/models/:modelId", async (request, reply) => {
    const params = request.params as { id: string; modelId: string };
    const providerId = idParam(params.id);
    const modelId = idParam(params.modelId);
    if (!providerId || !modelId) {
      methodNotAllowed(reply);
      return;
    }
    if (!ctx.store.deleteProviderModel(providerId, modelId)) {
      sendJson(reply, 404, { error: "model not found" });
      return;
    }
    ctx.settings.applyActiveModel();
    sendJson(reply, 200, { deleted: true });
  });

  app.post("/api/ops/model-providers/:id/models/:modelId/activate", async (request, reply) => {
    const params = request.params as { id: string; modelId: string };
    const providerId = idParam(params.id);
    const modelId = idParam(params.modelId);
    if (!providerId || !modelId) {
      methodNotAllowed(reply);
      return;
    }
    const model = ctx.store.activateProviderModel(providerId, modelId);
    if (!model) {
      sendJson(reply, 404, { error: "model not found" });
      return;
    }
    ctx.settings.applyActiveModel();
    sendJson(reply, 200, model);
  });

  // 供应商组的其它路径/方法保持原有的 405 语义。
  app.all("/api/ops/model-providers/*", async (_request, reply) => {
    methodNotAllowed(reply);
  });
}
