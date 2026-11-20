import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createAgentSession,
  createMcpExtension,
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
import { conversationCapabilities, defaultConversationMode } from "../events/model.js";
import type { ConversationMode, ConversationStreamTool, EventTraceEntry, ModelTaskType, TraceScope } from "../events/model.js";
import type { EventStore } from "../events/store.js";
import { stepContextFor, traceExecutionStep } from "../events/execution.js";
import type { Workspace } from "../git/types.js";
import type { GitManager } from "../git/manager.js";
import { isContextOverflowError } from "./budget.js";
import {
  GitLabWriteError,
  type GitLabWriteReceipt,
  type MergeRequestComment,
  type MergeRequestMetadataUpdate,
} from "../gitlab/client.js";
import { createReadOnlyFileExtension } from "./repo-read.js";
import { getToolBudgetWarningPrompt } from "./prompts.js";
import {
  createToolResultBudgetExtension,
  resolveCompactionKeepRecentTokens,
  resolveCompactionReserveTokens,
  resolveTurnToolResultBytes,
} from "./tool-budget.js";
import { createGitHistoryExtension } from "./git-history.js";
import { createMergeRequestCommentsExtension } from "./mr-comments.js";
import { createMergeRequestMetadataExtension } from "./mr-update.js";
import { createGitWriteExtension } from "./git-write.js";
import { createWebReadExtension } from "./web-read.js";

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
   * 省略时按 `defaultConversationMode`（只读）处理，保持既有只读行为。
   */
  conversationMode?: ConversationMode;
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
}

export function getAgentToolAccess(
  taskType: ModelTaskType,
  config: Pick<CorvexConfig["agent"], "webEnabled" | "mcpEnabled">,
  conversationMode: ConversationMode = defaultConversationMode,
): { webFetch: boolean; mcp: boolean; mrComments: boolean; mrMetadata: boolean; gitHistory: boolean; gitWrite: boolean } {
  return {
    webFetch: ["review", "explain", "chat", "conversation"].includes(taskType) && config.webEnabled,
    mcp: taskType === "review" && config.mcpEnabled,
    mrComments: taskType === "chat",
    mrMetadata: taskType === "chat",
    gitHistory: taskType === "chat" || taskType === "conversation",
    // 对话是否可写由模式决定：当前只有只读模式，`repositoryWrite` 恒为 false。
    // 新增可写模式时此处即生效，但仍需在 Runner 中接线写入工具所需的上下文。
    gitWrite: taskType === "chat" || (taskType === "conversation" && conversationCapabilities(conversationMode).repositoryWrite),
  };
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
}

export interface EventTraceContext {
  scope: TraceScope;
  attempt: number;
  taskType: ModelTaskType;
  workspace?: Workspace;
  mergeRequest?: {
    projectId: number;
    mrIid: number;
    sourceProjectId?: number;
    targetProjectId?: number;
    sourceBranch?: string;
    repositoryUrl?: string;
    expectedRemoteSha?: string;
    pushedSha?: string;
  };
  issue?: {
    projectId: number;
    issueIid: number;
    sourceBranch: string;
    targetBranch: string;
    repositoryUrl?: string;
    expectedTargetSha?: string;
  };
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

export type ReadMergeRequestComments = (
  projectId: number,
  mrIid: number,
  limit: number,
  signal?: AbortSignal,
) => Promise<MergeRequestComment[]>;

export type UpdateMergeRequestMetadata = (
  projectId: number,
  mrIid: number,
  update: MergeRequestMetadataUpdate,
  signal?: AbortSignal,
) => Promise<GitLabWriteReceipt>;

export class PiAgent {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store?: EventStore,
    private readonly git?: Pick<GitManager, "grep" | "getCommitLog" | "showCommit" | "getWorkspaceDiff">,
    private readonly readMergeRequestComments?: ReadMergeRequestComments,
    private readonly updateMergeRequestMetadata?: UpdateMergeRequestMetadata,
    private readonly gitWriter?: Pick<
      GitManager,
      "writeEnabled" | "getWorkspaceStatus" | "applyWorkspacePatch" | "commitWorkspace" | "pushWorkspace" | "revertWorkspaceCommit"
    >,
  ) {}

