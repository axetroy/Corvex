import type { FastifyInstance } from "fastify";
import type { OpsContext } from "../context.js";
import { errorMessage } from "../../../errors.js";
import { optionalInteger, queryParam, readJsonObject, sendJson } from "../respond.js";

/** Git 存储清理：预览或执行计划，并记录每次运行供控制台分页查看。 */
export function registerStorageRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/storage/cleanups", async (request, reply) => {
    const limit = optionalInteger(queryParam(request.query, "limit"), 1, 100) ?? 10;
    const offset = optionalInteger(queryParam(request.query, "offset"), 0, 1_000_000) ?? 0;
    if (limit === false || offset === false) {
      sendJson(reply, 400, { error: "invalid pagination" });
      return;
    }
    sendJson(reply, 200, {
      items: ctx.store.listStorageCleanups(limit, offset),
      total: ctx.store.countStorageCleanups(),
    });
  });

  app.post("/api/ops/storage/cleanup", async (request, reply) => {
    const body = readJsonObject(request, reply);
    if (!body) return;
    const olderThanDays = body.olderThanDays;
    const apply = body.apply;
    if (
      typeof olderThanDays !== "number" ||
      !Number.isSafeInteger(olderThanDays) ||
      olderThanDays < 1 ||
      olderThanDays > 36_500 ||
      typeof apply !== "boolean"
    ) {
      sendJson(reply, 400, { error: "olderThanDays must be 1..36500 and apply must be boolean" });
      return;
    }
    const startedAt = new Date().toISOString();
    try {
      const plan = await ctx.conversations.cleanupStorage(olderThanDays, apply);
      ctx.store.recordStorageCleanup({
        startedAt,
        finishedAt: new Date().toISOString(),
        source: "ops-console",
        applied: apply,
        olderThanDays,
        removedWorkspaces: plan.workspaces.length,
        removedMirrors: plan.mirrors.length,
        error: "",
      });
      sendJson(reply, 200, {
        olderThanDays,
        applied: plan.applied,
        workspaces: plan.workspaces.length,
        mirrors: plan.mirrors.length,
      });
    } catch (cause) {
      ctx.store.recordStorageCleanup({
        startedAt,
        finishedAt: new Date().toISOString(),
        source: "ops-console",
        applied: apply,
        olderThanDays,
        removedWorkspaces: 0,
        removedMirrors: 0,
        error: errorMessage(cause).slice(0, 8_000),
      });
      sendJson(reply, 500, { error: errorMessage(cause) });
    }
  });
}
