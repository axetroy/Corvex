import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { conversationWorkspaceName } from "../../../git/manager.js";
import { isConversationMode } from "../../../model.js";
import type { Conversation, ConversationStreamEvent } from "../../../model.js";
import type { ContextSnapshotData } from "../../../agent/context-inspect.js";
import { requireUser } from "../../auth/context.js";
import { callAsyncHook, type ConversationDeleteContext } from "../../hooks.js";
import { resolveCommandRequest } from "../../conversation-command.js";
import { getConversationSystemPrompt } from "../../../agent/prompts.js";
import { createConversationFileSource } from "../../files/factory.js";
import { WorkspaceUnavailableError } from "../../files/local-source.js";
import { resolveWorktreePath } from "../../../agent/fs/index.js";
import { errorMessage } from "../../../errors.js";
import { FilePreviewError } from "../../files/source.js";
import { maxUploadBytesCeiling, sanitizeUploadFilename, uploadContentType, validateUpload } from "../../upload.js";
import type { OpsContext } from "../context.js";
import {
  idParam,
  sendBinary,
  optionalInteger,
  positiveInteger,
  queryParam,
  readJsonObject,
  sendGitLabReadError,
  sendJson,
} from "../respond.js";

/** 对话流式响应的心跳间隔：长工具调用期间保持连接，避免反向代理提前断开。 */
const conversationStreamHeartbeatMs = 15_000;
/** 对话流式响应的状态巡检间隔：轮次落库结束但事件缺失时仍能收尾。 */
const conversationStreamProbeMs = 5_000;

function invalidConversationId(reply: FastifyReply): void {
  sendJson(reply, 400, { error: "invalid conversation ID" });
}

function invalidTurnId(reply: FastifyReply): void {
  sendJson(reply, 400, { error: "invalid conversation turn ID" });
}

/** 没有可用模型时禁止入队，否则轮次只会立刻失败且不会产生标题。 */
function ensureModelSelected(ctx: OpsContext, reply: FastifyReply, userId?: string): boolean {
  if ((userId && ctx.store.getActiveModelForUser(userId)) || ctx.store.getActiveModel() || ctx.config.agent.model.trim()) return true;
  sendJson(reply, 409, {
    error: ctx.config.agent.responseLanguage === "zh-CN"
      ? "尚未选择模型，请先在「设置 → 模型」中配置并激活模型。"
      : "No model is selected. Configure and activate one in Settings > Model first.",
  });
  return false;
}

/** 经统一 hook 清理会话关联资源；单个 tap 的错误收集在 context.errors，由路由决定状态。 */
async function cleanupConversationResources(
  ctx: OpsContext,
  conversation: Conversation,
  reason: ConversationDeleteContext["reason"],
): Promise<ConversationDeleteContext> {
  const context: ConversationDeleteContext = {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    reason,
    turnIds: [...new Set(
      conversation.messages
        .map((message) => message.turnId)
        .filter((turnId): turnId is string => typeof turnId === "string" && turnId.length > 0),
    )],
    errors: [],
  };
  try {
    await callAsyncHook(ctx.hooks.conversationDelete, context);
  } catch (error) {
    // 插件 tap 抛错同样视为清理失败，数据库记录因此保留，避免留下孤儿资源。
    context.errors.push(errorMessage(error));
  }
  return context;
}

/** 校验会话归属：用户只能访问自己的会话。 */
function ownedConversation(
  ctx: OpsContext,
  request: FastifyRequest,
  reply: FastifyReply,
  conversationId: string,
): Conversation | undefined {
  const user = requireUser(request, reply);
  if (!user) return undefined;
  const conversation = ctx.store.getConversation(conversationId);
  if (!conversation || conversation.ownerUserId !== user.id) {
    sendJson(reply, 404, { error: "conversation not found" });
    return undefined;
  }
  return conversation;
}

