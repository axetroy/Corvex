import type { FastifyInstance } from "fastify";
import type { OpsContext } from "../context.js";
import { sendJson } from "../respond.js";

/** 总览：对话轮次健康度与模型调用指标，控制台首屏使用。 */
export function registerObservabilityRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/overview", async (_request, reply) => {
    const generatedAt = new Date();
    const overview = ctx.store.operationsOverview();
    const oldestQueuedAt = overview.oldestQueuedAt;
    const oldestQueueAgeSeconds = oldestQueuedAt
      ? Math.max(0, Math.floor((generatedAt.valueOf() - Date.parse(oldestQueuedAt)) / 1000))
      : null;
    if (oldestQueueAgeSeconds !== null && !Number.isFinite(oldestQueueAgeSeconds)) {
      throw new Error("SQLite returned an invalid oldest queued timestamp");
    }
    // 会话 worktree 容量指标：describeStorage 是有界扫描（节点/深度/条目上限），
    // 只用于概览页按需加载，不做持续轮询。
    const storage = await ctx.conversations.describeStorage();
    const workspaceSizeLimitBytes = ctx.config.storage.conversationWorkspaceMaxMb * 1024 * 1024;
    const workspaceOverLimitCount = storage.workspaces.filter(
      (entry) => entry.sizeBytes > workspaceSizeLimitBytes,
    ).length;
    const workspaceTotalBytes = storage.workspaces.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const mirrorTotalBytes = storage.mirrors.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    // 上限约束的是单个会话 worktree，而不是所有 worktree 的总和。
    const largestWorkspaceBytes = storage.workspaces.reduce(
      (largest, entry) => Math.max(largest, entry.sizeBytes),
      0,
    );
    sendJson(reply, 200, {
      generatedAt: generatedAt.toISOString(),
      ...overview,
      oldestQueueAgeSeconds,
      modelCalls: ctx.store.modelCallMetrics(),
      contextMetrics: ctx.store.contextMetrics(),
      workspaceSizeLimitBytes,
      workspaceOverLimitCount,
      workspaceTotalBytes,
      workspaceCount: storage.workspaces.length,
      mirrorCount: storage.mirrors.length,
      mirrorTotalBytes,
      largestWorkspaceBytes,
    });
  });
}
