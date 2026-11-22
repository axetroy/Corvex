import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { conversationWorkspaceName } from "../../../git/manager.js";
import { isConversationMode } from "../../../events/model.js";
import type { Conversation, ConversationStreamEvent } from "../../../events/model.js";
import { requireUser } from "../../auth/context.js";
import { callAsyncHook } from "../../hooks.js";
import { getConversationSystemPrompt } from "../../../agent/prompts.js";
import { createConversationFileSource } from "../../files/factory.js";
import { resolveWorktreePath } from "../../../agent/fs-write.js";
import { errorMessage } from "../../../errors.js";
import { FilePreviewError } from "../../files/source.js";
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
      const title = await callAsyncHook(ctx.hooks.conversationStart, {
        conversationId: created.conversationId,
        turnId: created.turnId,
        request: message,
        language: responseLanguage ?? ctx.config.agent.responseLanguage,
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

  // 删除对话：先清理常驻工作区，再删除数据库记录。
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
    await ctx.conversations.discardConversationChanges(conversationId, conversation.projectId);
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
      systemPrompt: getConversationSystemPrompt(ctx.config.agent.responseLanguage, conversation.mode),
    });
  });

  // 文件浏览默认读取本地 worktree（含会话本地改动）；worktree 被淘汰或首轮尚未
  // 准备时自动回退到 GitLab API。路由与界面都不依赖具体实现。
  const fileSource = (request: FastifyRequest, conversation: Conversation) => {
    const sha = ctx.store.getConversationTurns(conversation.id)?.turns.at(-1)?.headSha ?? "";
    if (!sha) return undefined;
    return createConversationFileSource({
      projectId: conversation.projectId,
      sha,
      workspacePath: join(
        ctx.config.storage.root,
        "workspaces",
        String(conversation.projectId),
        conversationWorkspaceName(conversation.id),
      ),
      gitlab: ctx.gitlabForRequest(request),
      fallbackToGitLab: true,
    });
  };

  app.get("/api/ops/conversations/:id/files/tree", async (request, reply) => {
    const conversationId = idParam((request.params as { id: string }).id);
    if (!conversationId) {
      invalidConversationId(reply);
      return;
    }
    const conversation = ownedConversation(ctx, request, reply, conversationId);
    if (!conversation) return;
    const source = fileSource(request, conversation);
    if (!source) {
      sendJson(reply, 409, { error: "conversation has no pinned commit yet" });
      return;
    }
    try {
      sendJson(reply, 200, await source.listDirectory(queryParam(request.query, "path") ?? ""));
    } catch (error) {
      sendGitLabReadError(reply, error);
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
    const source = fileSource(request, conversation);
    if (!source) {
      sendJson(reply, 409, { error: "conversation has no pinned commit yet" });
      return;
    }
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
      sendGitLabReadError(reply, error);
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
    const source = fileSource(request, conversation);
    if (!source) {
      sendJson(reply, 409, { error: "conversation has no pinned commit yet" });
      return;
    }
    const path = queryParam(request.query, "path") ?? "";
    if (!path) {
      sendJson(reply, 400, { error: "invalid file path" });
      return;
    }
    try {
      const image = await source.readImage(path);
      sendBinary(reply, image.data, image.mimeType, image.source
        ? { "x-corvex-file-source": image.source }
        : {});
    } catch (error) {
      if (error instanceof FilePreviewError) {
        sendJson(reply, error.status, { error: error.message });
        return;
      }
      sendGitLabReadError(reply, error);
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
      sendJson(reply, 200, {
        ...graph,
        pinnedSha: ctx.store.getConversationTurns(conversation.id)?.turns.at(-1)?.headSha ?? "",
      });
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
    try {
      await ctx.conversations.discardConversationChanges(conversationId, conversation.projectId);
    } catch (error) {
      if (error instanceof Error && error.message.includes("turn is active")) {
        sendJson(reply, 409, { error: "a turn is still running for this conversation" });
        return;
      }
      throw error;
    }
    sendJson(reply, 200, { deleted: true });
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

  // 单轮对话的流式正文：SSE 推送模型已生成的累计文本，结束后立即关闭连接。
  // 鉴权与其余 /api/ops 一致；流里只含本轮正文与终态，不含系统提示或工具输出。
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
    if (!message.trim() || message.length > 20_000) {
      sendJson(reply, 400, { error: "message must be between 1 and 20000 characters" });
      return;
    }
    if (!ensureModelSelected(ctx, reply, user.id)) return;
    try {
      const gitlab = ctx.gitlabForRequest(request);
      const headSha = (await gitlab.getBranch(conversation.projectId, conversation.targetBranch)).commit.id;
      const queued = ctx.store.addConversationMessage(conversation.id, {
        ownerUserId: conversation.ownerUserId,
        projectId: conversation.projectId,
        targetBranch: conversation.targetBranch,
        headSha,
        actorId: 0,
        request: message,
      });
      ctx.startConversationTurn(queued.turnId, gitlab, responseLanguage);
      sendJson(reply, 202, { conversationId: conversation.id, turnId: queued.turnId });
    } catch (error) {
      if (error instanceof Error && error.message.includes("active turn")) {
        sendJson(reply, 409, { error: error.message });
      } else {
        sendGitLabReadError(reply, error);
      }
    }
  });
}
