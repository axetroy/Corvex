import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AssistantMessageEvent, AssistantMessage, StreamOptions, ThinkingContent, UserMessage } from "@earendil-works/pi-ai";
import type { CorvexConfig } from "../config/config.js";
import { errorMessage } from "../errors.js";
import type { ConversationMode, ConversationStreamContext, ConversationStreamTool, TraceEntry, TraceKind, ModelTaskType, TraceScope } from "../model.js";
import type { AppStore } from "../store.js";
import { callAsyncHook, type CorvexHooks } from "../app/hooks.js";

import type { Workspace } from "../git/types.js";
import type { GitManager } from "../git/manager.js";
import { estimateTokens, isContextOverflowError, nextOverflowRetryContextWindow } from "./budget.js";
import { resolveAdaptiveCompactionThreshold } from "./adaptive-compaction.js";
import { getAgentToolAccess } from "./tool-access.js";
import { createToolCatalogExtension } from "./tool-catalog.js";
import { redactSensitiveText } from "../redact.js";
import { readProjectGuidance } from "./project-guidance.js";
import { contextNoticeText, microcompactNoticeText, projectGuidanceNoticeText, responseWaitNoticeText } from "./context-notice.js";
import { createPlanExtension } from "./plan.js";
import { createFsWriteExtension, type WorkspaceFs } from "./fs/index.js";
import { createGitLabExtension } from "./gitlab/index.js";
import { createGitExtension, type GitToolAdapter } from "./git/index.js";
import type { GitLabClient } from "../gitlab/client.js";
import { buildContextSnapshot, createContextObserveExtension, messagesToText } from "./context-snapshot.js";
import { createProviderTokenCounter } from "./token-counter.js";
import { domainSummaryInstructions } from "./domain-summary.js";
import { createMicrocompactExtension, resolveMicrocompactPolicy } from "./microcompact.js";
import { estimateConservativeTokens } from "./budget.js";
import { createContextInspectExtension } from "./context-inspect.js";
import type { ContextSnapshot } from "./context-snapshot.js";
import { createFsReadExtension } from "./fs/index.js";
import { getToolBudgetWarningPrompt } from "./prompts.js";
import {
  createToolResultBudgetExtension,
  resolveCompactionKeepRecentTokens,
  resolveCompactionReserveTokens,
  resolveTurnToolResultBytes,
} from "./tool-budget.js";
import { createWebReadExtension } from "./web-read.js";
import { createWebDownloadExtension } from "./web-download.js";
import { createWebSearchExtension } from "./web-search.js";

export { getAgentToolAccess } from "./tool-access.js";

/** 128K-token 窗口下的保守请求字节下限；窗口更大时由 `resolveMaxPromptBytes` 放大。 */
export const maxAgentPromptBytes = 96 << 10;
/** 工具输出预算软阈值：达到后先让模型记录进展再继续，把整轮留在一个会话内完成。 */
const toolBudgetWarningRatio = 0.75;
/** Keep initial workflow payload below the total prompt cap to reserve system prompt space. */
export const maxAgentUserPromptBytes = 80 << 10;
/** 估算用的固定开销：system 提示、工具定义与消息框架。 */
const framingOverheadTokens = 2_000;

/**
 * 单次请求的输入字节上限：由上下文窗口推导，而不是固定 96 KiB。
 *
 * 长任务的历史与工具输出会持续增长；固定上限会让合法请求在出站前就被拒。这里按窗口
 * 推导字节预算（chars/4 估算），窗口越大允许的提示词越多，真正超限时仍由 SDK 压缩与
 * 服务端超限重试兜底。
 */
export function resolveMaxPromptBytes(
  config: Pick<CorvexConfig["agent"], "contextWindow" | "maxOutputTokens">,
): number {
  const inputTokens = config.contextWindow - config.maxOutputTokens - framingOverheadTokens;
  if (!Number.isFinite(inputTokens)) return maxAgentPromptBytes;
  return Math.max(maxAgentPromptBytes, Math.max(1_024, inputTokens) * 4);
}

/** 把配置的历史消息转换为 SDK 的会话条目，用于在 prompt 之前注入上下文。 */
function seedHistoryMessages(
  history: readonly { role: "user" | "assistant"; content: string }[],
  providerId: string,
  model: string,
): (UserMessage | AssistantMessage)[] {
  return history.map((message) => message.role === "user"
    ? {
        role: "user" as const,
        content: [{ type: "text" as const, text: message.content }],
        timestamp: Date.now(),
      }
    : {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: message.content }],
        api: "openai-completions" as const,
        provider: providerId,
        model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      });
}

export type SteerDisposition = "handled" | "queued" | "buffered" | "unavailable";

/**
 * 轮次内插话通道：会话句柄只在 runSession 内部存在，Runner 通过它把用户的补充
 * 消息送进当前会话，而不必直接接触 Pi SDK 的 session。
 */
export interface SteerChannel {
  /** 会话就绪后绑定投递函数；可重复绑定（上下文超限会在新会话里重试）。 */
  bind(steer: (text: string) => Promise<"handled" | "queued">): void;
  /** 投递一条插话；会话未就绪时缓冲，轮次已结束时返回 unavailable。 */
  send(text: string): Promise<SteerDisposition>;
  /** 轮次终结时关闭，丢弃尚未投递的缓冲。 */
  close(): void;
  /** 已投递的文本；上下文超限重试时重新注入新会话，避免补充丢失。 */
  delivered(): readonly string[];
}

/** 创建一个与模型会话生命周期解耦的插话通道。 */
export function createSteerChannel(): SteerChannel {
  let deliver: ((text: string) => Promise<"handled" | "queued">) | undefined;
  let closed = false;
  const buffered: string[] = [];
  const sent: string[] = [];
  const deliverText = (steer: (text: string) => Promise<"handled" | "queued">, text: string) => {
    sent.push(text);
    return steer(text);
  };
  return {
    bind(steer) {
      if (closed) return;
      deliver = steer;
      const pending = buffered.splice(0);
      for (const text of pending) {
        void deliverText(steer, text).catch((error: unknown) => {
          console.warn("buffered steer could not be delivered", { error: errorMessage(error) });
        });
      }
    },
    async send(text) {
      if (closed) return "unavailable";
      if (!deliver) {
        buffered.push(text);
        return "buffered";
      }
      try {
        const result = await deliver(text);
        sent.push(text);
        return result;
      } catch {
        return "unavailable";
      }
    },
    close() {
      closed = true;
      deliver = undefined;
      buffered.length = 0;
    },
    delivered() {
      return sent;
    },
  };
}

