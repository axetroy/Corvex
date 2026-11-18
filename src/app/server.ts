import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { EventStore } from "../events/store.js";
import { isEventStatus, isEventType } from "../events/model.js";
import { errorMessage } from "../errors.js";
import { parseCommand, NotCorvexCommandError } from "../gitlab/command.js";
import { GitLabApiError, GitLabClient, GitLabWriteError } from "../gitlab/client.js";
import { decodeGitLabNoteEvent, isIssueNoteEvent, MAX_WEBHOOK_BODY_BYTES, validateWebhookToken } from "../gitlab/webhook.js";
import { traceExecutionStep } from "../events/execution.js";
import { ConversationRunner } from "./conversation-runner.js";

const maxReviewRequestCharacters = 2000;
const webhookDeliveryLeaseMs = 60_000;

function requestBody(request: IncomingMessage, maxBytes = MAX_WEBHOOK_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      if (size > maxBytes) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejectPromise(new Error(`request payload exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
    request.on("error", rejectPromise);
  });
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function respondWebhook(
  response: ServerResponse,
  status: number,
  body: string,
  details: Record<string, string | number | boolean> = {},
): void {
  console.info("GitLab webhook response", { status, ...details });
  respond(response, status, body);
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.end(JSON.stringify(value));
}

/** 构建后的运维控制台目录；开发与生产都从包根目录的 dist/app/ui 读取。 */
const operationsUiDirectory = new URL("../../dist/app/ui/", import.meta.url);

/** 运维控制台允许提供的静态资源扩展名与对应响应类型。 */
const operationsUiContentTypes: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  woff2: "font/woff2",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
};

/** 校验 `/ops/assets/<file>` 相对路径，拒绝目录穿越与非白名单扩展名。 */
function operationsUiAsset(relativePath: string): { file: string; contentType: string } | undefined {
  if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(relativePath)) return undefined;
  const extension = relativePath.slice(relativePath.lastIndexOf(".") + 1).toLowerCase();
  const contentType = operationsUiContentTypes[extension];
  return contentType ? { file: relativePath, contentType } : undefined;
}

function basicCredentialsMatch(request: IncomingMessage, username: string, password: string): boolean {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]!, "base64");
  if (provided.toString("base64") !== match[1]) return false;
  const expected = Buffer.from(`${username}:${password}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function optionalInteger(value: string | null, minimum: number, maximum: number): number | undefined | false {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : false;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function webhookEventId(event: ReturnType<typeof decodeGitLabNoteEvent>): string {
  return `${event.project.id}:${event.object_attributes.id}`;
}

function parseListenAddress(address: string): { host: string; port: number } {
  const index = address.lastIndexOf(":");
  if (index < 0) throw new Error(`server.listen must contain a port: "${address}"`);
  const port = Number(address.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`server.listen has an invalid port: "${address}"`);
  }
  let host = address.slice(0, index);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return { host: host || "0.0.0.0", port };
}

export class CorvexServer {
  private readonly server: Server;
  private readonly address: { host: string; port: number };
  /** 对话轮次在 Server 进程内联执行，不进入 Worker 队列。 */
  private readonly conversations: ConversationRunner;
  private readonly conversationAbort = new AbortController();

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    private readonly gitlab: GitLabClient,
  ) {
    this.conversations = new ConversationRunner(config, store, gitlab);
    this.address = parseListenAddress(config.server.listen);
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        console.error("handle HTTP request failed", { error: errorMessage(error) });
        if (!response.headersSent) respond(response, 500, "internal server error\n");
        else response.destroy();
      });
    });
    this.server.headersTimeout = config.server.readTimeout;
  }

  /**
   * 在 Server 进程内联执行一轮对话；异常只记录日志，轮次状态由 store 落库。
   * 关闭 `agent.enabled` 时保留排队轮次并给出告警，避免在没有模型配置时静默丢弃提问。
   */
  private startConversationTurn(turnId: string): void {
    if (!this.config.agent.enabled) {
      console.warn("conversation turn queued while the agent is disabled", { turnId });
      return;
    }
    void this.conversations.runTurn(turnId, this.conversationAbort.signal).catch((error: unknown) => {
      console.error("inline conversation turn failed", { turnId, error: errorMessage(error) });
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.server.once("error", rejectPromise);
      this.server.listen(this.address.port, this.address.host, () => {
        this.server.removeListener("error", rejectPromise);
        resolvePromise();
      });
    });
    console.info("Corvex server listening", {
      address: `${this.address.host}:${this.address.port}`,
    });
    // 对话轮次由本进程内联执行，没有跨进程队列；重启后把残留轮次显式标记失败，
    // 避免界面永远停在「执行中」。
    const interruptedTurns = this.store.recoverInterruptedConversationTurns();
    if (interruptedTurns > 0) {
      console.warn("recovered interrupted conversation turns", { count: interruptedTurns });
    }
    const retention = new AbortController();
    const stopRetention = () => {
      retention.abort();
      this.conversationAbort.abort();
    };
    const retentionTask = this.runRetention(retention.signal);
    signal.addEventListener("abort", stopRetention, { once: true });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const close = () => {
          const timeout = setTimeout(() => {
            rejectPromise(new Error("HTTP server shutdown timed out"));
          }, this.config.server.shutdownTimeout);
          this.server.close((error) => {
            clearTimeout(timeout);
            if (error) rejectPromise(error);
            else resolvePromise();
          });
        };
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
      });
    } finally {
      signal.removeEventListener("abort", stopRetention);
      retention.abort();
      try {
        await retentionTask;
      } catch (error) {
        console.error("retention task ended unexpectedly", { error: errorMessage(error) });
      }
      await this.conversations.releaseAll();
    }
  }

  getListeningAddress(): { host: string; port: number } {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server is not listening on TCP");
    return { host: address.address, port: address.port };
  }

  private respondTrackedWebhook(
    response: ServerResponse,
    status: number,
    body: string,
    deliveryId: string,
    webhookEventId: string | null,
    details: Record<string, string | number | boolean> = {},
  ): void {
    this.store.recordExecutionStep({
      deliveryId,
      webhookEventId,
      eventId: typeof details.eventId === "string" && details.eventId ? details.eventId : null,
      step: "webhook.http_response",
      status: "succeeded",
      input: { status },
      output: { status, body, reason: details.reason ?? null, eventId: details.eventId ?? null },
    });
    respondWebhook(response, status, body, details);
  }

  private async runRetention(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = new Date();
      const historyBefore = new Date(now);
      historyBefore.setUTCDate(historyBefore.getUTCDate() - this.config.storage.retentionDays);
      const auditBefore = new Date(now);
      auditBefore.setUTCDate(auditBefore.getUTCDate() - this.config.storage.auditRetentionDays);
      try {
        this.store.pruneHistory(historyBefore, auditBefore);
      } catch (error) {
        console.error("prune persisted history failed", { error: errorMessage(error) });
      }
      try {
        await this.conversations.releaseIdleWorkspaces();
      } catch (error) {
        console.error("evict idle conversation workspaces failed", { error: errorMessage(error) });
      }
      try {
        await sleep(24 * 60 * 60_000, undefined, { signal });
      } catch {
        if (signal.aborted) return;
        throw new Error("retention timer failed");
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/ops" || path.startsWith("/ops/") || path.startsWith("/api/ops/")) {
      if (!this.config.operations.username || !this.config.operations.password) {
        respond(response, 404, "not found\n");
        return;
      }
      if (!basicCredentialsMatch(request, this.config.operations.username, this.config.operations.password)) {
        response.setHeader("www-authenticate", 'Basic realm="Corvex Operations", charset="UTF-8"');
        respond(response, 401, "authentication required\n");
        return;
      }
      if (path.startsWith("/api/ops/")) {
        await this.operationsApi(request, response, url);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        respond(response, 405, "method not allowed\n");
        return;
      }
      await this.operationsUi(response, path);
      return;
    }
    if (request.method === "GET" && path === "/healthz") {
      respond(response, 200, "ok\n");
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      try {
        this.store.ping();
        respond(response, 200, "ready\n");
      } catch {
        respond(response, 503, "not ready\n");
      }
      return;
    }
    if (request.method === "GET" && path === "/metrics") {
      this.metrics(response);
      return;
    }
    if (request.method === "POST" && path === "/webhooks/gitlab") {
      await this.webhook(request, response);
      return;
    }
    respond(response, 404, "not found\n");
  }

  private async operationsApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (request.method === "GET" && url.pathname === "/api/ops/projects") {
      const page = optionalInteger(url.searchParams.get("page"), 1, 10_000) ?? 1;
      const search = url.searchParams.get("search") ?? "";
      if (page === false || search.length > 100) {
        respondJson(response, 400, { error: "invalid project search" });
        return;
      }
      try {
        respondJson(response, 200, await this.gitlab.listProjects(search, page));
      } catch (error) {
        this.respondGitLabReadError(response, error);
      }
      return;
    }
    const branchSearchMatch = /^\/api\/ops\/projects\/([0-9]+)\/branches$/.exec(url.pathname);
    if (request.method === "GET" && branchSearchMatch) {
      const projectId = Number(branchSearchMatch[1]);
      const page = optionalInteger(url.searchParams.get("page"), 1, 10_000) ?? 1;
      const search = url.searchParams.get("search") ?? "";
      if (!Number.isSafeInteger(projectId) || projectId < 1 || page === false || search.length > 100) {
        respondJson(response, 400, { error: "invalid branch search" });
        return;
      }
      try {
        respondJson(response, 200, await this.gitlab.listBranches(projectId, search, page));
      } catch (error) {
        this.respondGitLabReadError(response, error);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/ops/conversations") {
      const limit = optionalInteger(url.searchParams.get("limit"), 1, 100) ?? 50;
      const offset = optionalInteger(url.searchParams.get("offset"), 0, 1_000_000) ?? 0;
      if (limit === false || offset === false) {
        respondJson(response, 400, { error: "invalid conversation list filter" });
        return;
      }
      respondJson(response, 200, this.store.listConversations(limit, offset));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ops/conversations") {
      const body = await this.readOperationsBody(request, response);
      if (!body) return;
      const projectId = positiveInteger(body.projectId);
      const targetBranch = typeof body.targetBranch === "string" ? body.targetBranch.trim() : "";
      const message = typeof body.message === "string" ? body.message : "";
      if (
        projectId === undefined ||
        !targetBranch || targetBranch.length > 255 ||
        !message.trim() || message.length > 20_000
      ) {
        respondJson(response, 400, { error: "invalid conversation request" });
        return;
      }
      try {
        const project = await this.gitlab.getProject(projectId);
        const headSha = (await this.gitlab.getBranch(projectId, targetBranch)).commit.id;
        const created = this.store.createConversation({
          projectId,
          projectName: project.path_with_namespace ?? project.name ?? String(projectId),
          targetBranch,
          headSha,
          actorId: 0,
          request: message,
        });
        this.startConversationTurn(created.turnId);
        respondJson(response, 202, created);
      } catch (error) {
        this.respondGitLabReadError(response, error);
      }
      return;
    }
    const conversationMatch = /^\/api\/ops\/conversations\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && conversationMatch) {
      const conversationId = this.decodePathSegment(conversationMatch[1]!);
      if (!conversationId) {
        respondJson(response, 400, { error: "invalid conversation ID" });
        return;
      }
      const conversation = this.store.getConversation(conversationId);
      if (!conversation) {
        respondJson(response, 404, { error: "conversation not found" });
        return;
      }
      respondJson(response, 200, conversation);
      return;
    }
    // 整段对话轨迹：把该对话全部轮次的轨迹与执行步骤合并成一条时间线，
    // 供对话页「轨迹」标签默认在一个轨迹里展示所有轮次。
    const conversationTurnsMatch = /^\/api\/ops\/conversations\/([^/]+)\/turns$/.exec(url.pathname);
    if (request.method === "GET" && conversationTurnsMatch) {
      const conversationId = this.decodePathSegment(conversationTurnsMatch[1]!);
      if (!conversationId) {
        respondJson(response, 400, { error: "invalid conversation ID" });
        return;
      }
      const turns = this.store.getConversationTurns(conversationId);
      if (!turns) {
        respondJson(response, 404, { error: "conversation not found" });
        return;
      }
      respondJson(response, 200, turns);
      return;
    }
    // 单轮对话记录：把该轮的状态、生命周期、轨迹与执行步骤一并返回，
    // 供对话页「轨迹」标签查看某一轮的完整记录，无需跳到事件详情页。
    const conversationTurnMatch = /^\/api\/ops\/conversations\/([^/]+)\/turns\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && conversationTurnMatch) {
      const conversationId = this.decodePathSegment(conversationTurnMatch[1]!);
      const eventId = this.decodePathSegment(conversationTurnMatch[2]!);
      if (!conversationId || !eventId) {
        respondJson(response, 400, { error: "invalid conversation turn ID" });
        return;
      }
      const turn = this.store.getConversationTurn(conversationId, eventId);
      if (!turn) {
        respondJson(response, 404, { error: "conversation turn not found" });
        return;
      }
      respondJson(response, 200, turn);
      return;
    }
    // 取消一轮正在内联执行的对话；已结束的轮次返回 409，由界面提示重新拉取。
    const conversationTurnCancelMatch = /^\/api\/ops\/conversations\/([^/]+)\/turns\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === "POST" && conversationTurnCancelMatch) {
      const conversationId = this.decodePathSegment(conversationTurnCancelMatch[1]!);
      const turnId = this.decodePathSegment(conversationTurnCancelMatch[2]!);
      if (!conversationId || !turnId) {
        respondJson(response, 400, { error: "invalid conversation turn ID" });
        return;
      }
      const turn = this.store.getConversationTurn(conversationId, turnId);
      if (!turn) {
        respondJson(response, 404, { error: "conversation turn not found" });
        return;
      }
      if (!this.conversations.cancelTurn(turnId)) {
        respondJson(response, 409, { error: "conversation turn is not running" });
        return;
      }
      respondJson(response, 202, { conversationId, turnId, cancelled: true });
      return;
    }
    // 对话统计：把整个对话的用量与耗时汇总，以及逐轮明细，返回给「统计」标签。
    const conversationStatsMatch = /^\/api\/ops\/conversations\/([^/]+)\/stats$/.exec(url.pathname);
    if (request.method === "GET" && conversationStatsMatch) {
      const conversationId = this.decodePathSegment(conversationStatsMatch[1]!);
      if (!conversationId) {
        respondJson(response, 400, { error: "invalid conversation ID" });
        return;
      }
      const stats = this.store.getConversationStats(conversationId);
      if (!stats) {
        respondJson(response, 404, { error: "conversation not found" });
        return;
      }
      respondJson(response, 200, stats);
      return;
    }
    const conversationMessageMatch = /^\/api\/ops\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method === "POST" && conversationMessageMatch) {
      const conversationId = this.decodePathSegment(conversationMessageMatch[1]!);
      const body = await this.readOperationsBody(request, response);
      if (!body) return;
      const message = typeof body.message === "string" ? body.message : "";
      const conversation = conversationId ? this.store.getConversation(conversationId) : undefined;
      if (!conversationId || !conversation) {
        respondJson(response, conversationId ? 404 : 400, { error: conversationId ? "conversation not found" : "invalid conversation ID" });
        return;
      }
      if (!message.trim() || message.length > 20_000) {
        respondJson(response, 400, { error: "message must be between 1 and 20000 characters" });
        return;
      }
      try {
        const headSha = (await this.gitlab.getBranch(conversation.projectId, conversation.targetBranch)).commit.id;
        const queued = this.store.addConversationMessage(conversation.id, {
          projectId: conversation.projectId,
          targetBranch: conversation.targetBranch,
          headSha,
          actorId: 0,
          request: message,
        });
        this.startConversationTurn(queued.turnId);
        respondJson(response, 202, { conversationId: conversation.id, turnId: queued.turnId });
      } catch (error) {
        if (error instanceof Error && error.message.includes("active turn")) {
          respondJson(response, 409, { error: error.message });
        } else {
          this.respondGitLabReadError(response, error);
        }
      }
      return;
    }
    if (request.method !== "GET") {
      respondJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/api/ops/overview") {
      const generatedAt = new Date();
      const overview = this.store.operationsOverview(Math.max(this.config.worker.pollInterval * 3, 30_000));
      const oldestQueuedAt = overview.oldestQueuedAt;
      const oldestQueueAgeSeconds = oldestQueuedAt
        ? Math.max(0, Math.floor((generatedAt.valueOf() - Date.parse(oldestQueuedAt)) / 1000))
        : null;
      if (oldestQueueAgeSeconds !== null && !Number.isFinite(oldestQueueAgeSeconds)) {
        throw new Error("SQLite returned an invalid oldest queued timestamp");
      }
      respondJson(response, 200, {
        generatedAt: generatedAt.toISOString(),
        ...overview,
        oldestQueueAgeSeconds,
        modelCalls: this.store.modelCallMetrics(),
      });
      return;
    }
    if (url.pathname === "/api/ops/events") {
      const params = url.searchParams;
      const statusValue = params.get("status");
      const typeValue = params.get("type");
      const status = statusValue === null ? undefined : isEventStatus(statusValue) ? statusValue : false;
      const type = typeValue === null ? undefined : isEventType(typeValue) ? typeValue : false;
      const projectId = optionalInteger(params.get("projectId"), 1, Number.MAX_SAFE_INTEGER);
      const mrIid = optionalInteger(params.get("mrIid"), 1, Number.MAX_SAFE_INTEGER);
      const limit = optionalInteger(params.get("limit"), 1, 100) ?? 25;
      const offset = optionalInteger(params.get("offset"), 0, 1_000_000) ?? 0;
      const search = params.get("search") ?? undefined;
      if (
        status === false ||
        type === false ||
        projectId === false ||
        mrIid === false ||
        limit === false ||
        offset === false ||
        (search?.trim().length ?? 0) > 100
      ) {
        respondJson(response, 400, { error: "invalid event list filter" });
        return;
      }
      respondJson(
        response,
        200,
        this.store.listOperationsEvents({
          status,
          type,
          projectId,
          mrIid,
          search,
          limit,
          offset,
        }),
      );
      return;
    }
    const eventMatch = /^\/api\/ops\/events\/([^/]+)$/.exec(url.pathname);
    if (eventMatch) {
      let eventId: string;
      try {
        eventId = decodeURIComponent(eventMatch[1]!);
      } catch {
        respondJson(response, 400, { error: "invalid event ID" });
        return;
      }
      const event = this.store.getEventDetails(eventId);
      if (!event) {
        respondJson(response, 404, { error: "event not found" });
        return;
      }
      respondJson(response, 200, event);
      return;
    }
    respondJson(response, 404, { error: "not found" });
  }

  private async readOperationsBody(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<Record<string, unknown> | undefined> {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      respondJson(response, 415, { error: "application/json is required" });
      return undefined;
    }
    try {
      const body = await requestBody(request, 32 << 10);
      const value: unknown = JSON.parse(body.toString("utf8"));
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        respondJson(response, 400, { error: "request body must be a JSON object" });
        return undefined;
      }
      return value as Record<string, unknown>;
    } catch (error) {
      respondJson(response, 400, { error: errorMessage(error) });
      return undefined;
    }
  }

  private decodePathSegment(value: string): string | undefined {
    try {
      const decoded = decodeURIComponent(value);
      return decoded && decoded.length <= 128 ? decoded : undefined;
    } catch {
      return undefined;
    }
  }

  private respondGitLabReadError(response: ServerResponse, error: unknown): void {
    if (error instanceof GitLabApiError && [401, 403, 404].includes(error.status)) {
      respondJson(response, 404, { error: "GitLab resource is not available to the configured token" });
      return;
    }
    console.warn("operations GitLab read failed", { error: errorMessage(error) });
    respondJson(response, 502, { error: "GitLab request failed" });
  }

  private async operationsUi(response: ServerResponse, path: string): Promise<void> {
    const target = path === "/ops" || path === "/ops/"
      ? { file: "index.html", contentType: "text/html; charset=utf-8" }
      : operationsUiAsset(path.slice("/ops/".length));
    if (!target) {
      respond(response, 404, "not found\n");
      return;
    }
    let contents: Buffer;
    try {
      contents = await readFile(new URL(target.file, operationsUiDirectory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      respond(response, 503, "operations console assets are not built; run pnpm run ui:build\n");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", target.contentType);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-robots-tag", "noindex, nofollow");
    const nonce = target.file === "index.html" ? randomBytes(18).toString("base64url") : undefined;
    response.setHeader(
      "content-security-policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        `style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
        `style-src-elem 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
        "style-src-attr 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "form-action 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    response.end(nonce
      ? contents.toString("utf8").replaceAll("__CORVEX_CSP_NONCE__", nonce)
      : contents);
  }

  private metrics(response: ServerResponse): void {
    try {
      const counts = this.store.eventCounts();
      const calls = this.store.modelCallMetrics();
      const lines = [
        "# HELP corvex_events Number of persisted tasks by lifecycle status.",
        "# TYPE corvex_events gauge",
      ];
      for (const status of [
        "queued",
        "preparing",
        "analyzing",
        "fixing",
        "verifying",
        "publishing",
        "completed",
        "failed",
        "stale",
        "cancelled",
      ]) {
        lines.push(`corvex_events{status=${JSON.stringify(status)}} ${counts[status] ?? 0}`);
      }
      lines.push(
        "# HELP corvex_model_calls_total Model API calls by task type and outcome.",
        "# TYPE corvex_model_calls_total counter",
        "# HELP corvex_model_call_duration_seconds_sum Total duration of model API calls.",
        "# TYPE corvex_model_call_duration_seconds_sum counter",
        "# HELP corvex_model_input_tokens_total Input tokens reported for model API calls.",
        "# TYPE corvex_model_input_tokens_total counter",
        "# HELP corvex_model_output_tokens_total Output tokens reported for model API calls.",
        "# TYPE corvex_model_output_tokens_total counter",
      );
      for (const metric of calls) {
        const labels = `task_type=${JSON.stringify(metric.taskType)},outcome=${JSON.stringify(metric.outcome)}`;
        lines.push(`corvex_model_calls_total{${labels}} ${metric.calls}`);
        lines.push(`corvex_model_call_duration_seconds_sum{${labels}} ${(metric.durationMs / 1000).toFixed(3)}`);
        lines.push(`corvex_model_input_tokens_total{${labels}} ${metric.inputTokens}`);
        lines.push(`corvex_model_output_tokens_total{${labels}} ${metric.outputTokens}`);
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      response.end(`${lines.join("\n")}\n`);
    } catch (error) {
      console.error("collect metrics failed", { error: errorMessage(error) });
      respond(response, 503, "metrics unavailable\n");
    }
  }

  private async webhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const eventType = header(request, "x-gitlab-event");
    console.info("GitLab webhook received", {
      eventType: eventType === "Note Hook" ? eventType : eventType ? "unsupported" : "missing",
    });
    if (!validateWebhookToken(this.config.gitlab.webhookSecret, header(request, "x-gitlab-token"))) {
      console.warn("GitLab webhook rejected", { reason: "invalid_token" });
      respondWebhook(response, 401, "unauthorized\n", { reason: "invalid_token" });
      return;
    }
    const deliveryId = randomUUID();
    if (eventType !== "Note Hook") {
      console.warn("GitLab webhook rejected", { reason: "unsupported_event" });
      this.respondTrackedWebhook(response, 400, "unsupported event\n", deliveryId, null, { reason: "unsupported_event" });
      return;
    }
    let event: ReturnType<typeof decodeGitLabNoteEvent>;
    try {
      const body = await traceExecutionStep(
        this.store,
        { deliveryId },
        "webhook.read_body",
        { eventType, maxBytes: MAX_WEBHOOK_BODY_BYTES },
        () => requestBody(request),
        (value) => ({ bytes: value.byteLength }),
      );
      const bodyBytes = body.byteLength;
      event = await traceExecutionStep(
        this.store,
        { deliveryId },
        "webhook.decode",
        { eventType, bodyBytes },
        () => decodeGitLabNoteEvent(body),
        (value) => {
          const issue = isIssueNoteEvent(value);
          return {
            projectId: value.project.id,
            targetType: issue ? "issue" : "merge_request",
            targetIid: issue ? value.issue.iid : value.merge_request.iid,
            noteId: value.object_attributes.id,
            actorId: value.user.id,
            actorUsername: value.user.username,
            note: value.object_attributes.note,
            noteableType: value.object_attributes.noteable_type,
            system: value.object_attributes.system,
            headSha: issue ? "" : value.merge_request.last_commit?.id ?? "",
          };
        },
      );
    } catch (error) {
      const tooLarge = errorMessage(error).includes("exceeds 1 MiB");
      console.warn("GitLab webhook rejected", {
        reason: tooLarge ? "payload_too_large" : "invalid_payload",
      });
      this.respondTrackedWebhook(
        response,
        tooLarge ? 413 : 400,
        "invalid webhook payload\n",
        deliveryId,
        null,
        { reason: tooLarge ? "payload_too_large" : "invalid_payload" },
      );
      return;
    }
    const id = webhookEventId(event);
    this.store.linkExecutionStepsToEvent(deliveryId, id);
    const isIssue = isIssueNoteEvent(event);
    const targetType = isIssue ? "issue" : "merge_request";
    const targetIid = isIssueNoteEvent(event) ? event.issue.iid : event.merge_request.iid;
    const details = {
      webhookEventId: id,
      projectId: event.project.id,
      targetType,
      targetIid,
      noteId: event.object_attributes.id,
      actorId: event.user.id,
    };
    console.info("GitLab Note Hook validated", {
      ...details,
      actorUsername: event.user.username,
      noteableType: event.object_attributes.noteable_type,
      system: event.object_attributes.system,
      headSha: isIssueNoteEvent(event) ? "" : event.merge_request.last_commit?.id ?? "",
    });
    if (event.object_attributes.system) {
      const reason = "system_note";
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.filter",
        status: "ignored",
        input: { actorId: event.user.id, actorUsername: event.user.username, system: event.object_attributes.system },
        output: { reason },
      });
      console.info("GitLab webhook ignored", { ...details, reason });
      this.respondTrackedWebhook(response, 202, "", deliveryId, id, { ...details, reason });
      return;
    }
    if (this.config.gitlab.blockedUserIds.includes(event.user.id)) {
      console.warn("GitLab webhook rejected", { ...details, reason: "user_blocked" });
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.filter",
        status: "failed",
        input: { actorId: event.user.id },
        output: { blocked: true },
        errorDetail: "user_blocked",
      });
      this.respondTrackedWebhook(response, 403, "user is blocked\n", deliveryId, id, {
        ...details,
        reason: "user_blocked",
      });
      return;
    }

    let command;
    try {
      command = await traceExecutionStep(
        this.store,
        { deliveryId, webhookEventId: id },
        "webhook.parse_command",
        { note: event.object_attributes.note },
        () => parseCommand(event.object_attributes.note, this.config.gitlab.botUsername),
      );
    } catch (error) {
      if (error instanceof NotCorvexCommandError) {
        this.store.recordExecutionStep({
          deliveryId,
          webhookEventId: id,
          step: "webhook.command_filter",
          status: "ignored",
          input: { note: event.object_attributes.note },
          output: { reason: "not_corvex_command" },
        });
        console.info("GitLab webhook ignored", { ...details, reason: "not_corvex_command" });
        this.respondTrackedWebhook(response, 202, "", deliveryId, id, { ...details, reason: "not_corvex_command" });
        return;
      }
      console.warn("GitLab command rejected", { ...details, reason: "invalid_command" });
      await this.reply(response, event, errorMessage(error), deliveryId);
      return;
    }
    console.info("GitLab command recognized", { ...details, command: command.name });
    if ((isIssue && command.name !== "chat" && command.name !== "implement") || (!isIssue && command.name === "implement")) {
      const botUsername = this.config.gitlab.botUsername || "corvex";
      await this.reply(
        response,
        event,
        isIssue
          ? `Mention \`@${botUsername}\` with your question or request. Use \`/implement\` only when you explicitly want code changes.`
          : `The \`/implement\` command is only supported on Issues.`,
        deliveryId,
      );
      return;
    }
    if (command.name === "explain" && command.args.length === 0) {
      console.warn("GitLab command rejected", { ...details, command: command.name, reason: "missing_path" });
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, args: command.args },
        output: { accepted: false },
        errorDetail: "missing_path",
      });
      const botUsername = this.config.gitlab.botUsername || "corvex";
      await this.reply(response, event, `Usage: \`@${botUsername} /explain <path>\`. `, deliveryId);
      return;
    }
    const reviewRequest = command.rawArgs.trim() ? command.rawArgs : "";
    const reviewRequestCharacters = [...reviewRequest].length;
    if ((command.name === "review" || command.name === "chat" || command.name === "implement") && reviewRequestCharacters > maxReviewRequestCharacters) {
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, requestCharacters: reviewRequestCharacters },
        output: { accepted: false },
        errorDetail: `${command.name}_request_too_long`,
      });
      await this.reply(response, event, `Request must be ${maxReviewRequestCharacters} characters or fewer.`, deliveryId);
      return;
    }
    if (
      (command.name === "explain" && command.args.length > 1) ||
      ((command.name === "status" || command.name === "cancel") && command.args.length > 0)
    ) {
      console.warn("GitLab command rejected", {
        ...details,
        command: command.name,
        reason: "unexpected_arguments",
      });
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, args: command.args },
        output: { accepted: false },
        errorDetail: "unexpected_arguments",
      });
      await this.reply(response, event, "This command does not accept arguments.", deliveryId);
      return;
    }

    this.store.recordExecutionStep({
      deliveryId,
      webhookEventId: id,
      step: "webhook.validate_command",
      status: "succeeded",
      input: { name: command.name, args: command.args },
      output: { accepted: true },
    });

    if (isIssueNoteEvent(event)) {
      const projectId = event.project.id;
      const issueIid = event.issue.iid;
      const actorId = event.user.id;
      try {
        const result = await traceExecutionStep(
          this.store,
          { deliveryId, webhookEventId: id },
          "webhook.process_issue_request",
          { command: command.name, projectId, issueIid, actorId },
          () => this.store.createIssueImplementation(
            id,
            `${projectId}:issue:${issueIid}:note:${event.object_attributes.id}`,
            { projectId, issueIid, actorId, request: reviewRequest.trim() },
          ),
          (value) => ({ response: value.response, delivered: value.delivered, event: value.event ?? null }),
        );
        if (result.event) {
          console.info(result.event.created ? "GitLab task enqueued" : "GitLab task already queued", {
            ...details,
            type: "implement",
            eventId: result.event.id,
          });
        }
        if (!result.delivered) {
          const delivery = await this.publishWebhookResponse(
            deliveryId,
            id,
            projectId,
            issueIid,
            result.response,
            result.event?.id,
            "issue",
          );
          if (delivery === "in_progress") {
            this.respondTrackedWebhook(response, 503, "webhook response delivery is in progress\n", deliveryId, id, {
              ...details,
              retryable: true,
            });
            return;
          }
        }
        this.respondTrackedWebhook(response, 202, "", deliveryId, id, {
          ...details,
          command: command.name,
          eventId: result.event?.id ?? "",
        });
      } catch (error) {
        console.error("process GitLab issue command failed", { webhookEventId: id, error: errorMessage(error) });
        this.respondTrackedWebhook(response, 500, "failed to process issue command\n", deliveryId, id, { ...details });
      }
      return;
    }

    const projectId = event.project.id;
    const mrIid = event.merge_request.iid;
    const actorId = event.user.id;
    const headSha = event.merge_request.last_commit?.id ?? "";
    try {
      const result = await traceExecutionStep(
        this.store,
        { deliveryId, webhookEventId: id },
        "webhook.process_command",
        { command: command.name, args: command.args, projectId, mrIid, actorId, headSha },
        () => {
          switch (command.name) {
            case "review":
              return this.store.createReview(id, `${projectId}:${mrIid}:${id}`, {
                projectId,
                mrIid,
                headSha,
                actorId,
                request: reviewRequest,
              });
            case "chat":
              return this.store.createChat(id, `${projectId}:${mrIid}:chat:${id}`, {
                projectId,
                mrIid,
                headSha,
                actorId,
                request: command.rawArgs,
              });
            case "status":
              return this.store.status(id, projectId, mrIid);
            case "cancel":
              return this.store.cancel(id, projectId, mrIid, actorId);
            case "fix":
              return this.store.createFix(
                id,
                `${projectId}:${mrIid}:fix:${id}`,
                { projectId, mrIid, headSha, actorId, request: command.args.join(" ") },
                this.config.fix.enabled,
              );
            case "implement":
              throw new Error("Issue implementation command reached the merge request dispatcher");
            case "explain":
              return this.store.createExplain(id, `${projectId}:${mrIid}:explain:${id}`, {
                projectId,
                mrIid,
                headSha,
                actorId,
                request: command.args[0]!,
              });
          }
        },
        (value) => ({ response: value.response, delivered: value.delivered, event: value.event ?? null }),
      );
      if (result.event) {
        console.info(result.event.created ? "GitLab task enqueued" : "GitLab task already queued", {
          ...details,
          type: command.name,
          eventId: result.event.id,
        });
      } else if (result.delivered) {
        console.info("GitLab webhook duplicate delivery", { ...details, command: command.name });
      } else {
        const reason = command.name === "fix" && !this.config.fix.enabled
          ? "fix_disabled"
          : "command_does_not_enqueue";
        console.info("GitLab command processed without enqueue", {
          ...details,
          command: command.name,
          reason,
        });
      }
      // 只有 GitLab 接受回复后才标记已送达，失败时才能通过 webhook 重投重试。
      if (!result.delivered) {
        const delivery = await this.publishWebhookResponse(
          deliveryId,
          id,
          projectId,
          mrIid,
          result.response,
          result.event?.id,
        );
        if (delivery === "in_progress") {
          this.respondTrackedWebhook(response, 503, "webhook response delivery is in progress\n", deliveryId, id, {
            ...details,
            retryable: true,
          });
          return;
        }
        console.info("GitLab command response published", { ...details, command: command.name });
      }
      this.respondTrackedWebhook(response, 202, "", deliveryId, id, { ...details, command: command.name, eventId: result.event?.id ?? "" });
    } catch (error) {
      console.error("process GitLab command failed", { webhookEventId: id, error: errorMessage(error) });
      this.respondTrackedWebhook(response, 500, "failed to process command\n", deliveryId, id, { ...details });
    }
  }

  private async reply(
    response: ServerResponse,
    event: ReturnType<typeof decodeGitLabNoteEvent>,
    message: string,
    deliveryId: string,
  ): Promise<void> {
    const id = webhookEventId(event);
    const isIssue = isIssueNoteEvent(event);
    const targetType = isIssue ? "issue" : "merge_request";
    const targetIid = isIssue ? event.issue.iid : event.merge_request.iid;
    try {
      const result = await traceExecutionStep(
        this.store,
        { deliveryId, webhookEventId: id },
        "webhook.record_response",
        {
          projectId: event.project.id,
          targetType,
          targetIid,
          body: message,
        },
        () => this.store.recordResponse(id, message),
        (value) => ({ response: value.response, delivered: value.delivered }),
      );
      if (!result.delivered) {
        const delivery = await this.publishWebhookResponse(
          deliveryId,
          id,
          event.project.id,
          targetIid,
          result.response,
          undefined,
          targetType,
        );
        if (delivery === "in_progress") {
          this.respondTrackedWebhook(response, 503, "webhook response delivery is in progress\n", deliveryId, id, {
            retryable: true,
          });
          return;
        }
        console.info("GitLab command feedback published", {
          webhookEventId: id,
          projectId: event.project.id,
          targetIid,
        });
      } else {
        console.info("GitLab webhook duplicate delivery", {
          webhookEventId: id,
          projectId: event.project.id,
          targetIid,
        });
      }
      this.respondTrackedWebhook(response, 202, "", deliveryId, id, {
        webhookEventId: id,
        projectId: event.project.id,
        targetIid,
      });
    } catch (error) {
      console.error("publish GitLab command response failed", { webhookEventId: id, error: errorMessage(error) });
      this.respondTrackedWebhook(response, 502, "failed to publish command response\n", deliveryId, id, { webhookEventId: id });
    }
  }

  private async publishWebhookResponse(
    deliveryId: string,
    webhookEventId: string,
    projectId: number,
    mrIid: number,
    body: string,
    eventId?: string,
    targetType: "merge_request" | "issue" = "merge_request",
  ): Promise<"delivered" | "in_progress"> {
    const claim = this.store.claimWebhookDelivery(webhookEventId, webhookDeliveryLeaseMs);
    if (claim.status !== "claimed") return claim.status;
    const context = { deliveryId, webhookEventId, eventId: eventId ?? null };
    try {
      await traceExecutionStep(
        this.store,
        context,
        "gitlab.post_note",
        { projectId, mrIid, body },
        () => targetType === "issue"
          ? this.gitlab.postIssueNote(projectId, mrIid, body)
          : this.gitlab.postNote(projectId, mrIid, body),
        (receipt) => receipt,
        (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
      );
      await traceExecutionStep(
        this.store,
        context,
        "webhook.mark_delivered",
        { webhookEventId },
        () => this.store.markDelivered(webhookEventId, claim.token),
        () => ({ delivered: true }),
      );
      return "delivered";
    } catch (error) {
      if (!(error instanceof GitLabWriteError && error.outcomeUnknown)) {
        this.store.releaseWebhookDelivery(webhookEventId, claim.token);
      }
      throw error;
    }
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
