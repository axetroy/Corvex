import type { ServerResponse } from "node:http";
import type { FastifyRequest } from "fastify";
import type { CorvexConfig } from "../../config/config.js";
import type { GitLabOAuthService } from "../auth/service.js";
import type { CorvexHooks } from "../hooks.js";
import type { AppStore } from "../../store.js";
import type { SkillStore } from "../../agent/skill-store.js";
import type { GitLabClient } from "../../gitlab/client.js";
import type { ResponseLanguage } from "../../model.js";
import type { ConversationRunner } from "../conversation-runner.js";
import type { SettingsService } from "../settings-service.js";
import type { ExecutionConfigService } from "../execution-config-service.js";

/**
 * `/api/ops` 路由所需的运行时依赖。Server 只暴露路由真正需要的能力，
 * 这样路由模块不必依赖 `CorvexServer` 的内部实现。
 */
export interface OpsContext {
  readonly config: CorvexConfig;
  readonly store: AppStore;
  /** 磁盘技能存储；技能的唯一权威来源，SQLite 不再保存技能文档或压缩包。 */
  readonly skills: SkillStore;
  readonly conversations: ConversationRunner;
  readonly settings: SettingsService;
  readonly executionConfig: ExecutionConfigService;
  /** GitLab OAuth 服务；用于当前用户信息与登录态。 */
  readonly oauth: GitLabOAuthService;
  readonly hooks: CorvexHooks;
  /** 以当前登录用户令牌构造的 GitLab 客户端。 */
  gitlabForRequest(request: FastifyRequest): GitLabClient;
  /** 正在推送的对话流连接；Server 关闭时统一结束，避免拖住 `close()`。 */
  readonly conversationStreams: Set<ServerResponse>;
  /** 在 Server 进程内联启动一轮对话。 */
  startConversationTurn(turnId: string, gitlab: GitLabClient, responseLanguage?: ResponseLanguage): void;
  /** 手动触发一次计划任务（等价事件触发）。 */
  runScheduledTaskNow(taskId: string): Promise<boolean>;
}