export interface ModelRequest {
  taskType: ModelTaskType;
  systemPrompt: string;
  userPrompt: string;
  /**
   * 对话历史，按时间升序。提供时按独立消息注入会话，让模型与 SDK 的压缩逻辑
   * 都能识别轮次边界；不提供时只发送 `userPrompt`。
   */
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * 对话轮次的模式；仅 `taskType === "conversation"` 时使用，用于派生工具能力。
   * 省略时按 `defaultConversationMode`（可读可写）处理。
   */
  conversationMode?: ConversationMode;
  /** 只发文本、不注册任何工具；用于标题等不应读取仓库的模型调用。 */
  noTools?: boolean;
  /** 对话的本地文件写入能力；由 Runner 限定到当前 worktree 后传入。 */
  fs?: WorkspaceFs;
  /** 当前登录用户的 GitLab 客户端；仅对话轮次提供，用于以该用户令牌访问 GitLab。 */
  gitlab?: GitLabClient;
  /**
   * 助手正文的流式回调。模型每开始一轮输出回调一次 `reset: true`，随后携带该轮
   * 已累计的正文；用累计值而不是增量，客户端漏事件后仍能自愈。仅对话轮次使用，
   * 其余任务省略即可。
   */
  onTextDelta?: (update: { reset: boolean; text: string }) => void;
  /**
   * 助手思考过程的流式回调，语义与 `onTextDelta` 相同：每轮开始先 `reset: true`，
   * 之后是该轮累计的思考文本。思考内容只用于展示，不落库、不参与输出校验；
   * 被服务端安全策略遮蔽的思考块不会推送。
   */
  onThinkingDelta?: (update: { reset: boolean; text: string }) => void;
  /**
   * 工具开始/结束的流式回调，用于把每次工具调用按发生顺序穿插在思考过程之间。
   * 参数沿用轨迹的脱敏与限长结果；与正文、思考一样只用于展示，不影响执行。
   */
  onToolDelta?: (tool: ConversationStreamTool) => void;
  /**
   * 上下文压缩/裁剪通知，用于对话控制台把变化以消息形式展示。
   * 同一 id 的后续事件替换前面的提示（例如「正在压缩」→「已压缩」）。
   */
  onContextDelta?: (context: ConversationStreamContext) => void;
  /** GitLab 协作模式下当前对话绑定的项目 ID；所有 GitLab 工具都固定到该项目。 */
  conversationProjectId?: number;
  /** 当前对话 ID；用于按对话平滑每轮 token 增长，动态调整压缩阈值。 */
  conversationId?: string;
  /** 当前对话轮次 ID；上下文快照按轮次归属。 */
  turnId?: string;
  /** 绑定当前会话 worktree 的 Git 工具集；只在对话轮次中提供。 */
  gitTools?: GitToolAdapter;
  /**
   * 轮次内插话通道；由 Runner 创建，PiAgent 在会话就绪后绑定。仅对话轮次提供，
   * 其余任务省略即可。
   */
  steer?: SteerChannel;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ModelResponse {
  content: string;
  model: string;
  usage: ModelUsage;
  /** 本轮若发生压缩，SDK 生成的摘要可直接作为下一轮的滚动摘要，避免重复摘要。 */
  compactionSummary?: string;
}

export interface TraceContext {
  scope: TraceScope;
  attempt: number;
  taskType: ModelTaskType;
  workspace?: Workspace;
}

/**
 * 取助手消息中已累计的正文。思考块与工具调用参数不算正文：控制台只把用户可见的
 * 回答逐字展示，工具调用另有「调用记录」呈现。
 */
function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 取助手消息中的思考文本；被安全过滤遮蔽的内容没有可读正文，直接跳过。 */
function assistantThinking(message: AssistantMessage): string {
  return message.content
    .filter((part): part is ThinkingContent => part.type === "thinking" && !part.redacted)
    .map((part) => part.thinking)
    .join("");
}

function hasGeneratedOutput(event: AssistantMessageEvent): boolean {
  if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
    return event.delta.length > 0;
  }
  if (event.type !== "text_start" && event.type !== "thinking_start" && event.type !== "toolcall_start") {
    return false;
  }
  const content = event.partial.content[event.contentIndex];
  if (content?.type === "text") return content.text.length > 0;
  if (content?.type === "thinking") return content.thinking.length > 0;
  if (content?.type === "toolCall") return content.name.length > 0 || Object.keys(content.arguments).length > 0;
  return false;
}

