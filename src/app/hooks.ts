import type { FastifyRequest } from "fastify";
import { AsyncSeriesBailHook, AsyncSeriesHook, SyncHook } from "tapable";
import type { CorvexConfig } from "../config/config.js";
import type { ModelRequest, ModelResponse } from "../agent/pi.js";
import type { ContextSnapshotData } from "../agent/context-inspect.js";
import type { ConversationTurnContext, ResponseLanguage, TraceScope } from "../model.js";
import { normalizeConversationTitle } from "../model.js";
import { stripConversationCommand } from "./conversation-command.js";
import type { AuthUser } from "./auth/model.js";

/** 发起会话时的钩子输入；标题应来自这里的用户消息。 */
export interface ConversationStartInput {
  conversationId: string;
  turnId: string;
  request: string;
  language: ResponseLanguage;
}

/** 首轮完成后用 LLM 精炼标题的输入；仍然只把用户消息交给模型。 */
export interface ConversationTitleRefineInput {
  conversationId: string;
  turnId: string;
  request: string;
  language: ResponseLanguage;
  workspacePath: string;
  signal: AbortSignal;
  trace?: TraceScope;
}

/** 工具执行前后的钩子上下文；轨迹字段可用于把扩展逻辑关联到同一轮。 */
export interface ToolHookContext {
  toolName: string;
  toolCallId: string;
  input: unknown;
  scope?: TraceScope;
  attempt?: number;
}

/** 工具调用完成后的钩子上下文：状态与耗时由工具执行结果决定。 */
export interface ToolResultHookContext extends ToolHookContext {
  output: unknown;
  status: "succeeded" | "failed";
  durationMs: number;
}

/** 存储清理上下文：各清理步骤把结果写回这里，最后统一落一条清理记录。 */
export interface StorageCleanupContext {
  source: "startup" | "retention";
  startedAt: string;
  retentionDays: number;
  /** 启动时只清扫遗留资源，不按保留策略删除历史。 */
  pruneHistory: boolean;
  historyBefore: Date;
  auditBefore: Date;
  removedWorkspaces: number;
  removedRefs: number;
  gcCount: number;
  errors: string[];
  signal?: AbortSignal;
}

/**
 * 应用级扩展点。默认行为也通过 tap 注册，插件/后续功能可以在同一节点追加逻辑，
 * 不需要修改 Server、 Runner 或路由的主流程。
 */
export interface CorvexHooks {
  /** HTTP 服务开始监听之前；适合做启动前检查、资源初始化或注入配置。 */
  serverBeforeListen: AsyncSeriesHook<[]>;
  /** 监听成功之后、对外提供请求之前；启动清理（含中断轮次恢复）注册在这里。 */
  serverAfterListen: AsyncSeriesHook<[{ host: string; port: number }]>;
  /** 关闭 HTTP 服务之前；用于先停止接收新请求并释放外部资源。 */
  serverBeforeClose: AsyncSeriesHook<[]>;
  /** HTTP 服务完全关闭之后；用于最后的清理与审计落库。 */
  serverAfterClose: AsyncSeriesHook<[]>;
  /** 把 Fastify 请求解析为登录用户；第一个返回用户的 tap 生效，未登录返回 undefined。 */
  authResolveUser: AsyncSeriesBailHook<[FastifyRequest], AuthUser | undefined>;
  /** 运行时设置被保存或启动时重新应用之后；Server 借此刷新 GitLab 客户端与对话执行器。 */
  settingsApplied: SyncHook<[CorvexConfig]>;
  /** 启动与每日保留任务的统一清理入口；各步骤按 stage 顺序执行并把结果写回上下文。 */
  storageCleanup: AsyncSeriesHook<[StorageCleanupContext]>;
  /** 一轮对话被领取、准备执行之前；可注入上下文、前置校验或记录指标。 */
  conversationBeforeTurn: AsyncSeriesHook<[ConversationTurnContext]>;
  /** 一轮对话落库并结束之后（含失败与过期）；可追加通知、统计或后处理。 */
  conversationAfterTurn: AsyncSeriesHook<[ConversationTurnContext]>;
  /** 发起对话时派生标题：第一个返回非空标题的 tap 生效，默认从用户消息提取。 */
  conversationStart: AsyncSeriesBailHook<[ConversationStartInput], string | undefined>;
  /** 首轮完成后用 LLM 精炼标题；默认实现由 ConversationRunner 注册，插件可覆盖。 */
  conversationTitleRefine: AsyncSeriesBailHook<[ConversationTitleRefineInput], string | undefined>;
  /** 每次 SDK 会话发起之前；一次 generate 可能因超窗重试产生多次会话。 */
  agentBeforeModel: AsyncSeriesHook<[ModelRequest]>;
  /** 每次 SDK 会话返回之后；可记录模型、Token 用量与耗时，失败时也可能被调用。 */
  agentAfterModel: AsyncSeriesHook<[ModelRequest, ModelResponse]>;
  /** 自定义工具调用之前；回调是同步的，钩子以 fire-and-forget 方式触发。 */
  toolBefore: AsyncSeriesHook<[ToolHookContext]>;
  /** 自定义工具返回之后；用于记录调用结果与耗时，参数已按轨迹规则脱敏。 */
  toolAfter: AsyncSeriesHook<[ToolResultHookContext]>;
  /** 每次模型请求前的上下文快照；默认 tap 负责有界落库，插件可追加分析。 */
  contextSnapshot: AsyncSeriesHook<[ContextSnapshotData]>;
  /**
   * 会话删除或放弃改动时的资源清理入口。
   * 默认 tap 负责 Git ref/worktree 与内存流状态；插件可在同一节点清理自己的资源。
   */
  conversationDelete: AsyncSeriesHook<[ConversationDeleteContext]>;
}

