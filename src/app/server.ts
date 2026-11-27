import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { CorvexConfig } from "../config/config.js";
import type { AppStore } from "../store.js";
import type { ResponseLanguage } from "../model.js";
import { errorMessage } from "../errors.js";
import { skillImportLimits } from "../agent/skill-import.js";
import { SkillStore } from "../agent/skill-store.js";
import { SkillRegistry } from "../agent/skill-registry.js";
import { maxUploadBytesCeiling, uploadContentType } from "./upload.js";
import { pruneEmptyUploadDirs } from "./upload-cleanup.js";
import { currentUser } from "./auth/context.js";
import { GitLabOAuthService } from "./auth/service.js";
import type { FastifyRequest } from "fastify";
import { createTokenCipher, type TokenCipher } from "../tokens.js";
import { GitLabClient } from "../gitlab/client.js";
import { ConversationRunner } from "./conversation-runner.js";
import { ScheduledTasksScheduler } from "./scheduled-tasks.js";
import { attachOperationsAuth, readCookie, sessionCookieName } from "./http/auth.js";
import {
  callAsyncHook,
  createCorvexHooks,
  type ConversationDeleteContext,
  type CorvexHooks,
  type StorageCleanupContext,
} from "./hooks.js";
import type { OpsContext } from "./http/context.js";
import { sendJson, sendText } from "./http/respond.js";
import { registerRoutes } from "./http/routes.js";
import { SettingsService } from "./settings-service.js";
import { ExecutionConfigService } from "./execution-config-service.js";

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
  /** 对话轮次在 Server 进程内联执行。 */
  private readonly conversations: ConversationRunner;
  private readonly skills: SkillStore;
  private readonly skillRegistry: SkillRegistry;
  private readonly settings: SettingsService;
  private readonly executionConfig: ExecutionConfigService;
  private readonly cipher: TokenCipher;
  private readonly oauth: GitLabOAuthService;
  private readonly hooks: CorvexHooks;
  private readonly conversationAbort = new AbortController();
  /** 正在推送的对话流连接；关闭 Server 时主动结束，避免长连接拖住 `app.close()`。 */
  private readonly conversationStreams = new Set<ServerResponse>();
  private readonly scheduledTasks: ScheduledTasksScheduler;

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: AppStore,
    /** 配置文件路径；提供时 Agent 控制台可在运行时覆盖上下文设置并持久化。 */
    configPath?: string,
    hooks: CorvexHooks = createCorvexHooks(),
  ) {
    this.hooks = hooks;
    this.address = parseListenAddress(config.server.listen);
    this.cipher = createTokenCipher(store.getOrCreateSessionSecret());
    this.oauth = new GitLabOAuthService(config, store, this.cipher);
    this.skillRegistry = new SkillRegistry(resolve(config.storage.root));
    this.skills = this.skillRegistry.global;
    this.conversations = new ConversationRunner(config, store, this.hooks, this.skills, this.skillRegistry);
    this.scheduledTasks = new ScheduledTasksScheduler({
      config, store, conversations: this.conversations,
      clientForUser: (userId) => this.clientForUser(userId),
    });
    // 启动恢复的排队轮次没有 HTTP 请求传入信号，统一用 Server 的关闭信号中止。
    this.conversations.setShutdownSignal(this.conversationAbort.signal);
    // 默认行为也走钩子：认证会话解析与设置热更新都可被插件扩展或替换。
    this.hooks.authResolveUser.tapPromise("session", async (request) => {
      const sessionId = readCookie(request.headers.cookie, sessionCookieName);
      const session = sessionId ? store.readUserSession(sessionId) : undefined;
      const user = session ? store.readUser(session.userId, this.cipher) : undefined;
      if (!user) return undefined;
      // 被禁用用户：令牌与会话已在禁用时清除；这里再兜一层，旧会话也立即失效。
      if (user.disabled) {
        if (sessionId) store.deleteUserSession(sessionId);
        return undefined;
      }
      const refreshed = await this.oauth.refresh(user);
      if (!refreshed) {
        // 令牌已失效且无法续期：删除本地会话，让后续请求统一返回 401 并触发前端重新登录。
        if (sessionId) store.deleteUserSession(sessionId);
        return undefined;
      }
      return refreshed;
    });
    this.hooks.settingsApplied.tap("runners", (applied) => {
      this.conversations.reconfigureGitLab(applied.gitlab.baseUrl);
    });
    // 默认清理步骤全部通过钩子接入，插件可在任意 stage 追加自己的清理。
    // 每个步骤自行捕获错误写入 context.errors，避免一个失败阻断后续步骤。
    this.hooks.storageCleanup.tapPromise({ name: "prune-history", stage: 100 }, async (context) => {
      if (!context.pruneHistory) return;
      try {
        const pruned = this.store.pruneHistory(context.historyBefore, context.auditBefore);
        // 保留策略删除的每个会话都走同一清理 hook，插件可借此释放自己的资源。
        for (const target of pruned) {
          const deletion: ConversationDeleteContext = {
            conversationId: target.conversationId,
            projectId: target.projectId,
            reason: "retention",
            turnIds: target.turnIds,
            signal: context.signal,
            errors: [],
          };
          try {
            await callAsyncHook(this.hooks.conversationDelete, deletion);
          } catch (error) {
            deletion.errors.push(errorMessage(error));
          }
          if (deletion.errors.length > 0) {
            context.errors.push(
              `conversation ${target.conversationId} cleanup failed: ${deletion.errors.join("; ")}`,
            );
          }
        }
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    this.hooks.storageCleanup.tapPromise({ name: "prune-change-refs", stage: 200 }, async (context) => {
      try {
        context.removedRefs = await this.conversations.pruneConversationChanges(new Set(this.store.listConversationIds()));
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    this.hooks.storageCleanup.tapPromise({ name: "gc-mirrors", stage: 300 }, async (context) => {
      try {
        context.gcCount = await this.conversations.gcMirrors(context.retentionDays);
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    this.hooks.storageCleanup.tapPromise({ name: "release-idle", stage: 400 }, async (context) => {
      if (context.source !== "retention") return;
      try {
        await this.conversations.releaseIdleWorkspaces();
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    this.hooks.storageCleanup.tapPromise({ name: "prune-empty-workspace-dirs", stage: 500 }, async (context) => {
      try {
        // 删除 worktree 后残留的空项目目录，与超时无关；每次清理都执行。
        const removed = await this.conversations.pruneEmptyWorkspaceDirs();
        context.removedWorkspaces += removed;
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    this.hooks.storageCleanup.tapPromise({ name: "prune-empty-upload-dirs", stage: 550 }, async (context) => {
      try {
        await pruneEmptyUploadDirs(this.config.storage.root);
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    this.hooks.storageCleanup.tapPromise({ name: "record", stage: 900 }, async (context) => {
      this.store.recordStorageCleanup({
        startedAt: context.startedAt,
        finishedAt: new Date().toISOString(),
        source: context.source,
        applied: true,
        olderThanDays: context.source === "startup" ? 0 : context.retentionDays,
        removedWorkspaces: context.removedWorkspaces,
        removedMirrors: 0,
        error: context.errors.join("; "),
      });
    });

    this.hooks.serverAfterListen.tapPromise("startup", async () => {
      const interruptedTurns = this.store.recoverInterruptedConversationTurns();
      if (interruptedTurns > 0) {
        console.warn("recovered interrupted conversation turns", { count: interruptedTurns });
      }
      // 重启后没有在途轮次，清掉上次进程留下的对话 worktree 并执行统一清理钩子。
      // 启动只跑一次完整清理（含历史裁剪），每日保留任务因此先等待一个周期。
      const now = new Date();
      const historyBefore = new Date(now);
      historyBefore.setUTCDate(historyBefore.getUTCDate() - config.storage.retentionDays);
      const auditBefore = new Date(now);
      auditBefore.setUTCDate(auditBefore.getUTCDate() - config.storage.auditRetentionDays);
      const context: StorageCleanupContext = {
        source: "startup",
        startedAt: new Date().toISOString(),
        retentionDays: config.storage.retentionDays,
        pruneHistory: true,
        historyBefore,
        auditBefore,
        removedWorkspaces: 0,
        removedRefs: 0,
        gcCount: 0,
        errors: [],
      };
      // 工作区清理失败不能跳过后续清理钩子：各阶段独立记录错误，钩子按约定仍会执行。
      try {
        context.removedWorkspaces = await this.conversations.cleanupStaleWorkspaces();
      } catch (error) {
        context.errors.push(errorMessage(error));
        console.warn("conversation workspace cleanup failed", { error: errorMessage(error) });
      }
      try {
        await callAsyncHook(this.hooks.storageCleanup, context);
      } catch (error) {
        context.errors.push(errorMessage(error));
        console.warn("storage cleanup hook failed", { error: errorMessage(error) });
      }
      // 上次进程留下的排队补充消息没有在途轮次触发，启动时主动消费一次。
      void this.conversations.resumeFollowUps((userId) => this.clientForUser(userId)).catch((error: unknown) => {
        console.warn("queued conversation follow-ups could not resume", { error: errorMessage(error) });
      });
      // 计划任务启动时只推进错过的触发，不批量补跑。
      this.scheduledTasks.recover();
    });
    // 启动时的配置快照：写入设置时以它为基准重新计算，避免旧覆盖项残留。
    this.settings = new SettingsService(config, store, structuredClone(config), configPath, (applied) => {
      this.hooks.settingsApplied.call(applied);
    });
    // 执行环境配置由管理员 UI 管理；保存后 exec 后端在每轮重建，无需重启。
    this.executionConfig = new ExecutionConfigService(
      config, store, structuredClone(config), (applied) => this.hooks.settingsApplied.call(applied),
    );
    this.app = Fastify({
      // 原实现对 HEAD 不额外放行，交给路由兜底；保持同样的可见行为。
      exposeHeadRoutes: false,
    });
    // 所有请求体先按原始字节读取；`/api/ops` 自行校验 content-type 并解析 JSON。
    this.app.removeAllContentTypeParsers();
    // 技能包 ZIP 单独放宽到导入上限；其余路由仍受 Fastify 默认请求体限制。
    this.app.addContentTypeParser(
      "application/zip",
      { parseAs: "buffer", bodyLimit: skillImportLimits.maxArchiveBytes },
      (_request, body, done) => done(null, body),
    );
    // 会话文本附件走专用 content-type，独立限额且不与 JSON API / 技能包 ZIP 冲突。
    this.app.addContentTypeParser(
      uploadContentType,
      { parseAs: "buffer", bodyLimit: maxUploadBytesCeiling },
      (_request, body, done) => done(null, body),
    );
    this.app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
    this.app.server.headersTimeout = config.server.readTimeout;
    attachOperationsAuth(this.app, { hooks: this.hooks, oauthConfigured: () => this.oauth.configured });
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

  /**
   * 构造按用户绑定动态 token 的 GitLab 客户端：每次请求现读 store 里的令牌，
   * 因此长轮次运行中若 token 被后台刷新（旧 token 被 GitLab 吊销），后续调用立即用新令牌。
   * provider 只读当前用户，不会跨用户泄漏。
   */
  /** 非请求路径（启动恢复、计划任务）按用户解析有效令牌；失败/禁用返回 undefined，绝不回退全局凭据。 */
  private async clientForUser(userId: string): Promise<GitLabClient | undefined> {
    const saved = this.store.readUser(userId, this.cipher);
    if (!saved || saved.disabled) return undefined;
    const user = await this.oauth.refresh(saved);
    if (!user) return undefined;
    return this.createGitLabClient(userId, user.accessToken);
  }

  private createGitLabClient(userId: string, fallbackToken: string): GitLabClient {
    return new GitLabClient(
      this.config.gitlab.baseUrl,
      fallbackToken,
      10_000,
      () => this.store.readUser(userId, this.cipher)?.accessToken ?? fallbackToken,
    );
  }

  /** 提供给路由模块的依赖；只在注册阶段构造一次。 */
  private operationsContext(): OpsContext {
    return {
      config: this.config,
      store: this.store,
      skills: this.skills,
      skillRegistry: this.skillRegistry,
      conversations: this.conversations,
      oauth: this.oauth,
      hooks: this.hooks,
      settings: this.settings,
      executionConfig: this.executionConfig,
      gitlabForRequest: (request: FastifyRequest) => {
        const user = currentUser(request);
        // 受保护路由已经校验登录态；这里再兜一层，确保绝不产生无用户凭据的 GitLab 请求。
        if (!user) throw new Error("a signed-in user is required for GitLab access");
        return this.createGitLabClient(user.id, user.accessToken);
      },
      conversationStreams: this.conversationStreams,
      startConversationTurn: (turnId, gitlab, responseLanguage) => {
        this.startConversationTurn(turnId, gitlab, responseLanguage);
      },
      runScheduledTaskNow: (taskId) => this.scheduledTasks.runNow(taskId),
    };
  }

  /**
   * 在 Server 进程内联执行一轮对话；异常只记录日志，轮次状态由 store 落库。
   */
  private startConversationTurn(turnId: string, gitlab: GitLabClient, responseLanguage?: ResponseLanguage): void {
    void this.conversations.runTurn(turnId, this.conversationAbort.signal, gitlab, responseLanguage).catch((error: unknown) => {
      console.error("inline conversation turn failed", { turnId, error: errorMessage(error) });
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    this.settings.applyStored();
    this.executionConfig.applyStored();
    // 技能只在启动时做一次迁移/种子刷新；必须在 listen 之前完成，保证第一个请求就能用。
    const migrated = await this.skills.migrateFromStore(this.store);
    await this.skills.seedSystemSkills();
    if (migrated.skills > 0 || migrated.packs > 0) {
      console.info("migrated skills to disk", migrated);
    }
    await callAsyncHook(this.hooks.serverBeforeListen);
    await this.app.listen({ host: this.address.host, port: this.address.port });
    console.info("Corvex server listening", {
      address: `${this.address.host}:${this.address.port}`,
    });
    await callAsyncHook(this.hooks.serverAfterListen, this.getListeningAddress());
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
    const scheduledTask = this.scheduledTasks.run(retention.signal);
    signal.addEventListener("abort", stopRetention, { once: true });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const close = () => {
          void (async () => {
            try {
              await callAsyncHook(this.hooks.serverBeforeClose);
            } catch (error) {
              rejectPromise(error);
              return;
            }
            const timeout = setTimeout(() => {
              rejectPromise(new Error("HTTP server shutdown timed out"));
            }, this.config.server.shutdownTimeout);
            this.app.close().then(
              () => {
                clearTimeout(timeout);
                callAsyncHook(this.hooks.serverAfterClose).then(
                  () => resolvePromise(),
                  (error: unknown) => rejectPromise(error),
                );
              },
              (error: unknown) => {
                clearTimeout(timeout);
                rejectPromise(error);
              },
            );
          })();
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
      try {
        await scheduledTask;
      } catch (error) {
        console.error("scheduled tasks ended unexpectedly", { error: errorMessage(error) });
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
    // 启动时的清扫由 serverAfterListen 的 storageCleanup(startup) 完成；
    // 这里先等一个周期，避免同一时刻执行两遍清理与 gc。
    try {
      await sleep(24 * 60 * 60_000, undefined, { signal });
    } catch {
      if (signal.aborted) return;
      throw new Error("retention timer failed");
    }
    while (!signal.aborted) {
      const now = new Date();
      const historyBefore = new Date(now);
      historyBefore.setUTCDate(historyBefore.getUTCDate() - this.config.storage.retentionDays);
      const auditBefore = new Date(now);
      auditBefore.setUTCDate(auditBefore.getUTCDate() - this.config.storage.auditRetentionDays);
      const context: StorageCleanupContext = {
        source: "retention",
        startedAt: new Date().toISOString(),
        retentionDays: this.config.storage.retentionDays,
        pruneHistory: true,
        historyBefore,
        auditBefore,
        removedWorkspaces: 0,
        removedRefs: 0,
        gcCount: 0,
        errors: [],
        signal,
      };
      try {
        await callAsyncHook(this.hooks.storageCleanup, context);
      } catch (error) {
        context.errors.push(errorMessage(error));
        console.error("storage cleanup hook failed", { error: errorMessage(error) });
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
