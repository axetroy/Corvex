import type { ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { CorvexConfig } from "../config/config.js";
import type { EventStore } from "../events/store.js";
import { errorMessage } from "../errors.js";
import { currentUser } from "./auth/context.js";
import { GitLabOAuthService } from "./auth/service.js";
import type { FastifyRequest } from "fastify";
import { createTokenCipher, type TokenCipher } from "../tokens.js";
import { GitLabClient } from "../gitlab/client.js";
import { MAX_WEBHOOK_BODY_BYTES } from "../gitlab/webhook.js";
import { ConversationRunner } from "./conversation-runner.js";
import { EventRunner } from "./event-runner.js";
import { attachOperationsAuth } from "./http/auth.js";
import type { OpsContext } from "./http/context.js";
import { sendJson, sendText } from "./http/respond.js";
import { registerRoutes } from "./http/routes.js";
import { SettingsService } from "./settings-service.js";

/** 把 `host:port` 形式监听地址拆成 Fastify 需要的字段；支持 `[::1]:8080`。 */
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

/**
 * HTTP 服务进程。
 *
 * 路由与鉴权由 `src/app/http/` 下的 Fastify 路由模块提供；本类只负责生命周期
 * （监听、内联事件执行、内联对话轮次、清理任务、优雅关闭），并保持原有的构造参数与
 * `run` / `getListeningAddress` 契约。
 */
export class CorvexServer {
  private readonly app: FastifyInstance;
  private readonly address: { host: string; port: number };
  /** 对话轮次在 Server 进程内联执行，不进入事件队列。 */
  private readonly conversations: ConversationRunner;
  /** 事件（review/chat/explain/fix/implement）在 Server 进程内联执行。 */
  private readonly events: EventRunner;
  private readonly settings: SettingsService;
  private readonly cipher: TokenCipher;
  private readonly oauth: GitLabOAuthService;
  private readonly conversationAbort = new AbortController();
  /** 正在推送的对话流连接；关闭 Server 时主动结束，避免长连接拖住 `app.close()`。 */
  private readonly conversationStreams = new Set<ServerResponse>();

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    private readonly gitlab: GitLabClient,
    /** 配置文件路径；提供时 Agent 控制台可在运行时覆盖上下文设置并持久化。 */
    configPath?: string,
  ) {
    this.address = parseListenAddress(config.server.listen);
    this.cipher = createTokenCipher(store.getOrCreateSessionSecret());
    this.oauth = new GitLabOAuthService(config, store, this.cipher);
    this.conversations = new ConversationRunner(config, store, gitlab);
    // 内联事件执行器与 HTTP 服务共用同一个进程、同一个 SQLite 和同一份 Git 存储。
    this.events = new EventRunner(config, store, gitlab);
    // 启动时的配置快照：写入设置时以它为基准重新计算，避免旧覆盖项残留。
    this.settings = new SettingsService(config, store, structuredClone(config), configPath, (applied) => {
      this.conversations.reconfigureGitLab(
        applied.gitlab.baseUrl,
        applied.gitlab.readToken,
        applied.gitlab.writeToken,
      );
      // 事件执行器持有构造期读取的参数，设置变更后立即重建，无需等下一轮循环。
      this.events.refreshRuntimeSettings();
    });
    this.app = Fastify({
      // 原实现对 HEAD 不额外放行，交给路由兜底；保持同样的可见行为。
      exposeHeadRoutes: false,
      // 多读一个字节，让超限 1 字节的 webhook 进入处理器并留下执行轨迹。
      bodyLimit: MAX_WEBHOOK_BODY_BYTES + 1,
    });
    // 所有请求体先按原始字节读取：webhook 需要原文验签与解析，
    // `/api/ops` 自行校验 content-type 并解析 JSON。
    this.app.removeAllContentTypeParsers();
    this.app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
    this.app.server.headersTimeout = config.server.readTimeout;
    attachOperationsAuth(this.app, { store, cipher: this.cipher, oauth: this.oauth });
    this.app.setNotFoundHandler((_request, reply) => {
      sendText(reply, 404, "not found\n");
    });
    // 保留原实现的错误日志与纯文本 500；请求体解析等 4xx 仍按 JSON 返回。
    this.app.setErrorHandler((error: FastifyError, _request, reply) => {
      if (reply.sent || reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      const status = error.statusCode;
      if (status !== undefined && status >= 400 && status < 500) {
        sendJson(reply, status, { error: errorMessage(error) });
        return;
      }
      console.error("handle HTTP request failed", { error: errorMessage(error) });
      sendText(reply, 500, "internal server error\n");
    });
    registerRoutes(this.app, this.operationsContext());
  }

  /** 提供给路由模块的依赖；只在注册阶段构造一次。 */
  private operationsContext(): OpsContext {
    return {
      config: this.config,
      store: this.store,
      gitlab: this.gitlab,
      conversations: this.conversations,
      events: this.events,
      oauth: this.oauth,
      settings: this.settings,
      gitlabForRequest: (request: FastifyRequest) => {
        const user = currentUser(request);
        if (!user) return this.gitlab;
        return new GitLabClient(this.config.gitlab.baseUrl, user.accessToken, user.accessToken, 10_000, "bearer");
      },
      conversationStreams: this.conversationStreams,
      startConversationTurn: (turnId, gitlab) => {
        this.startConversationTurn(turnId, gitlab);
      },
    };
  }

  /**
   * 在 Server 进程内联执行一轮对话；异常只记录日志，轮次状态由 store 落库。
   */
  private startConversationTurn(turnId: string, gitlab: GitLabClient): void {
    void this.conversations.runTurn(turnId, this.conversationAbort.signal, gitlab).catch((error: unknown) => {
      console.error("inline conversation turn failed", { turnId, error: errorMessage(error) });
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    this.settings.applyStored();
    await this.app.listen({ host: this.address.host, port: this.address.port });
    console.info("Corvex server listening", {
      address: `${this.address.host}:${this.address.port}`,
    });
    // 对话轮次由本进程内联执行，没有跨进程队列；重启后把残留轮次显式标记失败，
    // 避免界面永远停在「执行中」。
    const interruptedTurns = this.store.recoverInterruptedConversationTurns();
    if (interruptedTurns > 0) {
      console.warn("recovered interrupted conversation turns", { count: interruptedTurns });
    }
    // 重启后没有在途轮次，清掉上次进程留下的对话 worktree，避免磁盘占用只增不减。
    const sweepStarted = new Date().toISOString();
    try {
      const removed = await this.conversations.cleanupStaleWorkspaces();
      this.store.recordStorageCleanup({
        startedAt: sweepStarted,
        finishedAt: new Date().toISOString(),
        source: "startup",
        applied: true,
        olderThanDays: 0,
        removedWorkspaces: removed,
        removedMirrors: 0,
        error: "",
      });
    } catch (error) {
      console.warn("conversation workspace cleanup failed", { error: errorMessage(error) });
      this.store.recordStorageCleanup({
        startedAt: sweepStarted,
        finishedAt: new Date().toISOString(),
        source: "startup",
        applied: true,
        olderThanDays: 0,
        removedWorkspaces: 0,
        removedMirrors: 0,
        error: errorMessage(error),
      });
    }
    const retention = new AbortController();
    const stopRetention = () => {
      retention.abort();
      this.conversationAbort.abort();
      // 先结束流连接，再等 app.close()：SSE 不会自己断开，留着会拖到超时。
      for (const stream of this.conversationStreams) {
        stream.end();
      }
      this.conversationStreams.clear();
    };
    const retentionTask = this.runRetention(retention.signal);
    signal.addEventListener("abort", stopRetention, { once: true });
    // 事件在 Server 进程内联执行：Webhook 入队后立即唤醒，重启时补跑残留事件。
    const runnerAbort = new AbortController();
    const abortRunner = () => runnerAbort.abort();
    signal.addEventListener("abort", abortRunner, { once: true });
    const eventRunnerTask = this.events.run(runnerAbort.signal).catch((error: unknown) => {
      console.error("event runner stopped unexpectedly", { error: errorMessage(error) });
    });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const close = () => {
          const timeout = setTimeout(() => {
            rejectPromise(new Error("HTTP server shutdown timed out"));
          }, this.config.server.shutdownTimeout);
          this.app.close().then(
            () => {
              clearTimeout(timeout);
              resolvePromise();
            },
            (error: unknown) => {
              clearTimeout(timeout);
              rejectPromise(error);
            },
          );
        };
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
      });
    } finally {
      signal.removeEventListener("abort", stopRetention);
      signal.removeEventListener("abort", abortRunner);
      retention.abort();
      // 先让执行器在关闭信号下收尾（在途事件保留租约，下次启动补跑），再释放资源。
      runnerAbort.abort();
      await eventRunnerTask;
      try {
        await retentionTask;
      } catch (error) {
        console.error("retention task ended unexpectedly", { error: errorMessage(error) });
      }
      await this.conversations.releaseAll();
    }
  }

  getListeningAddress(): { host: string; port: number } {
    const address = this.app.server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server is not listening on TCP");
    return { host: address.address, port: address.port };
  }

  /** 每日保留策略：裁剪历史、回收空闲工作区，并记录清理日志。 */
  private async runRetention(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = new Date();
      const historyBefore = new Date(now);
      historyBefore.setUTCDate(historyBefore.getUTCDate() - this.config.storage.retentionDays);
      const auditBefore = new Date(now);
      auditBefore.setUTCDate(auditBefore.getUTCDate() - this.config.storage.auditRetentionDays);
      const retentionStarted = new Date().toISOString();
      let retentionError = "";
      try {
        this.store.pruneHistory(historyBefore, auditBefore);
      } catch (error) {
        retentionError = errorMessage(error);
        console.error("prune persisted history failed", { error: retentionError });
      }
      this.store.recordStorageCleanup({
        startedAt: retentionStarted,
        finishedAt: new Date().toISOString(),
        source: "retention",
        applied: true,
        olderThanDays: this.config.storage.retentionDays,
        removedWorkspaces: 0,
        removedMirrors: 0,
        error: retentionError,
      });
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
}