/**
 * 会话删除的清理上下文。数据库记录在调用方完成清理后才删除，
 * 因此这里带着项目 ID 与轮次 ID，插件无需再回查已删除的会话。
 */
export interface ConversationDeleteContext {
  conversationId: string;
  projectId: number;
  /** 删除来源：整会话删除、仅放弃改动、保留策略裁剪。 */
  reason: "delete" | "changes" | "retention";
  /** 会话的轮次 ID，供按轮次的内存状态与 per-turn ref 清理。 */
  turnIds: readonly string[];
  signal?: AbortSignal;
  /** 各 tap 把自身错误写回这里，默认实现不抛出以阻断后续清理。 */
  errors: string[];
}

/**
 * tapable 的异步钩子只提供回调式 API，这里统一包装成 Promise。
 */
export function callAsyncHook<T extends unknown[], R = void>(
  hook: AsyncSeriesHook<T> | AsyncSeriesBailHook<T, R>,
  ...args: T
): Promise<R | undefined> {
  return new Promise<R | undefined>((resolve, reject) => {
    const asyncHook = hook as unknown as {
      callAsync: (...values: [...T, (error?: Error, result?: R) => void]) => void;
    };
    asyncHook.callAsync(...args, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/** 创建全部扩展点并注册默认行为（当前只有标题派生）；插件可在任意节点追加 tap。 */
export function createCorvexHooks(): CorvexHooks {
  const hooks: CorvexHooks = {
    serverBeforeListen: new AsyncSeriesHook([]),
    serverAfterListen: new AsyncSeriesHook(["address"]),
    serverBeforeClose: new AsyncSeriesHook([]),
    serverAfterClose: new AsyncSeriesHook([]),
    authResolveUser: new AsyncSeriesBailHook(["request"]),
    settingsApplied: new SyncHook(["config"]),
    storageCleanup: new AsyncSeriesHook(["context"]),
    conversationBeforeTurn: new AsyncSeriesHook(["turn"]),
    conversationAfterTurn: new AsyncSeriesHook(["turn"]),
    conversationStart: new AsyncSeriesBailHook(["input"]),
    conversationTitleRefine: new AsyncSeriesBailHook(["input"]),
    agentBeforeModel: new AsyncSeriesHook(["request"]),
    agentAfterModel: new AsyncSeriesHook(["request", "response"]),
    toolBefore: new AsyncSeriesHook(["context"]),
    toolAfter: new AsyncSeriesHook(["context"]),
    contextSnapshot: new AsyncSeriesHook(["snapshot"]),
    conversationDelete: new AsyncSeriesHook(["context"]),
  };
  // 默认实现：标题只来自用户消息，不做额外的模型调用。
  // 默认实现放在较低优先级的 stage，插件可以先行返回自定义标题。
  hooks.conversationStart.tap({ name: "user-request", stage: 100 }, (input) =>
    normalizeConversationTitle(stripConversationCommand(input.request), input.language),
  );
  return hooks;
}
