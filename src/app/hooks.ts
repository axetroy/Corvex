import type { FastifyRequest } from "fastify";
import { AsyncSeriesBailHook, AsyncSeriesHook, SyncHook } from "tapable";
import type { CorvexConfig } from "../config/config.js";
import type { ModelRequest, ModelResponse } from "../agent/pi.js";
import type { ConversationTurnContext, Event, ResponseLanguage, TraceScope } from "../events/model.js";
import { normalizeConversationTitle } from "../events/model.js";
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

export interface ToolResultHookContext extends ToolHookContext {
  output: unknown;
  status: "succeeded" | "failed";
  durationMs: number;
}

/**
 * 应用级扩展点。默认行为也通过 tap 注册，插件/后续功能可以在同一节点追加逻辑，
 * 不需要修改 Server、 Runner 或路由的主流程。
 */
export interface CorvexHooks {
  serverBeforeListen: AsyncSeriesHook<[]>;
  serverAfterListen: AsyncSeriesHook<[{ host: string; port: number }]>;
  serverBeforeClose: AsyncSeriesHook<[]>;
  serverAfterClose: AsyncSeriesHook<[]>;
  /** 返回用户即完成认证；第一个返回值的 tap 生效。 */
  authResolveUser: AsyncSeriesBailHook<[FastifyRequest], AuthUser | undefined>;
  settingsApplied: SyncHook<[CorvexConfig]>;
  eventBeforeProcess: AsyncSeriesHook<[Event]>;
  eventAfterProcess: AsyncSeriesHook<[Event]>;
  conversationBeforeTurn: AsyncSeriesHook<[ConversationTurnContext]>;
  conversationAfterTurn: AsyncSeriesHook<[ConversationTurnContext]>;
  /** 发起会话：第一个返回非空标题的 tap 生效；默认从用户消息派生标题。 */
  conversationStart: AsyncSeriesBailHook<[ConversationStartInput], string | undefined>;
  /** 首轮完成后用 LLM 从用户消息精炼标题；默认实现注册在 ConversationRunner。 */
  conversationTitleRefine: AsyncSeriesBailHook<[ConversationTitleRefineInput], string | undefined>;
  /** 模型调用前后；一次 generate 可能包含多次 SDK 会话（超限重试）。 */
  agentBeforeModel: AsyncSeriesHook<[ModelRequest]>;
  agentAfterModel: AsyncSeriesHook<[ModelRequest, ModelResponse]>;
  /** 工具执行前后；事件回调是同步的，钩子以 fire-and-forget 方式触发。 */
  toolBefore: AsyncSeriesHook<[ToolHookContext]>;
  toolAfter: AsyncSeriesHook<[ToolResultHookContext]>;
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

export function createCorvexHooks(): CorvexHooks {
  const hooks: CorvexHooks = {
    serverBeforeListen: new AsyncSeriesHook([]),
    serverAfterListen: new AsyncSeriesHook(["address"]),
    serverBeforeClose: new AsyncSeriesHook([]),
    serverAfterClose: new AsyncSeriesHook([]),
    authResolveUser: new AsyncSeriesBailHook(["request"]),
    settingsApplied: new SyncHook(["config"]),
    eventBeforeProcess: new AsyncSeriesHook(["event"]),
    eventAfterProcess: new AsyncSeriesHook(["event"]),
    conversationBeforeTurn: new AsyncSeriesHook(["turn"]),
    conversationAfterTurn: new AsyncSeriesHook(["turn"]),
    conversationStart: new AsyncSeriesBailHook(["input"]),
    conversationTitleRefine: new AsyncSeriesBailHook(["input"]),
    agentBeforeModel: new AsyncSeriesHook(["request"]),
    agentAfterModel: new AsyncSeriesHook(["request", "response"]),
    toolBefore: new AsyncSeriesHook(["context"]),
    toolAfter: new AsyncSeriesHook(["context"]),
  };
  // 默认实现：标题只来自用户消息，不做额外的模型调用。
  // 默认实现放在较低优先级的 stage，插件可以先行返回自定义标题。
  hooks.conversationStart.tap({ name: "user-request", stage: 100 }, (input) =>
    normalizeConversationTitle(stripConversationCommand(input.request), input.language),
  );
  return hooks;
}