  getTraceEntries(scope: TraceScope, attempt: number): EventTraceEntry[] {
    return this.store?.getEventTraceEntries(scope, attempt) ?? [];
  }

  async generate(
    request: ModelRequest,
    workingDirectory: string,
    signal?: AbortSignal,
    trace?: EventTraceContext,
  ): Promise<ModelResponse> {
    if (!this.config.agent.enabled) throw new Error("Pi agent is disabled");
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
        const retry: ModelRequest = request.history?.length
          ? { ...request, history: [] }
          : request;
        console.warn("model request exceeded the context window; retrying without history", {
          taskType: request.taskType,
          historyMessages: request.history?.length ?? 0,
        });
        response = await this.runSession(retry, workingDirectory, sessionSignal, trace);
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
    return response;
  }

  private async runSession(
    request: ModelRequest,
    workingDirectory: string,
    signal?: AbortSignal,
    trace?: EventTraceContext,
  ): Promise<ModelResponse> {
    const agentDir = resolve(join(this.config.storage.root, "pi-agent"));
    const repositoryRoot = await realpath(workingDirectory);
    const skillRoots = await Promise.all(this.config.agent.skillPaths.map((path) => realpath(resolve(path))));
    const allowedRoots = [repositoryRoot, ...skillRoots];
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const providerId = "corvex-openai-compatible";
    // 内部 Provider ID 只用于注册 SDK Provider；展示给用户的名称来自控制台的供应商设置。
    const providerLabel = this.config.agent.providerName || providerId;
    const completionsApi = openAICompletionsApi();
    const requestTimeout = this.config.agent.requestTimeout;
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
        onResponse: async (response: Parameters<NonNullable<StreamOptions["onResponse"]>>[0], responseModel: Parameters<NonNullable<StreamOptions["onResponse"]>>[1]) => {
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
      baseUrl: this.config.agent.baseUrl.replace(/\/+$/, ""),
      auth: {
        apiKey: {
          name: "Corvex OpenAI-compatible API key",
          resolve: async () => ({ auth: { apiKey: this.config.agent.apiKey } }),
        },
      },
      models: [
        {
          id: this.config.agent.model,
          name: this.config.agent.model,
          api: "openai-completions",
          provider: providerId,
          baseUrl: this.config.agent.baseUrl.replace(/\/+$/, ""),
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: this.config.agent.contextWindow,
          maxTokens: this.config.agent.maxOutputTokens,
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
    const model = runtime.getModel(providerId, this.config.agent.model);
    if (!model) throw new Error("Pi could not resolve the configured model");
    const toolAccess = getAgentToolAccess(request.taskType, this.config.agent, request.conversationMode);
    const workspace = trace?.workspace;
    const mergeRequest = trace?.mergeRequest;
    // 压缩阈值由工具结果预算推导：SDK 只能估算「最后一条回复之后新增的」工具结果，
    // 预留必须覆盖这段最坏增量加上输出预留，否则估算偏低的请求仍会超窗。
    const compactionReserveTokens = resolveCompactionReserveTokens(
      this.config.agent.contextWindow,
      this.config.agent.maxOutputTokens,
      this.config.agent.compactionReserveTokens,
    );
    const compactionKeepRecentTokens = resolveCompactionKeepRecentTokens(
      this.config.agent.contextWindow,
      this.config.agent.compactionKeepRecentTokens,
      compactionReserveTokens,
    );

    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalSkillPaths: this.config.agent.skillPaths.map((path) => resolve(path)),
      extensionFactories: [
        // 先于其它工具注册：在结果进入会话历史之前按窗口预算截断，避免单轮工具输出
        // 在 SDK 下一次压缩检查之前把窗口顶爆。
        createToolResultBudgetExtension(this.config.agent.contextWindow),
        createReadOnlyFileExtension(
          allowedRoots,
          workspace && this.git
            ? (query, path) => this.git!.grep(workspace, query, path, signal)
            : undefined,
          workspace && this.git
            ? (path) => this.git!.getWorkspaceDiff(workspace, path, signal)
            : undefined,
        ),
        ...(toolAccess.webFetch
          ? [createWebReadExtension(this.config.agent.webBlockedHosts, signal)]
          : []),
        ...(toolAccess.gitHistory && trace?.workspace && this.git
          ? [createGitHistoryExtension(
              (limit, path) => this.git!.getCommitLog(trace.workspace!, limit, path, signal),
              (sha, path) => this.git!.showCommit(trace.workspace!, sha, path, signal),
            )]
          : []),
        ...(toolAccess.mrComments && trace?.mergeRequest && this.readMergeRequestComments
          ? [createMergeRequestCommentsExtension(
              (limit) => this.readMergeRequestComments!(
                trace.mergeRequest!.projectId,
                trace.mergeRequest!.mrIid,
                limit,
                signal,
              ),
              this.config.chat.historyComments,
            )]
          : []),
          ...(toolAccess.mrMetadata && trace?.mergeRequest && this.updateMergeRequestMetadata
            ? [createMergeRequestMetadataExtension(
                (update) => {
                  const operation = () => this.updateMergeRequestMetadata!(
                    trace.mergeRequest!.projectId,
                    trace.mergeRequest!.mrIid,
                    update,
                    signal,
                  );
                  if (!this.store) return operation();
                  return traceExecutionStep(
                    this.store,
                    stepContextFor(trace.scope, trace.attempt),
                    "gitlab.update_merge_request_metadata",
                    {
                      projectId: trace.mergeRequest!.projectId,
                      mrIid: trace.mergeRequest!.mrIid,
                      fields: Object.keys(update),
                      titleCharacters: update.title === undefined ? 0 : [...update.title].length,
                      descriptionCharacters: update.description === undefined ? 0 : [...update.description].length,
                    },
                    operation,
                    (receipt) => receipt,
                    (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
                  );
                },
              )]
            : []),
        ...(toolAccess.gitWrite &&
          workspace &&
          mergeRequest &&
          mergeRequest.sourceProjectId === mergeRequest.projectId &&
          mergeRequest.targetProjectId === mergeRequest.projectId &&
          mergeRequest.sourceBranch &&
          mergeRequest.repositoryUrl &&
          this.gitWriter?.writeEnabled
          ? [createGitWriteExtension({
              status: () => this.runGitWrite(
                trace!, "git.status", {}, () => this.gitWriter!.getWorkspaceStatus(workspace, signal),
                (value) => ({ headSha: value.headSha, clean: value.clean, files: value.files }),
              ),
              applyPatch: (patch) => this.runGitWrite(
                trace!, "git.apply_patch",
                { patchBytes: Buffer.byteLength(patch), patchSha256: createHash("sha256").update(patch).digest("hex") },
                () => this.gitWriter!.applyWorkspacePatch(workspace, patch, signal),
                (value) => ({ changedFiles: value.changedFiles, patchBytes: Buffer.byteLength(value.patch) }),
              ),
              commit: (message) => this.runGitWrite(
                trace!, "git.commit", { messageCharacters: [...message].length },
                () => this.gitWriter!.commitWorkspace(workspace, message, signal),
                (value) => ({ sha: value.sha, changedFiles: value.changedFiles }),
              ),
              push: async () => {
                const result = await this.runGitWrite(
                  trace!, "git.push",
                  { projectId: mergeRequest.projectId, branch: mergeRequest.sourceBranch },
                  () => this.gitWriter!.pushWorkspace(
                    workspace,
                    mergeRequest.sourceBranch!,
                    mergeRequest.repositoryUrl!,
                    signal,
                    mergeRequest.expectedRemoteSha ?? workspace.headSha,
                  ),
                  (value) => value,
                  (error) => error instanceof Error && "outcomeUnknown" in error ? "unknown" : "failed",
                );
                mergeRequest.expectedRemoteSha = result.sha;
                mergeRequest.pushedSha = result.sha;
                return result;
              },
              revert: (sha) => this.runGitWrite(
                trace!, "git.revert", { sha },
                () => this.gitWriter!.revertWorkspaceCommit(workspace, sha, signal),
                (value) => value,
              ),
            })]
          : []),
        ...(toolAccess.mcp ? [createMcpExtension()] : []),
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
          reserveTokens: compactionReserveTokens,
          keepRecentTokens: compactionKeepRecentTokens,
        },
      }),
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
    });
    // 历史以独立消息注入：模型看到的是真实轮次，而不是一条巨型 user 消息，
    // SDK 的压缩切点也才能在正确的轮次边界上工作。
    for (const message of seedHistoryMessages(request.history ?? [], providerId, this.config.agent.model)) {
      session.sessionManager.appendMessage(message);
    }
    const activeTools = new Map<string, { traceId: number; startedAt: number }>();
    let modelCallCount = 0;
    let currentRound = 0;
    // 单轮内工具结果累计字节：仅作为软提醒阈值，不再中止本轮。阈值收敛到
    // 「四个单轮工具预算」，让提醒在压缩发生前就能到达模型。
    const toolResultByteLimit = resolveTurnToolResultBytes(
      this.config.agent.contextWindow,
      this.config.agent.turnToolResultBytes,
    );
    let toolResultBytes = 0;
    let toolBudgetWarningSent = false;
    const recordedContextEntryIds = new Set<string>();
    let hasRecordedContext = false;
    // 最终助手消息的错误原因：`session.prompt()` 在服务端报错（如上下文超限）时仍会正常
    // 返回，若不记录就会把上一条历史回复当成本轮成功结果，超限重试也就永远不会触发。
    let lastAssistantError: string | undefined;
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
    const unsubscribe = session.subscribe((event) => {
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
      } else if (event.type === "tool_execution_end") {
        const active = activeTools.get(event.toolCallId);
        if (!active) return;
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
              this.config.agent.responseLanguage,
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
    try {
      await session.bindExtensions({});
      if (signal?.aborted) throw new Error("Pi agent run was aborted");
      await session.prompt(request.userPrompt);
      // 外部取消优先：中止后的半截文本不能当作完成结果。
      if (signal?.aborted) throw new Error("Pi agent run was aborted");
      // 服务端报错（含上下文超限）时 `prompt()` 不抛出，必须显式上抛，否则会返回历史回复
      // 并让上层的「去掉历史重试一次」失效。
      if (lastAssistantError) throw new Error(lastAssistantError);
      const content = session.getLastAssistantText()?.trim();
      if (!content) throw new Error("Pi returned an empty completion");
      const usage = session.getSessionStats().tokens;
      return {
        content,
        model: `${providerLabel}/${model.id}`,
        usage: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.total,
        },
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

  private runGitWrite<T>(
    trace: EventTraceContext,
    step: string,
    input: unknown,
    operation: () => Promise<T>,
    output: (value: T) => unknown,
    failureStatus: (error: unknown) => "failed" | "unknown" = () => "failed",
  ): Promise<T> {
    if (!this.store) return operation();
    return traceExecutionStep(
      this.store,
      stepContextFor(trace.scope, trace.attempt),
      step,
      input,
      operation,
      output,
      failureStatus,
    );
  }

  private startTrace(
    trace: EventTraceContext,
    kind: "tool" | "llm",
    name: string,
    model = "",
    rawContent: string | null = null,
    details: { round?: number; input?: string | null; schema?: string | null } = {},
  ): number | undefined {
    if (!this.store) return undefined;
    try {
      return this.store.startEventTrace(
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
      this.store.finishEventTrace(
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
