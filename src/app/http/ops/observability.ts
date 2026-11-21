import type { FastifyInstance } from "fastify";
import { isEventStatus, isEventType } from "../../../events/model.js";
import type { OpsContext } from "../context.js";
import { idParam, optionalInteger, queryParam, sendJson } from "../respond.js";

/** 总览：队列健康度与模型调用指标，控制台首屏使用。 */
function registerOverviewRoute(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/overview", async (_request, reply) => {
    const generatedAt = new Date();
    const overview = ctx.store.operationsOverview(Math.max(ctx.config.events.pollInterval * 3, 30_000));
    const oldestQueuedAt = overview.oldestQueuedAt;
    const oldestQueueAgeSeconds = oldestQueuedAt
      ? Math.max(0, Math.floor((generatedAt.valueOf() - Date.parse(oldestQueuedAt)) / 1000))
      : null;
    if (oldestQueueAgeSeconds !== null && !Number.isFinite(oldestQueueAgeSeconds)) {
      throw new Error("SQLite returned an invalid oldest queued timestamp");
    }
    sendJson(reply, 200, {
      generatedAt: generatedAt.toISOString(),
      ...overview,
      oldestQueueAgeSeconds,
      modelCalls: ctx.store.modelCallMetrics(),
    });
  });
}

/** 任务列表与详情：按状态、类型、仓库与搜索词筛选。 */
function registerEventRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/events", async (request, reply) => {
    const statusValue = queryParam(request.query, "status");
    const typeValue = queryParam(request.query, "type");
    const status = statusValue === null ? undefined : isEventStatus(statusValue) ? statusValue : false;
    const type = typeValue === null ? undefined : isEventType(typeValue) ? typeValue : false;
    const projectId = optionalInteger(queryParam(request.query, "projectId"), 1, Number.MAX_SAFE_INTEGER);
    const mrIid = optionalInteger(queryParam(request.query, "mrIid"), 1, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(queryParam(request.query, "limit"), 1, 100) ?? 25;
    const offset = optionalInteger(queryParam(request.query, "offset"), 0, 1_000_000) ?? 0;
    const search = queryParam(request.query, "search") ?? undefined;
    if (
      status === false ||
      type === false ||
      projectId === false ||
      mrIid === false ||
      limit === false ||
      offset === false ||
      (search?.trim().length ?? 0) > 100
    ) {
      sendJson(reply, 400, { error: "invalid event list filter" });
      return;
    }
    sendJson(
      reply,
      200,
      ctx.store.listOperationsEvents({
        status,
        type,
        projectId,
        mrIid,
        search,
        limit,
        offset,
      }),
    );
  });

  app.get("/api/ops/events/:id", async (request, reply) => {
    const eventId = idParam((request.params as { id: string }).id);
    if (!eventId) {
      sendJson(reply, 400, { error: "invalid event ID" });
      return;
    }
    const event = ctx.store.getEventDetails(eventId);
    if (!event) {
      sendJson(reply, 404, { error: "event not found" });
      return;
    }
    sendJson(reply, 200, event);
  });
}

/** 控制台只读视图：总览与任务列表。 */
export function registerObservabilityRoutes(app: FastifyInstance, ctx: OpsContext): void {
  registerOverviewRoute(app, ctx);
  registerEventRoutes(app, ctx);
}
