import type { FastifyInstance, FastifyReply } from "fastify";
import { requireUser } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { isThinkingLevel, type ModelProviderDetails } from "../../../model.js";
import { idParam, readJsonObject, secretSettingPlaceholder, sendJson } from "../respond.js";
import { testModelConnection, testProviderConnection } from "./model-test.js";

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

function parseProviderBody(body: Record<string, unknown>): { name: string; baseUrl: string; apiKey: string } | undefined {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!name || name.length > 200 || !baseUrl || baseUrl.length > 500 || apiKey.length > 2_000) return undefined;
  if (!httpUrl(baseUrl)) return undefined;
  return { name, baseUrl, apiKey };
}

function parseModelBody(
  body: Record<string, unknown>,
  problems: string[] = [],
): { name: string; contextWindow: number; maxOutputTokens: number } | undefined {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const contextWindow = body.contextWindow;
  const maxOutputTokens = body.maxOutputTokens;
  if (!name || name.length > 200) {
    problems.push("model name must be between 1 and 200 characters");
    return undefined;
  }
  if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1_024 || contextWindow > 10_000_000) {
    problems.push("context window must be between 1024 and 10000000 tokens");
    return undefined;
  }
  // 输出上限没有固定天花板，只要求小于该模型自己的上下文窗口。
  if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    problems.push("max output tokens must be a positive integer");
    return undefined;
  }
  if (maxOutputTokens >= contextWindow) {
    problems.push(
      `max output tokens (${maxOutputTokens}) must be smaller than the context window (${contextWindow}); ` +
      `use at most ${contextWindow - 1} so room remains for the prompt`,
    );
    return undefined;
  }
  return { name, contextWindow, maxOutputTokens };
}

function methodNotAllowed(reply: FastifyReply): void {
  sendJson(reply, 405, { error: "method not allowed" });
}

/**
 * 用户专属模型目录：系统级供应商与用户自己的供应商共存。
 * 系统级供应商只读；激活操作只改变当前用户的选择，不影响全局或其他用户。
 */