/** 对话工作台：列表、详情、轮次、轨迹、流式正文与统计。 */
export function registerConversationRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/conversations", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const limit = optionalInteger(queryParam(request.query, "limit"), 1, 100) ?? 50;
    const offset = optionalInteger(queryParam(request.query, "offset"), 0, 1_000_000) ?? 0;
    const archivedParam = queryParam(request.query, "archived");
    const archived = archivedParam === null ? false : archivedParam === "true" || archivedParam === "1";
    if (
      limit === false ||
      offset === false ||
      (archivedParam !== null && archivedParam !== "true" && archivedParam !== "false" && archivedParam !== "1" && archivedParam !== "0")
    ) {
      sendJson(reply, 400, { error: "invalid conversation list filter" });
      return;
    }
    sendJson(reply, 200, ctx.store.listConversations(limit, offset, archived, user.id));
  });

  app.post("/api/ops/conversations", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const body = readJsonObject(request, reply);
    if (!body) return;
    const projectId = positiveInteger(body.projectId);
    const targetBranch = typeof body.targetBranch === "string" ? body.targetBranch.trim() : "";
    const message = typeof body.message === "string" ? body.message : "";
    const mode = body.mode === undefined ? undefined : String(body.mode);
    const responseLanguage = body.responseLanguage === "zh-CN" || body.responseLanguage === "en"
      ? body.responseLanguage
      : undefined;
    if (
      projectId === undefined ||
      !targetBranch || targetBranch.length > 255 ||
      !message.trim() || message.length > 20_000 ||
      (mode !== undefined && !isConversationMode(mode))
    ) {
      sendJson(reply, 400, { error: "invalid conversation request" });
      return;
    }
    if (!ensureModelSelected(ctx, reply, user.id)) return;
    try {
      const gitlab = ctx.gitlabForRequest(request);
      const project = await gitlab.getProject(projectId);
      const headSha = (await gitlab.getBranch(projectId, targetBranch)).commit.id;
      const created = ctx.store.createConversation({
        ownerUserId: user.id,
        projectId,
        projectName: project.path_with_namespace ?? project.name ?? String(projectId),
        targetBranch,
        headSha,
        actorId: 0,
        request: message,
        ...(mode ? { mode } : {}),
      });
      const titleLanguage = responseLanguage ?? ctx.config.agent.responseLanguage;
      const title = await callAsyncHook(ctx.hooks.conversationStart, {
        conversationId: created.conversationId,
        turnId: created.turnId,
        request: resolveCommandRequest(
          message,
          (name) => ctx.store.getConversationSkill(name),
        ).titleRequest,
        language: titleLanguage,
      });
      if (title) ctx.store.saveConversationTitle(created.conversationId, title);
      ctx.startConversationTurn(created.turnId, gitlab, responseLanguage);
      sendJson(reply, 202, created);
    } catch (error) {
      sendGitLabReadError(reply, error);
    }
  });

  // 归档/取消归档：只改列表可见性，详情与轨迹依旧可读。
  app.post("/api/ops/conversations/:id/archive", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const body = readJsonObject(request, reply);
    if (!body) return;
    if (typeof body.archived !== "boolean") {
      sendJson(reply, 400, { error: "archived must be a boolean" });
      return;
    }
    if (!ctx.store.setConversationArchived(conversationId, body.archived)) {
      sendJson(reply, 404, { error: "conversation not found" });
      return;
    }
    sendJson(reply, 200, { conversationId, archived: body.archived });
  });

  // 删除对话：先经 hook 清理所有关联资源，成功后才删数据库记录。
  app.delete("/api/ops/conversations/:id", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    if (conversation.messages.some((message) => message.turnStatus === "queued" || message.turnStatus === "running")) {
      sendJson(reply, 409, { error: "a turn is still running for this conversation" });
      return;
    }
    const cleanup = await cleanupConversationResources(ctx, conversation, "delete");
    if (cleanup.errors.length > 0) {
      const active = cleanup.errors.some((error) => error.includes("turn is active"));
      sendJson(reply, active ? 409 : 500, {
        error: active ? "a turn is still running for this conversation" : "conversation cleanup failed",
      });
      return;
    }
    ctx.store.deleteConversation(conversationId);
    sendJson(reply, 200, { deleted: true });
  });

  app.get("/api/ops/conversations/:id", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    // 系统提示词由响应语言与对话模式派生，与执行器下发的一致；在详情里现算，
    // 使尚未执行过轮次的新对话也能在控制台查看。
    sendJson(reply, 200, {
      ...conversation,
      systemPrompt: getConversationSystemPrompt(ctx.config.agent.responseLanguage, conversation.mode, ctx.config.agent.followupsEnabled),
    });
  });

  // 文件浏览只读取当前会话的 worktree：如果已被回收或首轮尚未准备，明确报错，
  // 不回退到 GitLab 快照，避免看到的不是本会话实际改动过的文件。
  const fileSource = (conversation: Conversation) => createConversationFileSource({
    workspacePath: join(
      ctx.config.storage.root,
      "workspaces",
      String(conversation.projectId),
      conversationWorkspaceName(conversation.id),
    ),
  });
  const sendFileReadError = (reply: FastifyReply, error: unknown): void => {
    if (error instanceof FilePreviewError) {
      sendJson(reply, error.status, { error: error.message });
      return;
    }
    if (error instanceof WorkspaceUnavailableError) {
      sendJson(reply, 409, { error: "conversation worktree is not available" });
      return;
    }
    console.warn("conversation file read failed", { error: errorMessage(error) });
    sendJson(reply, 502, { error: "file preview failed" });
  };

  app.get("/api/ops/conversations/:id/files/tree", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const source = fileSource(conversation);
    try {
      sendJson(reply, 200, await source.listDirectory(queryParam(request.query, "path") ?? ""));
    } catch (error) {
      sendFileReadError(reply, error);
    }
  });

  app.get("/api/ops/conversations/:id/files/content", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const source = fileSource(conversation);
    const path = queryParam(request.query, "path") ?? "";
    const full = queryParam(request.query, "full") === "1";
    const startLine = optionalInteger(queryParam(request.query, "startLine"), 1, 1_000_000);
    const maxLines = optionalInteger(queryParam(request.query, "maxLines"), 1, 2_000);
    if (!path || startLine === false || maxLines === false) {
      sendJson(reply, 400, { error: "invalid file path or range" });
      return;
    }
    try {
      sendJson(reply, 200, await source.readFile(path, {
        ...(startLine === undefined ? {} : { startLine }),
        ...(maxLines === undefined ? {} : { maxLines }),
        ...(full ? { full: true } : {}),
      }));
    } catch (error) {
      sendFileReadError(reply, error);
    }
  });

  app.get("/api/ops/conversations/:id/files/image", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const source = fileSource(conversation);
    const path = queryParam(request.query, "path") ?? "";
    if (!path) {
      sendJson(reply, 400, { error: "invalid file path" });
      return;
    }
    try {
      const image = await source.readImage(path);
      sendBinary(reply, image.data, image.mimeType);
    } catch (error) {
      sendFileReadError(reply, error);
    }
  });

  // 文件树右键删除：只作用于当前会话 worktree，并立即写入会话 ref。
  app.delete("/api/ops/conversations/:id/files", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    if (conversation.messages.some((message) => message.turnStatus === "queued" || message.turnStatus === "running")) {
      sendJson(reply, 409, { error: "a turn is still running for this conversation" });
      return;
    }
    const path = queryParam(request.query, "path") ?? "";
    if (!path) {
      sendJson(reply, 400, { error: "invalid file path" });
      return;
    }
    const sha = ctx.store.getConversationTurns(conversation.id)?.turns.at(-1)?.headSha ?? "";
    if (!sha) {
      sendJson(reply, 409, { error: "conversation has no pinned commit yet" });
      return;
    }
    const workspacePath = join(
      ctx.config.storage.root,
      "workspaces",
      String(conversation.projectId),
      conversationWorkspaceName(conversation.id),
    );
    try {
      const { target } = await resolveWorktreePath(workspacePath, path);
      await rm(target, { recursive: true, force: false });
      await ctx.conversations.saveConversationChangesById(conversation.id, conversation.projectId, sha);
      sendJson(reply, 200, { deleted: path });
    } catch (error) {
      sendJson(reply, 400, { error: errorMessage(error) });
    }
  });

  // 提交图谱：只读当前会话项目的镜像，不暴露任意项目 ID。
  app.get("/api/ops/conversations/:id/git/graph", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const limit = optionalInteger(queryParam(request.query, "limit"), 1, 300) ?? 100;
    const offset = optionalInteger(queryParam(request.query, "offset"), 0, 10_000) ?? 0;
    const author = queryParam(request.query, "author") ?? "";
    if (limit === false || offset === false || author.length > 200) {
      sendJson(reply, 400, { error: "invalid graph range or author" });
      return;
    }
    try {
      const graph = await ctx.conversations.getCommitGraph(conversation.projectId, {
        limit, offset, ...(author ? { author } : {}),
      });
      const worktree = await ctx.conversations.gitWorktreeState(conversation.id);
      sendJson(reply, 200, {
        ...graph,
        pinnedSha: ctx.store.getConversationTurns(conversation.id)?.turns.at(-1)?.headSha ?? "",
        headSha: worktree.headSha,
        currentBranch: worktree.branch,
      });
    } catch (error) {
      sendJson(reply, 400, { error: errorMessage(error) });
    }
  });

  // Git 图谱快捷操作：只允许在该会话没有在途轮次时执行。
  for (const [action, run] of [
    ["pull", (id: string, token: string) => ctx.conversations.gitPull(id, token)],
    ["push", (id: string, token: string) => {
      // 推送到会话 ref 是纯本地镜像操作，但仍要求已登录用户才能进入该路由。
      void token;
      return ctx.conversations.gitPush(id);
    }],
  ] as const) {
    app.post(`/api/ops/conversations/:id/git/${action}`, async (request, reply) => {
      const conversationId = idParam((request.params as { id: string }).id);
      if (!conversationId) {
        invalidConversationId(reply);
        return;
      }
      const conversation = ownedConversation(ctx, request, reply, conversationId);
      if (!conversation) return;
      if (conversation.messages.some((message) => message.turnStatus === "queued" || message.turnStatus === "running")) {
        sendJson(reply, 409, { error: "a turn is still running for this conversation" });
        return;
      }
      try {
        sendJson(reply, 200, await run(conversationId, ctx.gitlabForRequest(request).authToken));
      } catch (error) {
        sendJson(reply, 400, { error: errorMessage(error) });
      }
    });
  }

  app.get("/api/ops/conversations/:id/git/changes", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    try {
      sendJson(reply, 200, await ctx.conversations.getConversationChangeDetails(conversationId));
    } catch (error) {
      sendJson(reply, 400, { error: errorMessage(error) });
    }
  });

  app.get("/api/ops/conversations/:id/git/commit/:sha/patch", async (request, reply) => {
    const params = request.params as { id: string; sha: string };
    const conversationId = idParam(params.id);
    if (!conversationId || !/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(params.sha)) {
      sendJson(reply, 400, { error: "invalid conversation ID or commit SHA" });
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    try {
      sendJson(reply, 200, await ctx.conversations.formatCommitPatch(conversation.projectId, params.sha));
    } catch (error) {
      sendJson(reply, 400, { error: errorMessage(error) });
    }
  });

  app.get("/api/ops/conversations/:id/git/authors", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    try {
      sendJson(reply, 200, { authors: await ctx.conversations.listCommitAuthors(conversation.projectId) });
    } catch (error) {
      sendJson(reply, 400, { error: errorMessage(error) });
    }
  });

  app.get("/api/ops/conversations/:id/git/commit/:sha", async (request, reply) => {
    const params = request.params as { id: string; sha: string };
    const conversationId = idParam(params.id);
    if (!conversationId || !/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(params.sha)) {
      sendJson(reply, 400, { error: "invalid conversation ID or commit SHA" });
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    try {
      sendJson(reply, 200, await ctx.conversations.showCommitFromMirror(conversation.projectId, params.sha));
    } catch (error) {
      sendJson(reply, 400, { error: errorMessage(error) });
    }
  });

  // 本地改动保存在项目 mirror 的 ref 中，SQLite 不存文件内容。
  app.get("/api/ops/conversations/:id/changes", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const changes = await ctx.conversations.getConversationChanges(conversationId, conversation.projectId);
    sendJson(reply, 200, changes ?? { sha: "", paths: [] });
  });

  app.delete("/api/ops/conversations/:id/changes", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const cleanup = await cleanupConversationResources(ctx, conversation, "changes");
    if (cleanup.errors.length > 0) {
      const active = cleanup.errors.some((error) => error.includes("turn is active"));
      sendJson(reply, active ? 409 : 500, {
        error: active ? "a turn is still running for this conversation" : "conversation cleanup failed",
      });
      return;
    }
    sendJson(reply, 200, { deleted: true });
  });

  // 只撤销指定文件的会话改动；运行中的轮次不能改 worktree。
  app.post("/api/ops/conversations/:id/changes/discard", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const body = readJsonObject(request, reply);
    if (!body) return;
    const path = typeof body.path === "string" ? body.path : "";
    if (!path || path.length > 4096) {
      sendJson(reply, 400, { error: "path must be a bounded non-empty string" });
      return;
    }
    try {
      await ctx.conversations.discardConversationFile(conversation, path, ctx.gitlabForRequest(request));
      sendJson(reply, 200, { discarded: true, path });
    } catch (error) {
      const message = errorMessage(error);
      sendJson(reply, message.includes("turn is active") ? 409 : 400, { error: message });
    }
  });

  // 整段对话轨迹：把该对话全部轮次的轨迹与执行步骤合并成一条时间线，
  // 供对话页「轨迹」标签默认在一个轨迹里展示所有轮次。
  app.get("/api/ops/conversations/:id/turns", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const turns = ctx.store.getConversationTurns(conversationId);
    if (!turns) {
      sendJson(reply, 404, { error: "conversation not found" });
      return;
    }
    sendJson(reply, 200, turns);
  });

  // 上下文快照：按模型请求保存的组成与逐项预览，供会话的「上下文」面板读取。
  app.get("/api/ops/conversations/:id/context", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const snapshots = ctx.store.contextSnapshots(conversationId);
    sendJson(reply, 200, {
      conversationId,
      cacheStats: ctx.store.conversationCacheStats(conversationId),
      snapshots: snapshots.map((snapshot) => ({
        conversationId: snapshot.conversationId,
        turnId: snapshot.turnId,
        requestSeq: snapshot.requestSeq,
        createdAt: snapshot.createdAt,
        contextWindow: snapshot.contextWindow,
        reservedOutput: snapshot.reservedOutput,
        threshold: snapshot.threshold,
        estimatedTokens: snapshot.estimatedTokens,
        breakdown: snapshot.breakdown,
        counts: snapshot.counts,
        truncated: snapshot.truncated,
      })),
    });
  });

  app.get("/api/ops/conversations/:id/context/:seq", async (request, reply) => {
    const params = request.params as { id: string; seq: string };
    const conversationId = idParam(params.id);
    const seq = Number(params.seq);
    if (!conversationId || !Number.isSafeInteger(seq) || seq < 1) {
      sendJson(reply, 400, { error: "invalid conversation ID or request sequence" });
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const snapshot = ctx.store.contextSnapshot(conversationId, seq);
    if (!snapshot) {
      sendJson(reply, 404, { error: "context snapshot not found" });
      return;
    }
    sendJson(reply, 200, snapshot satisfies ContextSnapshotData);
  });

  // 单轮对话的流式正文：SSE 推送模型已生成的累计文本，结束后立即关闭连接。
  // 鉴权与其余 /api/ops 一致；流里只含本轮正文与终态，不含系统提示或工具输出。
  app.get("/api/ops/conversations/:id/turns/:turnId/changes", async (request, reply) => {
    const params = request.params as { id: string; turnId: string };
    const conversationId = idParam(params.id);
    const turnId = idParam(params.turnId);
    if (!conversationId || !turnId) {
      sendJson(reply, 400, { error: "invalid conversation ID or turn ID" });
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    try {
      sendJson(reply, 200, await ctx.conversations.getConversationTurnChanges(conversationId, turnId));
    } catch (error) {
      sendJson(reply, 400, { error: errorMessage(error) });
    }
  });

  app.get("/api/ops/conversations/:id/turns/:turnId/stream", async (request, reply) => {
    const params = request.params as { id: string; turnId: string };
    const conversationId = idParam(params.id);
    const turnId = idParam(params.turnId);
    if (!conversationId || !turnId) {
      invalidTurnId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const turn = ctx.store.getConversationTurn(conversationId, turnId);
    if (!turn) {
      sendJson(reply, 404, { error: "conversation turn not found" });
      return;
    }
    // SSE 由本模块直接写原生响应；告诉 Fastify 不要再接管这次响应。
    reply.hijack();
    const response = reply.raw;
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.setHeader("x-content-type-options", "nosniff");
    response.flushHeaders();
    ctx.conversationStreams.add(response);
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let probe: NodeJS.Timeout | undefined;
    let unsubscribe: () => void = () => {};
    const cleanup = () => {
      ctx.conversationStreams.delete(response);
      if (heartbeat) clearInterval(heartbeat);
      if (probe) clearInterval(probe);
      heartbeat = undefined;
      probe = undefined;
      unsubscribe();
    };
    const send = (event: ConversationStreamEvent) => {
      if (closed) return;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const finish = (event: Extract<ConversationStreamEvent, { type: "done" }>) => {
      if (closed) return;
      send(event);
      closed = true;
      cleanup();
      response.end();
    };
    // 先订阅再判断终态：轮次可能在请求到达前就已完成，也可能正好在订阅前后结束，
    // 由唯一的 `closed` 标志保证 done 只发送一次。
    unsubscribe = ctx.conversations.subscribeTurn(turnId, (event) => {
      if (event.type === "done") finish(event);
      else send(event);
    });
    heartbeat = setInterval(() => {
      if (!closed) response.write(": ping\n\n");
    }, conversationStreamHeartbeatMs);
    heartbeat.unref();
    probe = setInterval(() => {
      try {
        const current = ctx.store.getConversationTurn(conversationId, turnId);
        if (current && current.status !== "queued" && current.status !== "running") {
          finish({ type: "done", status: current.status, error: current.lastError || undefined });
        }
      } catch {
        finish({ type: "done", status: "failed" });
      }
    }, conversationStreamProbeMs);
    probe.unref();
    response.on("close", () => {
      closed = true;
      cleanup();
    });
    response.on("error", () => {
      closed = true;
      cleanup();
    });
    if (turn.status !== "queued" && turn.status !== "running") {
      finish({ type: "done", status: turn.status, error: turn.lastError || undefined });
    }
  });

  // 单轮对话记录：把该轮的状态、生命周期、轨迹与执行步骤一并返回，
  // 供对话页「轨迹」标签查看某一轮的完整记录，无需跳到事件详情页。
  app.get("/api/ops/conversations/:id/turns/:turnId", async (request, reply) => {
    const params = request.params as { id: string; turnId: string };
    const conversationId = idParam(params.id);
    const turnId = idParam(params.turnId);
    if (!conversationId || !turnId) {
      invalidTurnId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const turn = ctx.store.getConversationTurn(conversationId, turnId);
    if (!turn) {
      sendJson(reply, 404, { error: "conversation turn not found" });
      return;
    }
    sendJson(reply, 200, turn);
  });

  // 停止一条正在运行的命令（不取消整轮）。reason 固定为用户手动停止，模型据此决定下一步。
  app.post("/api/ops/conversations/:id/turns/:turnId/executions/:execId/cancel", async (request, reply) => {
    const params = request.params as { id: string; turnId: string; execId: string };
    const conversationId = idParam(params.id);
    const turnId = idParam(params.turnId);
    const execId = idParam(params.execId);
    if (!conversationId || !turnId || !execId) {
      invalidTurnId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    // 确认轮次属于该会话，避免用他人的 execId 跨会话停止命令。
    if (!ctx.store.getConversationTurn(conversationId, turnId)) {
      sendJson(reply, 404, { error: "conversation turn not found" });
      return;
    }
    if (!ctx.conversations.cancelExecution(turnId, execId)) {
      sendJson(reply, 409, { error: "command is not running in this turn" });
      return;
    }
    sendJson(reply, 202, { conversationId, turnId, execId, cancelled: true });
  });

  // 取消一轮正在内联执行的对话；已结束的轮次返回 409，由界面提示重新拉取。
  app.post("/api/ops/conversations/:id/turns/:turnId/cancel", async (request, reply) => {
    const params = request.params as { id: string; turnId: string };
    const conversationId = idParam(params.id);
    const turnId = idParam(params.turnId);
    if (!conversationId || !turnId) {
      invalidTurnId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const turn = ctx.store.getConversationTurn(conversationId, turnId);
    if (!turn) {
      sendJson(reply, 404, { error: "conversation turn not found" });
      return;
    }
    if (!ctx.conversations.cancelTurn(turnId)) {
      sendJson(reply, 409, { error: "conversation turn is not running" });
      return;
    }
    sendJson(reply, 202, { conversationId, turnId, cancelled: true });
  });

  // 对话统计：把整个对话的用量与耗时汇总，以及逐轮明细，返回给「统计」标签。
  app.get("/api/ops/conversations/:id/stats", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const stats = ctx.store.getConversationStats(conversationId);
    if (!stats) {
      sendJson(reply, 404, { error: "conversation not found" });
      return;
    }
    sendJson(reply, 200, stats);
  });

  // 命令执行历史：来自审计事件，供「执行」标签展示本会话跑过的命令与结果。
  app.get("/api/ops/conversations/:id/executions", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    sendJson(reply, 200, { items: ctx.store.listExecutionHistory(conversationId) });
  });

  app.post("/api/ops/conversations/:id/messages", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const user = requireUser(request, reply);
    if (!user) return;
    const body = readJsonObject(request, reply);
    if (!body) return;
    const message = typeof body.message === "string" ? body.message : "";
    const responseLanguage = body.responseLanguage === "zh-CN" || body.responseLanguage === "en"
      ? body.responseLanguage
      : undefined;
    const delivery = body.delivery === "steer" || body.delivery === "queue" || body.delivery === "interrupt"
      ? body.delivery
      : undefined;
    if (!message.trim() || message.length > 20_000) {
      sendJson(reply, 400, { error: "message must be between 1 and 20000 characters" });
      return;
    }
    const uploadIds: string[] = [];
    if (body.uploadIds !== undefined) {
      if (!Array.isArray(body.uploadIds) || body.uploadIds.length > ctx.config.agent.uploadMaxPerMessage ||
          body.uploadIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)) {
        sendJson(reply, 400, { error: "invalid uploadIds" });
        return;
      }
      for (const id of body.uploadIds as string[]) {
        const upload = ctx.store.getConversationUpload(id);
        if (!upload || upload.conversationId !== conversation.id || upload.ownerUserId !== conversation.ownerUserId) {
          sendJson(reply, 404, { error: `upload ${id} not found` });
          return;
        }
        uploadIds.push(id);
      }
    }
    if (!ensureModelSelected(ctx, reply, user.id)) return;
    try {
      const activeTurnId = ctx.conversations.activeTurnId(conversation.id);
      // 显式排队：写入持久队列，当前轮结束后按 FIFO 用当时的分支快照执行。
      // 若轮次已经结束则没有消费者，直接按普通路径立即开一轮，避免消息永远挂着。
      if (delivery === "queue" && activeTurnId) {
        if (uploadIds.length) {
          sendJson(reply, 400, { error: "uploads can only be attached to a new turn" });
          return;
        }
        const item = ctx.conversations.enqueueFollowUp(conversation.id, message);
        sendJson(reply, 202, { conversationId: conversation.id, queueId: item.id, delivery: "queue" });
        return;
      }
      // 立即打断：中止当前轮并等待落库，随后按普通路径用新的分支快照开一轮。
      if (delivery === "interrupt") {
        if (!activeTurnId || !await ctx.conversations.interruptForSend(conversation.id, activeTurnId)) {
          sendJson(reply, 409, { error: "conversation turn is not running" });
          return;
        }
        // 中断轮次结束时可能已经启动了排队消息；此时不抢跑，把新消息排到它后面。
        if (ctx.conversations.activeTurnId(conversation.id)) {
          if (uploadIds.length) {
            sendJson(reply, 400, { error: "uploads can only be attached to a new turn" });
            return;
          }
          const item = ctx.conversations.enqueueFollowUp(conversation.id, message);
          sendJson(reply, 202, { conversationId: conversation.id, queueId: item.id, delivery: "queue" });
          return;
        }
      }
      // 上传附件只能绑定到新建轮次；已有轮次在执行时明确拒绝，避免附件无法进入模型。
      if (activeTurnId && uploadIds.length) {
        sendJson(reply, 409, { error: "wait for the current turn to finish before sending with uploads" });
        return;
      }
      // 执行中的轮次优先按「插话」处理：补充消息进入当前轮，不新开轮次，也不需要
      // 再次访问 GitLab。轮次刚好结束时 interject 返回 unavailable，自动降级为下一轮。
      if (activeTurnId && await ctx.conversations.interject(activeTurnId, message) === "steer") {
        try {
          ctx.store.appendUserMessage(conversation.id, message, activeTurnId);
          sendJson(reply, 202, {
            conversationId: conversation.id,
            turnId: activeTurnId,
            delivery: "steer",
          });
          return;
        } catch {
          // 投递成功后轮次已结束：降级为普通下一轮，避免用户补充丢失。
        }
      }
      const gitlab = ctx.gitlabForRequest(request);
      const headSha = (await gitlab.getBranch(conversation.projectId, conversation.targetBranch)).commit.id;
      const queued = ctx.store.addConversationMessage(conversation.id, {
        ownerUserId: conversation.ownerUserId,
        projectId: conversation.projectId,
        targetBranch: conversation.targetBranch,
        headSha,
        actorId: 0,
        request: message,
        uploadIds,
      });
      ctx.startConversationTurn(queued.turnId, gitlab, responseLanguage);
      sendJson(reply, 202, { conversationId: conversation.id, turnId: queued.turnId, delivery: "queued" });
    } catch (error) {
      if (error instanceof Error && error.message.includes("active turn")) {
        sendJson(reply, 409, { error: error.message });
      } else {
        sendGitLabReadError(reply, error);
      }
    }
  });

  /** 当前生效的上传限额，供 composer 预检；无需管理员权限，任何登录用户可读。 */
  app.get("/api/ops/me/upload-limits", async (request, reply) => {
    if (!requireUser(request, reply)) return;
    sendJson(reply, 200, {
      maxBytes: ctx.config.agent.uploadMaxBytes,
      ceilingBytes: maxUploadBytesCeiling,
      maxPerMessage: ctx.config.agent.uploadMaxPerMessage,
      maxPerConversation: ctx.config.agent.uploadMaxPerConversation,
      visionSupported: ctx.config.agent.visionEnabled,
    });
  });

  // 上传文本附件：落在 storage/uploads/<conversationId>/ 下，绝不进 worktree（避免被 git add 提交/推送）。
  app.post("/api/ops/conversations/:id/uploads", async (request, reply) => {
    const params = request.params as { id: string };
    const conversationId = idParam(params.id);
    if (!conversationId) {
      sendJson(reply, 400, { error: "invalid conversation ID" });
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const contentType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (contentType !== uploadContentType) {
      sendJson(reply, 415, { error: `content-type must be ${uploadContentType}` });
      return;
    }
    const filename = sanitizeUploadFilename(queryParam(request.query, "filename") ?? "");
    const declaredMime = (queryParam(request.query, "mime") ?? "text/plain").trim().toLowerCase();
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes)) {
      sendJson(reply, 400, { error: "upload body must be binary" });
      return;
    }
    const validation = validateUpload({
      filename, mime: declaredMime, bytes, maxBytes: ctx.config.agent.uploadMaxBytes,
    });
    if (!validation.ok) {
      sendJson(reply, 400, { error: validation.error });
      return;
    }
    if (ctx.store.listConversationUploads(conversationId).length >= ctx.config.agent.uploadMaxPerConversation) {
      sendJson(reply, 409, { error: `too many uploads for this conversation (max ${ctx.config.agent.uploadMaxPerConversation})` });
      return;
    }
    const uploadId = randomUUID();
    // 存储路径完全由服务端生成，原始文件名只存 DB。
    const relativePath = join("uploads", conversationId, uploadId, filename);
    const target = resolve(ctx.config.storage.root, relativePath);
    try {
      await mkdir(resolve(target, ".."), { recursive: true, mode: 0o750 });
      await writeFile(target, bytes, { mode: 0o600 });
    } catch (error) {
      sendJson(reply, 500, { error: `could not store upload: ${errorMessage(error)}` });
      return;
    }
    const upload = ctx.store.createConversationUpload({
      id: uploadId,
      conversationId,
      ownerUserId: conversation.ownerUserId,
      filename,
      // 图片用魔数检测出的真实 MIME；文本沿用客户端声明值。
      mime: validation.mime,
      sizeBytes: bytes.length,
      storagePath: relativePath.replace(/\\/g, "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const auth = requireUser(request, reply);
    if (auth) ctx.store.insertUploadAudit(auth.gitlabUserId, conversationId, uploadId, "created");
    sendJson(reply, 201, upload);
  });

  app.get("/api/ops/conversations/:id/uploads", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      sendJson(reply, 400, { error: "invalid conversation ID" });
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    sendJson(reply, 200, { items: ctx.store.listConversationUploads(conversationId) });
  });

  app.delete("/api/ops/conversations/:id/uploads/:uploadId", async (request, reply) => {
    const params = request.params as { id: string; uploadId: string };
    const conversationId = idParam(params.id);
    const uploadId = idParam(params.uploadId);
    if (!conversationId || !uploadId) {
      sendJson(reply, 400, { error: "invalid conversation ID or upload ID" });
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const upload = ctx.store.getConversationUpload(uploadId);
    if (!upload || upload.conversationId !== conversationId || upload.ownerUserId !== conversation.ownerUserId) {
      sendJson(reply, 404, { error: "upload not found" });
      return;
    }
    ctx.store.deleteConversationUpload(uploadId);
    await rm(resolve(ctx.config.storage.root, upload.storagePath), { recursive: true, force: true });
    const auth = requireUser(request, reply);
    if (auth) ctx.store.insertUploadAudit(auth.gitlabUserId, conversationId, uploadId, "deleted");
    sendJson(reply, 200, { deleted: true });
  });

  /** 图片附件预览：按 uploadId 校验归属后返回原始字节，供对话 chips 显示缩略图。 */
  app.get("/api/ops/conversations/:id/uploads/:uploadId/image", async (request, reply) => {
    const params = request.params as { id: string; uploadId: string };
    const conversationId = idParam(params.id);
    const uploadId = idParam(params.uploadId);
    if (!conversationId || !uploadId) {
      sendJson(reply, 400, { error: "invalid conversation ID or upload ID" });
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const upload = ctx.store.getConversationUpload(uploadId);
    if (!upload || upload.conversationId !== conversationId || upload.ownerUserId !== conversation.ownerUserId ||
        !upload.mime.startsWith("image/")) {
      sendJson(reply, 404, { error: "image upload not found" });
      return;
    }
    try {
      const data = await readFile(resolve(ctx.config.storage.root, upload.storagePath));
      sendBinary(reply, data, upload.mime, { "cache-control": "private, max-age=300" });
    } catch (error) {
      sendJson(reply, 404, { error: `image unavailable: ${errorMessage(error)}` });
    }
  });

  app.get("/api/ops/conversations/:id/followups", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    sendJson(reply, 200, { conversationId, items: ctx.conversations.listFollowUps(conversationId) });
  });

  app.delete("/api/ops/conversations/:id/followups/:itemId", async (request, reply) => {
    const params = request.params as { id: string; itemId: string };
    const conversationId = idParam(params.id);
    const itemId = idParam(params.itemId);
    if (!conversationId || !itemId) {
      sendJson(reply, 400, { error: "invalid conversation ID or queue item ID" });
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    if (!ctx.conversations.removeFollowUp(conversationId, itemId)) {
      sendJson(reply, 404, { error: "queued message not found" });
      return;
    }
    sendJson(reply, 200, { conversationId, itemId, removed: true });
  });

  app.post("/api/ops/conversations/:id/followups/:itemId/move", async (request, reply) => {
    const params = request.params as { id: string; itemId: string };
    const conversationId = idParam(params.id);
    const itemId = idParam(params.itemId);
    if (!conversationId || !itemId) {
      sendJson(reply, 400, { error: "invalid conversation ID or queue item ID" });
      return;
    }
    if (!ownedConversation(ctx, request, reply, conversationId)) return;
    const body = readJsonObject(request, reply);
    if (!body) return;
    const direction = body.direction === "up" || body.direction === "down" ? body.direction : undefined;
    if (!direction) {
      sendJson(reply, 400, { error: "direction must be up or down" });
      return;
    }
    if (!ctx.conversations.moveFollowUp(conversationId, itemId, direction)) {
      sendJson(reply, 404, { error: "queued message cannot be moved" });
      return;
    }
    sendJson(reply, 200, { conversationId, itemId, direction, moved: true });
  });
}
