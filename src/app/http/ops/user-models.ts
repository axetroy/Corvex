import type { FastifyInstance, FastifyReply } from "fastify";
import { requireUser } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import type { ModelProviderDetails } from "../../../events/model.js";
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

function parseProviderBody(body: Record<string, unknown>): { name: string; baseUrl: string; apiKey: string } | undefined {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
  if (!name || name.length > 200 || !baseUrl || baseUrl.length > 500 || apiKey.length > 2_000) return undefined;
  if (!httpUrl(baseUrl)) return undefined;
  return { name, baseUrl, apiKey };
}

function parseModelBody(body: Record<string, unknown>): { name: string; contextWindow: number; maxOutputTokens: number } | undefined {
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
        sendJson(reply, 200, { items: visible(user.id).map((provider) => redactProvider(provider)) });
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
        const input = parseModelBody(body);
        if (!input) {
          sendJson(reply, 400, { error: "invalid model" });
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
        const input = parseModelBody(body);
        if (!input) {
          sendJson(reply, 400, { error: "invalid model" });
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
