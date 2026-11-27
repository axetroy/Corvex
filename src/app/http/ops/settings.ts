import type { FastifyInstance } from "fastify";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";

/** 运行时设置：读取当前值与生效值，保存整份可编辑键。 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/settings", async (_request, reply) => {
    sendJson(reply, 200, ctx.settings.read());
  });

  // 专用设置页只提交自己负责的键；未提交的键沿用当前值。
  app.post("/api/ops/settings/patch", async (request, reply) => {
    const body = readJsonObject(request, reply);
    if (!body) return;
    const result = ctx.settings.savePartial(body.settings);
    sendJson(reply, result.status, result.body);
  });

  // 控制台提交 `{ settings: {...} }`；未提交的键回到配置文件的初始值。
  app.put("/api/ops/settings", async (request, reply) => {
    const body = readJsonObject(request, reply);
    if (!body) return;
    const result = ctx.settings.save(body.settings);
    sendJson(reply, result.status, result.body);
  });
}