export class PiAgent {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store?: AppStore,
    private readonly git?: Pick<GitManager, "grep" | "getWorkspaceDiff">,
    private readonly gitlab?: GitLabClient,
    private readonly hooks?: CorvexHooks,
  ) {}

  /** 每个对话最近几轮的 token 增长样本，用于平滑自适应压缩阈值。 */
  private readonly growthByConversation = new Map<string, number[]>();

  getTraceEntries(scope: TraceScope, attempt: number): TraceEntry[] {
    return this.store?.getTraceEntries(scope, attempt) ?? [];
  }

  async generate(
    request: ModelRequest,
    workingDirectory: string,
    signal?: AbortSignal,
    trace?: TraceContext,
  ): Promise<ModelResponse> {
    if (this.hooks) await callAsyncHook(this.hooks.agentBeforeModel, request);
    if (!request.systemPrompt.trim() || !request.userPrompt.trim()) {
      throw new Error("system and user prompts are required");
    }
    const promptBytes = Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.userPrompt) +
      (request.history ?? []).reduce((sum, message) => sum + Buffer.byteLength(message.content), 0);
    const promptByteLimit = resolveMaxPromptBytes(this.config.agent);
    if (promptBytes > promptByteLimit) {
      throw new Error(`agent prompt exceeds the ${promptByteLimit}-byte request budget`);
    }
    // 以提示词字节数加最大输出量预留预算，避免并发请求突破每日上限。
    const reservedTokens = promptBytes + this.config.agent.maxOutputTokens;
    const budgetDay =
      this.config.agent.dailyTokenBudget > 0
        ? this.store?.reserveModelTokens(this.config.agent.dailyTokenBudget, reservedTokens)
        : undefined;
    if (this.config.agent.dailyTokenBudget > 0 && !this.store) {
      throw new Error("daily model token budget requires a persistent task store");
    }

    let response: ModelResponse;
    try {
      const sessionSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.config.agent.sessionTimeout)])
        : AbortSignal.timeout(this.config.agent.sessionTimeout);
      try {
        response = await this.runSession(request, workingDirectory, sessionSignal, trace);
      } catch (error) {
        // 本地预算估算总有误差（不同分词器差异很大）。服务端仍报超限时收缩一次
        // 输入重试：去掉全部历史，只保留当前请求。第二轮失败即放弃并如实上报。
        if (signal?.aborted || !isContextOverflowError(errorMessage(error))) throw error;
        // 自动调优只影响本次会话的有效窗口，不写回模型目录、不改全局配置：
        // 一次偶发的 provider 超限不应该永久缩小所有用户共享的模型设置。
        const nextWindow = nextOverflowRetryContextWindow(this.config.agent.contextWindow);
        const tuneEnabled = this.config.agent.autoContextTune !== false;
        const retryConfig = structuredClone(this.config);
        if (tuneEnabled && nextWindow < retryConfig.agent.contextWindow) {
          retryConfig.agent.contextWindow = nextWindow;
          if (retryConfig.agent.maxInputTokens >= nextWindow) retryConfig.agent.maxInputTokens = 0;
          if (retryConfig.agent.historyTokenBudget > nextWindow) retryConfig.agent.historyTokenBudget = nextWindow;
          console.warn("context window reduced for this session retry", {
            from: this.config.agent.contextWindow,
            to: nextWindow,
          });
        }
        try {
          request.onContextDelta?.({ id: `context-trim-${Date.now()}`, text: contextNoticeText(this.config.agent.responseLanguage, "trim") });
        } catch (error) {
          console.warn("context stream callback failed", { error: errorMessage(error) });
        }
        if (trace) {
          const trimBefore = buildContextSnapshot(request.history ?? [], undefined);
          const trimTrace = this.startTrace(trace, "context", "context.trim", "", null, {
            input: JSON.stringify({ reason: "overflow", nextWindow, before: trimBefore }),
          });
          if (trimTrace !== undefined) {
            this.finishTrace(trimTrace, "succeeded", 0, undefined, undefined, undefined,
              JSON.stringify({ nextWindow, after: { tokens: null, messages: [], summary: "" } }));
          }
        }
        // 重试会创建新会话；已投递的插话只存在于旧会话里，必须作为新会话的历史
        // 重新注入，否则用户的补充会在超限重试后静默丢失。
        const steered = request.steer?.delivered() ?? [];
        const retry: ModelRequest = request.history?.length || steered.length
          ? {
              ...request,
              // 原重试会丢掉全部历史；这里仍然丢掉，只保留用户在运行中的补充。
              history: steered.map((content) => ({ role: "user" as const, content })),
            }
          : request;
        console.warn("model request exceeded the context window; retrying without history", {
          taskType: request.taskType,
          historyMessages: request.history?.length ?? 0,
        });
        response = await this.runSession(retry, workingDirectory, sessionSignal, trace, retryConfig);
      }
    } catch (error) {
      if (budgetDay) {
        try {
          // 请求失败时用预留量结算，避免因无法确认服务端是否已计费而释放预算。
          this.store!.settleModelTokens(budgetDay, reservedTokens, reservedTokens);
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            "Pi request failed and daily model token budget settlement also failed",
            { cause: settlementError },
          );
        }
      }
      throw new Error(`Pi agent run failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (budgetDay) {
      try {
        this.store!.settleModelTokens(
          budgetDay,
          reservedTokens,
          response.usage.totalTokens > 0 ? response.usage.totalTokens : reservedTokens,
        );
      } catch (error) {
        throw new Error(`settle daily model token budget: ${String(error)}`, { cause: error });
      }
    }
    if (this.hooks) await callAsyncHook(this.hooks.agentAfterModel, request, response);
    return response;
  }

  private async runSession(
    request: ModelRequest,
    workingDirectory: string,
    parentSignal?: AbortSignal,
    trace?: TraceContext,
    config: CorvexConfig = this.config,
  ): Promise<ModelResponse> {
    // 无响应看门狗独立于上级信号：超时后中止当前会话，让轮次尽快以明确错误收尾，
    // 而不是在「运行中」状态下空等 SDK 多次重试。
    const stallController = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, stallController.signal])
      : stallController.signal;
    const agentDir = resolve(join(config.storage.root, "pi-agent"));
    const repositoryRoot = await realpath(workingDirectory);
    const skillRoots = await Promise.all(config.agent.skillPaths.map((path) => realpath(resolve(path))));
    const allowedRoots = [repositoryRoot, ...skillRoots];
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const providerId = "corvex-openai-compatible";
    // 内部 Provider ID 只用于注册 SDK Provider；展示给用户的名称来自控制台的供应商设置。
    const providerLabel = config.agent.providerName || providerId;
    const completionsApi = openAICompletionsApi();
    const requestTimeout = config.agent.requestTimeout;
    // Node 内置 fetch 的 headersTimeout 固定 300 秒，会让 agent_request_timeout 形同虚设。
    // 用同包 undici 的 fetch + Agent，让连接/响应头/响应体都遵循运行时配置的超时。
    const dispatcher = new UndiciAgent({
      connect: { timeout: Math.min(requestTimeout, 30_000) },
      headersTimeout: requestTimeout,
      bodyTimeout: requestTimeout,
    });
    const timedFetch: typeof globalThis.fetch = (input, init) =>
      undiciFetch(input as string | URL, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    // 任意模型活动（响应头、正文、思考、工具调用）都会重置看门狗计时。
    let lastActivityAt = performance.now();
    const markActivity = () => { lastActivityAt = performance.now(); };
    let activeModelCall: {
      traceId: number;
      startedAt: number;
      round: number;
      requestStartedAt?: string;
      requestStartedAtMono?: number;
      responseHeadersMs?: number;
      firstTokenAt?: number;
      firstTokenMs?: number;
    } | undefined;
    let pendingRequestTiming: {
      requestStartedAt: string;
      requestStartedAtMono: number;
      responseHeadersMs?: number;
    } | undefined;
    const requestOptions = (options: StreamOptions | undefined) => {
      const timeoutSignal = AbortSignal.timeout(requestTimeout);
      const requestStartedAtMono = performance.now();
      const requestStartedAt = new Date().toISOString();
      const requestTiming: {
        requestStartedAt: string;
        requestStartedAtMono: number;
        responseHeadersMs: number | undefined;
      } = { requestStartedAt, requestStartedAtMono, responseHeadersMs: undefined };
      pendingRequestTiming = requestTiming;
      return {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal,
        timeoutMs: requestTimeout,
        fetch: timedFetch,
        onResponse: async (response: Parameters<NonNullable<StreamOptions["onResponse"]>>[0], responseModel: Parameters<NonNullable<StreamOptions["onResponse"]>>[1]) => {
          markActivity();
          const responseHeadersMs = performance.now() - requestStartedAtMono;
          requestTiming.responseHeadersMs ??= responseHeadersMs;
          if (activeModelCall?.requestStartedAtMono === requestStartedAtMono) {
            activeModelCall.responseHeadersMs ??= responseHeadersMs;
          }
          await options?.onResponse?.(response, responseModel);
        },
      };
    };
    runtime.registerNativeProvider(createProvider({
      id: providerId,
      name: "Corvex OpenAI-compatible provider",
      baseUrl: config.agent.baseUrl.replace(/\/+$/, ""),
      auth: {
        apiKey: {
          name: "Corvex OpenAI-compatible API key",
          resolve: async () => ({ auth: { apiKey: config.agent.apiKey } }),
        },
      },
      models: [
        {
          id: config.agent.model,
          name: config.agent.model,
          api: "openai-completions",
          provider: providerId,
          baseUrl: config.agent.baseUrl.replace(/\/+$/, ""),
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: config.agent.contextWindow,
          maxTokens: config.agent.maxOutputTokens,
        },
      ],
      api: {
        "openai-completions": {
          stream: (model, context, options) =>
            completionsApi.stream(model, context, requestOptions(options)),
          streamSimple: (model, context, options) =>
            completionsApi.streamSimple(model, context, requestOptions(options)),
        },
      },
    }));
    const model = runtime.getModel(providerId, config.agent.model);
    if (!model) throw new Error("Pi could not resolve the configured model");
    const toolAccess = getAgentToolAccess(request.taskType, config.agent);
    const gitlab = request.gitlab ?? this.gitlab;
    const workspace = trace?.workspace;
    // 压缩阈值由工具结果预算推导：SDK 只能估算「最后一条回复之后新增的」工具结果，
    // 预留必须覆盖这段最坏增量加上输出预留，否则估算偏低的请求仍会超窗。
    const compactionReserveTokens = resolveCompactionReserveTokens(
      config.agent.contextWindow,
      config.agent.maxOutputTokens,
      config.agent.compactionReserveTokens,
    );
    const compactionKeepRecentTokens = resolveCompactionKeepRecentTokens(
      config.agent.contextWindow,
      config.agent.compactionKeepRecentTokens,
      compactionReserveTokens,
    );
    // SDK 自身的阈值放到接近窗口，只保留溢出压缩；主动压缩由下面的真实 token 计数在
    // 更早、可控的点触发，避免原始会话里的工具结果把 SDK 估算顶到 62.5% 就压缩。
    const sdkReserveTokens = Math.min(compactionReserveTokens, 1_024);
    const selfCompactRatio = Math.max(0.5, Math.min(0.95, (config.agent.compactionTriggerPercent ?? 85) / 100));
    const compactionHardCap = config.agent.contextWindow - config.agent.maxOutputTokens - 1_024;
    const selfCompactThreshold = Math.max(
      1_024,
      Math.min(
        Math.floor(config.agent.contextWindow * selfCompactRatio),
        compactionHardCap,
      ),
    );

    const emitContextStream = (context: ConversationStreamContext) => {
      if (!request.onContextDelta) return;
      try {
        request.onContextDelta(context);
      } catch (error) {
        console.warn("context stream callback failed", { error: errorMessage(error) });
      }
    };
    let contextEventCount = 0;
    let contextEventId = "";
    let activeCompactionTrigger: {
      reason?: string;
      tokens?: number;
      window: number;
      threshold: number;
    } | undefined;
    const tokenCounter = createProviderTokenCounter(config.agent.baseUrl);
    const contextObservation: { before?: ContextSnapshot; failures?: number } = {};
    // 项目指导每轮从固定 SHA 的 worktree 现读，不缓存；只注入一条最高优先级文件。
    const projectGuidance = await readProjectGuidance(repositoryRoot, {
      enabled: config.agent.projectAgentsMd,
      maxBytes: config.agent.projectAgentsMdMaxBytes,
      language: config.agent.responseLanguage,
    });
    if (projectGuidance.files.length > 0) {
      emitContextStream({
        id: `project-guidance-${request.conversationId ?? "turn"}`,
        text: projectGuidanceNoticeText(config.agent.responseLanguage, projectGuidance.bytes, projectGuidance.truncated),
      });
    }
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      // 不自动读取 agent 目录的 context 文件；项目指导完全由下面的 override 提供。
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: projectGuidance.files }),
      additionalSkillPaths: config.agent.skillPaths.map((path) => resolve(path)),
      extensionFactories: [
        // 把本轮真实注册的全部工具写进系统提示词：SDK 在自定义 systemPrompt 下不会
        // 自动生成 tools 段，模型只能看到函数 schema，无法在能力类提问中感知全部工具。
        createToolCatalogExtension(config.agent.responseLanguage),
        // 先于其它工具注册：在结果进入会话历史之前按窗口预算截断，避免单轮工具输出
        // 在 SDK 下一次压缩检查之前把窗口顶爆。
        createToolResultBudgetExtension(config.agent.contextWindow),
        createFsReadExtension(
          allowedRoots,
          workspace && this.git
            ? (query, path) => this.git!.grep(workspace, query, path, signal)
            : undefined,
          workspace && this.git
            ? (path) => this.git!.getWorkspaceDiff(workspace, path, signal)
            : undefined,
        ),
        ...(toolAccess.webFetch
          ? [
              createWebReadExtension(config.agent.webBlockedHosts, signal),
              // 下载仅在对话 worktree 可用时注册；与 web_fetch 共用 SSRF 防护与 DNS 固定。
              createWebDownloadExtension(workingDirectory, config.agent.webBlockedHosts, signal),
            ]
          : []),
        ...(toolAccess.webSearch
          ? [createWebSearchExtension(
              config.agent.webSearchMaxQueries,
              config.agent.webBlockedHosts,
              signal,
            )]
          : []),
        ...(request.taskType === "conversation" ? [createPlanExtension()] : []),
        ...(request.taskType === "conversation" && request.fs
          ? [createFsWriteExtension(request.fs)]
          : []),
        ...(request.taskType === "conversation" && request.gitTools
          ? [createGitExtension(request.gitTools)]
          : []),
        ...(request.conversationMode === "gitlab" && gitlab && request.conversationProjectId
          ? [createGitLabExtension({
              getProject: () => gitlab!.getProject(request.conversationProjectId!, signal),
              listIssues: (options) => gitlab!.listIssues(request.conversationProjectId!, options, signal),
              listMergeRequests: (options) => gitlab!.listMergeRequests(request.conversationProjectId!, options, signal),
              getIssue: (issueIid) => gitlab!.getIssue(request.conversationProjectId!, issueIid, signal),
              getMergeRequest: (mrIid) => gitlab!.getMergeRequest(request.conversationProjectId!, mrIid, signal),
              getMergeRequestChanges: (mrIid) => gitlab!.getMergeRequestChanges(request.conversationProjectId!, mrIid, signal),
              getIssueComments: (issueIid, limit) => gitlab!.getIssueComments(request.conversationProjectId!, issueIid, limit, signal),
              getMergeRequestComments: (mrIid, limit) => gitlab!.getMergeRequestComments(request.conversationProjectId!, mrIid, limit, signal),
              getMergeRequestCommits: (mrIid, page, perPage) => gitlab!.getMergeRequestCommits(request.conversationProjectId!, mrIid, page, perPage, signal),
              createIssue: (input) => gitlab!.createIssue(request.conversationProjectId!, input, signal),
              updateIssue: (issueIid, update) => gitlab!.updateIssue(request.conversationProjectId!, issueIid, update, signal),
              deleteIssue: (issueIid) => gitlab!.deleteIssue(request.conversationProjectId!, issueIid, signal),
              postIssueNote: (issueIid, noteBody) => gitlab!.postIssueNote(request.conversationProjectId!, issueIid, noteBody, signal),
              updateIssueNote: (issueIid, noteId, noteBody) => gitlab!.updateIssueNote(request.conversationProjectId!, issueIid, noteId, noteBody, signal),
              deleteIssueNote: (issueIid, noteId) => gitlab!.deleteIssueNote(request.conversationProjectId!, issueIid, noteId, signal),
              createMergeRequest: (input) => gitlab!.createMergeRequest(request.conversationProjectId!, input, signal),
              updateMergeRequest: (mrIid, update) => gitlab!.updateMergeRequest(request.conversationProjectId!, mrIid, update, signal),
              deleteMergeRequest: (mrIid) => gitlab!.deleteMergeRequest(request.conversationProjectId!, mrIid, signal),
              mergeMergeRequest: (mrIid, options) => gitlab!.mergeMergeRequest(request.conversationProjectId!, mrIid, options, signal),
              approveMergeRequest: (mrIid) => gitlab!.approveMergeRequest(request.conversationProjectId!, mrIid, signal),
              unapproveMergeRequest: (mrIid) => gitlab!.unapproveMergeRequest(request.conversationProjectId!, mrIid, signal),
              postMergeRequestNote: (mrIid, noteBody) => gitlab!.postNote(request.conversationProjectId!, mrIid, noteBody, signal),
              updateMergeRequestNote: (mrIid, noteId, noteBody) => gitlab!.updateMergeRequestNote(request.conversationProjectId!, mrIid, noteId, noteBody, signal),
              deleteMergeRequestNote: (mrIid, noteId) => gitlab!.deleteMergeRequestNote(request.conversationProjectId!, mrIid, noteId, signal),
              listMergeRequestDiscussions: (mrIid) => gitlab!.listMergeRequestDiscussions(request.conversationProjectId!, mrIid, signal),
              resolveDiscussion: (mrIid, discussionId, resolve) => gitlab!.resolveDiscussion(request.conversationProjectId!, mrIid, discussionId, resolve, signal),
            })]
          : []),
        createContextObserveExtension(contextObservation, {
          onBeforeCompact: (_snapshot, trigger) => {
            if (!contextEventId) contextEventId = `context-${++contextEventCount}`;
            const window = config.agent.contextWindow;
            const info = {
              reason: trigger.reason,
              tokens: trigger.tokens,
              window,
              threshold: activeCompactionTrigger?.threshold ?? selfCompactThreshold,
            };
            activeCompactionTrigger = info;
            emitContextStream({
              id: contextEventId,
              text: contextNoticeText(config.agent.responseLanguage, "start", info.tokens, undefined, info),
            });
          },
          onFailed: () => {
            if (!contextEventId) contextEventId = `context-${++contextEventCount}`;
            emitContextStream({
              id: contextEventId,
              text: contextNoticeText(config.agent.responseLanguage, "failed"),
            });
          },
        }, tokenCounter, async (event, snapshot, eventSignal) => {
          const { text, usage } = await generateSummaryWithUsage(
            event.preparation.messagesToSummarize as never,
            model,
            undefined,
            config.agent.apiKey,
            undefined,
            eventSignal,
            domainSummaryInstructions(config.agent.responseLanguage),
            event.preparation.previousSummary,
            undefined,
            (summaryModel, context, options) => runtime.streamSimple(summaryModel, context, options),
          );
          return {
            summary: text,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: snapshot.tokens ?? event.preparation.tokensBefore,
            estimatedTokensAfter: Math.ceil(text.length / 4),
            usage,
          };
        }),
        createMicrocompactExtension({
          ...resolveMicrocompactPolicy(config.agent.contextWindow, config.agent.compactionTriggerPercent),
          estimateTokens: (messages) => estimateConservativeTokens(messagesToText(messages)),
          onPruned: (pruned, savedChars, signature) => {
            this.store?.recordContextMetric("microcompact", pruned);
            this.store?.recordContextMetric("microcompact_chars", savedChars);
            emitContextStream({
              id: `microcompact-${signature}`,
              text: microcompactNoticeText(config.agent.responseLanguage, pruned, savedChars),
            });
          },
        }),
        // 上下文洞察通过 hook 接入：PiAgent 只产出有界快照，落库由默认 tap 完成。
        // 关闭时完全不注册扩展，避免每次请求多做一次 token 计数调用。
        ...(this.hooks && config.agent.contextInspectEnabled && request.conversationId && request.turnId
          ? [createContextInspectExtension({
              conversationId: request.conversationId,
              turnId: request.turnId,
              contextWindow: config.agent.contextWindow,
              reservedOutput: config.agent.maxOutputTokens,
              threshold: activeCompactionTrigger?.threshold ?? selfCompactThreshold,
              tokenCounter,
              signal,
              maxItems: config.agent.contextInspectMaxItems,
              maxPreviewChars: config.agent.contextInspectMaxPreviewChars,
              onSnapshot: (snapshot) => {
                void callAsyncHook(this.hooks!.contextSnapshot, snapshot).catch((error: unknown) => {
                  console.warn("context snapshot hook failed", { error: errorMessage(error) });
                });
              },
            })]
          : []),
      ],
      systemPrompt: request.systemPrompt,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      modelRuntime: runtime,
      model,
      resourceLoader,
      // 压缩阈值与配置的上下文窗口绑定：SDK 默认值按 200K 窗口调过，直接沿用
      // 会让 128K 窗口在压缩前就已超限。这里用内存设置管理器覆盖，不落盘。
      settingsManager: SettingsManager.inMemory({
        compaction: {
          enabled: true,
          reserveTokens: sdkReserveTokens,
          keepRecentTokens: compactionKeepRecentTokens,
        },
      }),
      sessionManager: SessionManager.inMemory(),
      noTools: request.noTools ? "all" : "builtin",
    });
    // 插话在会话就绪后才可投递：一次边界把积压的补充消息一起交给模型，避免
    // 逐条拆散到多次模型调用里，让用户误以为补充只被看见一半。
    if (request.steer) {
      session.setSteeringMode("all");
      request.steer.bind((text) => session.steer(text));
    }
    // 历史以独立消息注入：模型看到的是真实轮次，而不是一条巨型 user 消息，
    // SDK 的压缩切点也才能在正确的轮次边界上工作。
    for (const message of seedHistoryMessages(request.history ?? [], providerId, config.agent.model)) {
      session.sessionManager.appendMessage(message);
    }
    // 动态阈值需要本轮的真实增量：先记录历史注入后的 token 基线，回合结束时用
    // 「最终 token − 基线」衡量本轮增长。只记录文本/思考，与结束时的计数口径一致。
    let baselineTokens: number | undefined;
    if (config.agent.compactionDynamicThreshold) {
      const baselineText = messagesToText((session.sessionManager as unknown as {
        buildSessionProjection(): { messages: unknown[] };
      }).buildSessionProjection().messages);
      const countedBaseline = await tokenCounter.count(baselineText, signal);
      this.store?.recordContextMetric(countedBaseline === undefined ? "token_count_fallback" : "token_count_real", 1);
      baselineTokens = countedBaseline ?? estimateTokens(baselineText);
    }
    const activeTools = new Map<string, { traceId: number; startedAt: number }>();
    let modelCallCount = 0;
    let currentRound = 0;
    // 单轮内工具结果累计字节：仅作为软提醒阈值，不再中止本轮。阈值收敛到
    // 「四个单轮工具预算」，让提醒在压缩发生前就能到达模型。
    const toolResultByteLimit = resolveTurnToolResultBytes(
      config.agent.contextWindow,
      config.agent.turnToolResultBytes,
    );
    let toolResultBytes = 0;
    let toolBudgetWarningSent = false;
    const recordedContextEntryIds = new Set<string>();
    let hasRecordedContext = false;
    // 最终助手消息的错误原因：`session.prompt()` 在服务端报错（如上下文超限）时仍会正常
    // 返回，若不记录就会把上一条历史回复当成本轮成功结果，超限重试也就永远不会触发。
    let lastAssistantError: string | undefined;
    let lastCompactionSummary: string | undefined;
    // 流式正文、思考与工具调用只做展示，不参与判定；回调异常不能影响模型执行。
    let streamedAssistantText = "";
    let streamedAssistantThinking = "";
    const streamToolInputs = new Map<string, string | null>();
    const emitStream = (
      callback: ((update: { reset: boolean; text: string }) => void) | undefined,
      label: string,
      reset: boolean,
      text: string,
    ) => {
      if (!callback) return;
      try {
        callback({ reset, text });
      } catch (error) {
        console.warn(`${label} stream callback failed`, { error: errorMessage(error) });
      }
    };
    const emitToolStream = (tool: ConversationStreamTool) => {
      if (!request.onToolDelta) return;
      try {
        request.onToolDelta(tool);
      } catch (error) {
        console.warn("tool stream callback failed", { error: errorMessage(error) });
      }
    };
    let activeCompaction: {
      streamId: string;
      traceId?: number;
      reason: string;
      startedAt: number;
      before?: ContextSnapshot;
    } | undefined;
    const unsubscribe = session.subscribe((event) => {
      // 只在真正产出内容时重置看门狗：失败响应与 SDK 重试不算「模型有输出」。
      if (event.type === "message_update" || event.type === "tool_execution_start" ||
          event.type === "tool_execution_end" || event.type === "compaction_start" ||
          event.type === "compaction_end") {
        markActivity();
      }
      if (event.type === "compaction_start") {
        const streamId = contextEventId || `context-${++contextEventCount}`;
        contextEventId = streamId;
        if (!activeCompactionTrigger) {
          emitContextStream({ id: streamId, text: contextNoticeText(config.agent.responseLanguage, "start") });
        }
        activeCompaction = {
          streamId,
          reason: event.reason,
          startedAt: performance.now(),
          before: contextObservation.before,
          traceId: trace
            ? this.startTrace(trace, "context", "context.compact", "", null, {
                input: JSON.stringify({
                  phase: "start",
                  reason: event.reason,
                  id: streamId,
                  trigger: activeCompactionTrigger ?? null,
                  before: contextObservation.before ?? null,
                }),
              })
            : undefined,
        };
        return;
      }
      if (event.type === "compaction_end") {
        const active = activeCompaction;
        activeCompaction = undefined;
        contextEventId = "";
        activeCompactionTrigger = undefined;
        const before = active?.before ?? contextObservation.before ?? null;
        contextObservation.before = undefined;
        const result = event.result;
        const language = config.agent.responseLanguage;
        const failed = event.aborted || !result;
        if (!failed && result) lastCompactionSummary = redactSensitiveText(result.summary);
        this.store?.recordContextMetric("compaction", 1);
        if (active?.reason === "threshold" || event.reason === "threshold") {
          this.store?.recordContextMetric("compaction_threshold", 1);
        } else if (active?.reason === "overflow" || event.reason === "overflow") {
          this.store?.recordContextMetric("compaction_overflow", 1);
        }
        emitContextStream({
          id: active?.streamId ?? `context-${++contextEventCount}`,
          text: failed
            ? contextNoticeText(language, "failed")
            : contextNoticeText(language, "end", result.tokensBefore, result.estimatedTokensAfter),
        });
        const details = JSON.stringify({
          phase: "end",
          reason: active?.reason ?? event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          trigger: active?.reason ? { reason: active.reason } : null,
          before,
          after: result
            ? {
                tokens: result.estimatedTokensAfter ?? null,
                summary: result.summary,
                firstKeptEntryId: result.firstKeptEntryId,
              }
            : null,
          ...(event.errorMessage ? { error: event.errorMessage } : {}),
        });
        const duration = active ? performance.now() - active.startedAt : 0;
        if (active?.traceId !== undefined) {
          this.finishTrace(active.traceId, failed ? "failed" : "succeeded", duration, undefined, undefined,
            failed ? event.errorMessage ?? "context compaction aborted" : undefined, details);
        } else if (trace) {
          const traceId = this.startTrace(trace, "context", "context.compact", "", null, { input: details });
          if (traceId !== undefined) this.finishTrace(traceId, failed ? "failed" : "succeeded", duration);
        }
        return;
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        streamedAssistantText = "";
        streamedAssistantThinking = "";
        emitStream(request.onTextDelta, "assistant text", true, "");
        emitStream(request.onThinkingDelta, "assistant thinking", true, "");
      } else if (event.type === "message_update" && event.message.role === "assistant") {
        // 同一条增量里同时带思考与正文时先推思考，保持流里「先思考、后回答」的顺序。
        const thinking = assistantThinking(event.message);
        if (thinking !== streamedAssistantThinking) {
          streamedAssistantThinking = thinking;
          emitStream(request.onThinkingDelta, "assistant thinking", false, thinking);
        }
        const text = assistantText(event.message);
        if (text !== streamedAssistantText) {
          streamedAssistantText = text;
          emitStream(request.onTextDelta, "assistant text", false, text);
        }
      }
      // 工具事件发生在两轮模型输出之间，先于轨迹落库推送，界面才能按
      // 「思考 → 工具 → 下一轮思考」的真实顺序逐条渲染。
      if (event.type === "tool_execution_start") {
        const input = JSON.stringify(event.args) ?? null;
        streamToolInputs.set(event.toolCallId, input);
        emitToolStream({
          id: event.toolCallId,
          name: event.toolName,
          input,
          status: "running",
          durationMs: null,
        });
      } else if (event.type === "tool_execution_end") {
        emitToolStream({
          id: event.toolCallId,
          name: event.toolName,
          input: streamToolInputs.get(event.toolCallId) ?? null,
          status: event.isError ? "failed" : "succeeded",
          durationMs: event.durationMs ?? null,
        });
        streamToolInputs.delete(event.toolCallId);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        lastAssistantError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
          ? event.message.errorMessage ?? `model request ${event.message.stopReason}`
          : undefined;
      }
      if (!trace) return;
      if (event.type === "message_start" && event.message.role === "assistant") {
        const round = ++currentRound;
        const startedAt = performance.now();
        const contextEntries = session.sessionManager.buildContextEntries();
        const currentContextEntryIds = new Set(contextEntries.map((entry) => entry.id));
        const contextReset = !hasRecordedContext ||
          [...recordedContextEntryIds].some((id) => !currentContextEntryIds.has(id));
        const newContextEntries = contextReset
          ? contextEntries
          : contextEntries.filter((entry) => !recordedContextEntryIds.has(entry.id));
        const traceId = this.startTrace(
          trace,
          "llm",
          trace.taskType,
          `${providerLabel}/${event.message.responseModel ?? event.message.model}`,
          modelCallCount === 0 ? JSON.stringify(request) : null,
          {
            round,
            input: JSON.stringify({
              contextMode: "delta",
              contextReset,
              ...(contextReset ? { systemPrompt: session.systemPrompt } : {}),
              messages: newContextEntries,
            }),
          },
        );
        modelCallCount++;
        if (traceId !== undefined) {
          const requestTiming = pendingRequestTiming;
          pendingRequestTiming = undefined;
          activeModelCall = { traceId, startedAt, round, ...requestTiming };
          recordedContextEntryIds.clear();
          for (const entry of contextEntries) recordedContextEntryIds.add(entry.id);
          hasRecordedContext = true;
        }
      } else if (event.type === "message_update" && event.message.role === "assistant") {
        if (activeModelCall && activeModelCall.firstTokenMs === undefined && hasGeneratedOutput(event.assistantMessageEvent)) {
          activeModelCall.firstTokenAt = performance.now();
          activeModelCall.firstTokenMs = activeModelCall.firstTokenAt -
            (activeModelCall.requestStartedAtMono ?? activeModelCall.startedAt);
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (!activeModelCall) return;
        const message = event.message;
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        const endedAt = performance.now();
        const durationMs = activeModelCall.requestStartedAtMono === undefined
          ? message.durationMs ?? endedAt - activeModelCall.startedAt
          : endedAt - activeModelCall.requestStartedAtMono;
        const generationDurationMs = activeModelCall.firstTokenAt === undefined
          ? undefined
          : Math.max(0, endedAt - activeModelCall.firstTokenAt);
        this.finishTrace(
          activeModelCall.traceId,
          failed ? "failed" : "succeeded",
          durationMs,
          message.usage.input,
          message.usage.output,
          failed ? message.errorMessage ?? `model request ${message.stopReason}` : undefined,
          JSON.stringify({
            content: message.content.filter((part) => part.type === "text" || part.type === "toolCall"),
            stopReason: message.stopReason,
          }),
          activeModelCall.firstTokenMs,
          generationDurationMs,
          activeModelCall.requestStartedAt,
          activeModelCall.responseHeadersMs,
        );
        activeModelCall = undefined;
      } else if (event.type === "tool_execution_start") {
        const traceId = this.startTrace(trace, "tool", event.toolName, "", JSON.stringify(event.args), {
          round: currentRound || undefined,
          input: JSON.stringify(event.args),
          schema: JSON.stringify(session.getToolDefinition(event.toolName)?.parameters ?? null),
        });
        if (traceId !== undefined) {
          activeTools.set(event.toolCallId, { traceId, startedAt: performance.now() });
        }
        if (this.hooks) {
          void callAsyncHook(this.hooks.toolBefore, {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: event.args,
            scope: trace?.scope,
            attempt: trace?.attempt,
          }).catch((error: unknown) => console.warn("tool before hook failed", { error: errorMessage(error) }));
        }
      } else if (event.type === "tool_execution_end") {
        const active = activeTools.get(event.toolCallId);
        if (!active) return;
        if (this.hooks) {
          void callAsyncHook(this.hooks.toolAfter, {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: streamToolInputs.get(event.toolCallId) ?? null,
            output: event.result,
            status: event.isError ? "failed" : "succeeded",
            durationMs: event.durationMs ?? performance.now() - active.startedAt,
            scope: trace?.scope,
            attempt: trace?.attempt,
          }).catch((error: unknown) => console.warn("tool after hook failed", { error: errorMessage(error) }));
        }
        this.finishTrace(
          active.traceId,
          event.isError ? "failed" : "succeeded",
          event.durationMs ?? performance.now() - active.startedAt,
          undefined,
          undefined,
          event.isError ? JSON.stringify(event.result, null, 2) : undefined,
          JSON.stringify(event.result),
        );
        activeTools.delete(event.toolCallId);
        if (toolResultByteLimit > 0) {
          toolResultBytes += Buffer.byteLength(JSON.stringify(event.result) ?? "");
          // 只做软提醒：达到阈值后提示模型优先收尾，但不中止本轮。真正的上下文增长
          // 由 SDK 压缩与服务端超限重试处理，长任务因此能在同一会话内完成。
          if (!toolBudgetWarningSent && toolResultBytes >= toolResultByteLimit * toolBudgetWarningRatio) {
            toolBudgetWarningSent = true;
            void session.steer(getToolBudgetWarningPrompt(
              config.agent.responseLanguage,
              toolResultBytes,
              toolResultByteLimit,
            )).catch((error) => {
              console.warn("tool budget warning could not be delivered", { error: errorMessage(error) });
            });
          }
        }
      }
    });
    const abort = () => {
      void session.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // 无响应看门狗：等待首响应期间定期推送进度提示，超过阈值直接中止本轮。
    const stallMs = config.agent.responseStallTimeout;
    const stallSeconds = Math.round(stallMs / 1000);
    const waitingId = `waiting-${request.conversationId ?? "turn"}`;
    let lastNoticeSecond = 0;
    const stallTimer = stallMs > 0
      ? setInterval(() => {
          const idleMs = performance.now() - lastActivityAt;
          if (idleMs >= stallMs) {
            stallController.abort(new Error(config.agent.responseLanguage === "zh-CN"
              ? `模型超过 ${stallSeconds} 秒无输出，已中止本轮`
              : `No model output for ${stallSeconds}s; the turn was aborted`));
            return;
          }
          const idleSeconds = Math.floor(idleMs / 1000);
          if (idleSeconds >= 5 && idleSeconds - lastNoticeSecond >= 10) {
            lastNoticeSecond = idleSeconds;
            emitContextStream({
              id: waitingId,
              text: responseWaitNoticeText(config.agent.responseLanguage, idleSeconds, stallSeconds),
            });
          }
        }, 1_000)
      : undefined;
    try {
      await session.bindExtensions({});
      if (signal?.aborted) throw new Error(
        signal.reason instanceof Error ? signal.reason.message : "Pi agent run was aborted",
      );
      await session.prompt(request.userPrompt);
      // 外部取消优先：中止后的半截文本不能当作完成结果。
      if (signal?.aborted) throw new Error(
        signal.reason instanceof Error ? signal.reason.message : "Pi agent run was aborted",
      );
      // 服务端报错（含上下文超限）时 `prompt()` 不抛出，必须显式上抛，否则会返回历史回复
      // 并让上层的「去掉历史重试一次」失效。
      if (lastAssistantError) throw new Error(lastAssistantError);
      const content = session.getLastAssistantText()?.trim();
      if (!content) throw new Error("Pi returned an empty completion");
      const usage = session.getSessionStats().tokens;
      // 回合结束后按真实 token 数主动压缩，为下一轮留出空间；compact() 会先 abort，
      // 因此必须在 prompt() 完全结束之后调用，避免打断正在执行的轮次。
      try {
        const entries = (session.sessionManager as unknown as {
          buildSessionProjection(): { messages: unknown[] };
        }).buildSessionProjection().messages;
        const text = messagesToText(entries);
        const counted = await tokenCounter.count(text, signal);
        this.store?.recordContextMetric(counted === undefined ? "token_count_fallback" : "token_count_real", 1);
        const tokens = counted ?? estimateTokens(text);
        let effectiveThreshold = selfCompactThreshold;
        if (config.agent.compactionDynamicThreshold && baselineTokens !== undefined) {
          const growth = Math.max(0, tokens - baselineTokens);
          const key = request.conversationId;
          const previous = key ? this.growthByConversation.get(key) ?? [] : [];
          const adaptive = resolveAdaptiveCompactionThreshold({
            window: config.agent.contextWindow,
            baseThreshold: selfCompactThreshold,
            capThreshold: compactionHardCap,
            growth,
            previous,
          });
          effectiveThreshold = adaptive.threshold;
          if (key) this.growthByConversation.set(key, adaptive.samples);
        }
        if (tokens >= effectiveThreshold) {
          activeCompactionTrigger = {
            reason: "threshold",
            tokens,
            window: config.agent.contextWindow,
            threshold: effectiveThreshold,
          };
          const compaction = await session.compact();
          lastCompactionSummary = redactSensitiveText(compaction.summary);
          activeCompactionTrigger = undefined;
        }
      } catch (error) {
        activeCompactionTrigger = undefined;
        console.warn("self-triggered context compaction failed", { error: errorMessage(error) });
      }
      return {
        content,
        model: `${providerLabel}/${model.id}`,
        usage: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.total,
        },
        ...(lastCompactionSummary ? { compactionSummary: lastCompactionSummary } : {}),
      };
    } catch (error) {
      if (activeModelCall) {
        const endedAt = performance.now();
        const durationMs = endedAt - activeModelCall.startedAt;
        const generationDurationMs = activeModelCall.firstTokenAt === undefined
          ? undefined
          : Math.max(0, endedAt - activeModelCall.firstTokenAt);
        this.finishTrace(
          activeModelCall.traceId,
          "failed",
          durationMs,
          undefined,
          undefined,
          errorMessage(error),
          undefined,
          activeModelCall.firstTokenMs,
          generationDurationMs,
          activeModelCall.requestStartedAt,
          activeModelCall.responseHeadersMs,
        );
        activeModelCall = undefined;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (stallTimer) clearInterval(stallTimer);
      void dispatcher.close();
      if (activeModelCall) {
        const endedAt = performance.now();
        const durationMs = endedAt - activeModelCall.startedAt;
        const generationDurationMs = activeModelCall.firstTokenAt === undefined
          ? undefined
          : Math.max(0, endedAt - activeModelCall.firstTokenAt);
        this.finishTrace(
          activeModelCall.traceId,
          "failed",
          durationMs,
          undefined,
          undefined,
          "model request did not complete",
          undefined,
          activeModelCall.firstTokenMs,
          generationDurationMs,
          activeModelCall.requestStartedAt,
          activeModelCall.responseHeadersMs,
        );
      }
      for (const active of activeTools.values()) {
        this.finishTrace(active.traceId, "failed", performance.now() - active.startedAt);
      }
      session.dispose();
    }
  }

  private startTrace(
    trace: TraceContext,
    kind: TraceKind,
    name: string,
    model = "",
    rawContent: string | null = null,
    details: { round?: number; input?: string | null; schema?: string | null } = {},
  ): number | undefined {
    if (!this.store) return undefined;
    try {
      return this.store.startTrace(
        trace.scope,
        trace.attempt,
        kind,
        name.slice(0, 128),
        model.slice(0, 256),
        rawContent,
        details,
      );
    } catch (error) {
      console.warn("record event trajectory start failed", {
        scope: trace.scope,
        kind,
        name: name.slice(0, 128),
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  private finishTrace(
    traceId: number | undefined,
    status: "succeeded" | "failed",
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    errorDetail?: string,
    output?: string,
    firstTokenMs?: number,
    generationDurationMs?: number,
    requestStartedAt?: string,
    responseHeadersMs?: number,
  ): void {
    if (!this.store || traceId === undefined) return;
    try {
      this.store.finishTrace(
        traceId,
        status,
        durationMs,
        inputTokens,
        outputTokens,
        errorDetail,
        output,
        firstTokenMs,
        generationDurationMs,
        requestStartedAt,
        responseHeadersMs,
      );
    } catch (error) {
      console.warn("record event trajectory completion failed", {
        traceId,
        status,
        error: errorMessage(error),
      });
    }
  }
}