export function registerUserModelRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.register(
    async (me) => {
      me.addHook("onRequest", async (request, reply) => {
        if (!requireUser(request, reply)) return reply;
      });

      const visible = (userId: string): ModelProviderDetails[] => {
        const selection = ctx.store.getUserModelSelection(userId);
        return ctx.store.listModelProvidersForUser(userId).map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            // 有用户选择时以它为准；否则沿用系统当前模型。
            active: selection
              ? selection.modelId === model.id
              : provider.ownerUserId === "" && model.active,
          })),
        }));
      };

      me.get("/model-providers", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        sendJson(reply, 200, {
          items: visible(user.id).map((provider) => redactProvider(provider)),
          thinkingLevel: ctx.store.getUserThinkingLevel(user.id) ?? ctx.config.agent.thinkingLevel,
          reasoningEnabled: ctx.config.agent.reasoningEnabled,
        });
      });

      me.post("/thinking-level", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const body = readJsonObject(request, reply);
        if (!body) return;
        const level = body.thinkingLevel;
        if (!isThinkingLevel(level)) {
          sendJson(reply, 400, { error: "invalid thinking level" });
          return;
        }
        if (!ctx.store.setUserThinkingLevel(user.id, level)) {
          sendJson(reply, 400, { error: "invalid thinking level" });
          return;
        }
        sendJson(reply, 200, { thinkingLevel: level });
      });

      me.post("/model-providers/test", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const body = readJsonObject(request, reply);
        if (!body) return;
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
        const draftKey = typeof body.apiKey === "string" ? body.apiKey : "";
        const providerId = typeof body.providerId === "string" ? idParam(body.providerId) : undefined;
        const existing = providerId ? ctx.store.getModelProvider(providerId, user.id) : undefined;
        // 编辑时输入框留空表示沿用已保存的密钥；系统级供应商也可能被用户测试。
        const apiKey = draftKey && draftKey !== secretSettingPlaceholder ? draftKey : (existing?.apiKey ?? "");
        sendJson(reply, 200, await testProviderConnection(baseUrl, apiKey));
      });

      me.post("/model-providers/:id/models/test", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const providerId = idParam((request.params as { id: string }).id);
        const body = readJsonObject(request, reply);
        if (!providerId || !body) return;
        const provider = ctx.store.getModelProvider(providerId, user.id);
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

      me.post("/model-providers", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const body = readJsonObject(request, reply);
        if (!body) return;
        const input = parseProviderBody(body);
        if (!input) {
          sendJson(reply, 400, { error: "invalid model provider" });
          return;
        }
        const provider = ctx.store.createModelProvider(input, user.id);
        sendJson(reply, 201, redactProvider(provider));
      });

      me.put("/model-providers/:id", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const providerId = idParam((request.params as { id: string }).id);
        const body = readJsonObject(request, reply);
        if (!providerId || !body) return;
        const input = parseProviderBody(body);
        if (!input) {
          sendJson(reply, 400, { error: "invalid model provider" });
          return;
        }
        const existing = ctx.store.getModelProvider(providerId, user.id);
        if (!existing || existing.ownerUserId !== user.id) {
          sendJson(reply, 404, { error: "model provider not found" });
          return;
        }
        if (!input.apiKey) input.apiKey = existing.apiKey;
        const updated = ctx.store.updateModelProvider(providerId, input, user.id);
        if (!updated) {
          sendJson(reply, 404, { error: "model provider not found" });
          return;
        }
        sendJson(reply, 200, redactProvider(updated));
      });

      me.delete("/model-providers/:id", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const providerId = idParam((request.params as { id: string }).id);
        if (!providerId) {
          methodNotAllowed(reply);
          return;
        }
        if (!ctx.store.deleteModelProvider(providerId, user.id)) {
          sendJson(reply, 404, { error: "model provider not found" });
          return;
        }
        sendJson(reply, 200, { deleted: true });
      });

      me.post("/model-providers/:id/models", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const providerId = idParam((request.params as { id: string }).id);
        const body = readJsonObject(request, reply);
        if (!providerId || !body) return;
        const problems: string[] = [];
        const input = parseModelBody(body, problems);
        if (!input) {
          sendJson(reply, 400, { error: problems[0] ?? "invalid model" });
          return;
        }
        const model = ctx.store.createProviderModel(providerId, input, user.id);
        if (!model) {
          sendJson(reply, 404, { error: "model provider not found" });
          return;
        }
        sendJson(reply, 201, model);
      });

      me.put("/model-providers/:id/models/:modelId", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const params = request.params as { id: string; modelId: string };
        const providerId = idParam(params.id);
        const modelId = idParam(params.modelId);
        const body = readJsonObject(request, reply);
        if (!providerId || !modelId || !body) return;
        const problems: string[] = [];
        const input = parseModelBody(body, problems);
        if (!input) {
          sendJson(reply, 400, { error: problems[0] ?? "invalid model" });
          return;
        }
        const updated = ctx.store.updateProviderModel(providerId, modelId, input, user.id);
        if (!updated) {
          sendJson(reply, 404, { error: "model not found" });
          return;
        }
        sendJson(reply, 200, updated);
      });

      me.delete("/model-providers/:id/models/:modelId", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const params = request.params as { id: string; modelId: string };
        const providerId = idParam(params.id);
        const modelId = idParam(params.modelId);
        if (!providerId || !modelId) {
          methodNotAllowed(reply);
          return;
        }
        if (!ctx.store.deleteProviderModel(providerId, modelId, user.id)) {
          sendJson(reply, 404, { error: "model not found" });
          return;
        }
        sendJson(reply, 200, { deleted: true });
      });

      me.post("/model-providers/:id/models/:modelId/activate", async (request, reply) => {
        const user = requireUser(request, reply);
        if (!user) return;
        const params = request.params as { id: string; modelId: string };
        const providerId = idParam(params.id);
        const modelId = idParam(params.modelId);
        if (!providerId || !modelId) {
          methodNotAllowed(reply);
          return;
        }
        if (!ctx.store.setUserModelSelection(user.id, providerId, modelId)) {
          sendJson(reply, 404, { error: "model not found" });
          return;
        }
        const provider = ctx.store.getModelProvider(providerId, user.id)!;
        const model = ctx.store.getProviderModel(providerId, modelId)!;
        sendJson(reply, 200, { ...model, active: true, provider });
      });

      me.all("/model-providers/*", async (_request, reply) => methodNotAllowed(reply));
    },
    { prefix: "/api/ops/me" },
  );
}
