import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AssistantMessageEvent, StreamOptions } from "@earendil-works/pi-ai";
import type { CorvexConfig } from "../config/config.js";
import type { JobTraceEntry, JobType } from "../jobs/model.js";
import type { JobStore } from "../jobs/store.js";
import { traceExecutionStep } from "../jobs/execution.js";
import type { Workspace } from "../git/types.js";
import type { GitManager } from "../git/manager.js";
import {
  GitLabWriteError,
  type GitLabWriteReceipt,
  type MergeRequestComment,
  type MergeRequestMetadataUpdate,
} from "../gitlab/client.js";
import { createReadOnlyFileExtension } from "./repo-read.js";
import { createGitHistoryExtension } from "./git-history.js";
import { createMergeRequestCommentsExtension } from "./mr-comments.js";
import { createMergeRequestMetadataExtension } from "./mr-update.js";
import { createGitWriteExtension } from "./git-write.js";
import { createWebReadExtension } from "./web-read.js";

/** 128K-token model window minus output and system/tool safety reserves. */
export const maxAgentPromptBytes = 96 << 10;
/** Keep initial workflow payload below the total prompt cap to reserve system prompt space. */
export const maxAgentUserPromptBytes = 80 << 10;

export interface ModelRequest {
  taskType: JobType;
  systemPrompt: string;
  userPrompt: string;
}

export function getAgentToolAccess(
  taskType: JobType,
  config: Pick<CorvexConfig["agent"], "webEnabled" | "mcpEnabled">,
): { webFetch: boolean; mcp: boolean; mrComments: boolean; mrMetadata: boolean; gitHistory: boolean; gitWrite: boolean } {
  return {
    webFetch: ["review", "explain", "chat"].includes(taskType) && config.webEnabled,
    mcp: taskType === "review" && config.mcpEnabled,
    mrComments: taskType === "chat",
    mrMetadata: taskType === "chat",
    gitHistory: taskType === "chat",
    gitWrite: taskType === "chat",
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

export interface JobTraceContext {
  jobId: string;
  attempt: number;
  taskType: JobType;
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
    private readonly store?: JobStore,
    private readonly git?: Pick<GitManager, "grep" | "getCommitLog" | "showCommit" | "getWorkspaceDiff">,
    private readonly readMergeRequestComments?: ReadMergeRequestComments,
    private readonly updateMergeRequestMetadata?: UpdateMergeRequestMetadata,
    private readonly gitWriter?: Pick<
      GitManager,
      "writeEnabled" | "getWorkspaceStatus" | "applyWorkspacePatch" | "commitWorkspace" | "pushWorkspace" | "revertWorkspaceCommit"
    >,
  ) {}

  getTraceEntries(jobId: string, attempt: number): JobTraceEntry[] {
    return this.store?.getJobTraceEntries(jobId, attempt) ?? [];
  }

  async generate(
    request: ModelRequest,
    workingDirectory: string,
    signal?: AbortSignal,
    trace?: JobTraceContext,
  ): Promise<ModelResponse> {
    if (!this.config.agent.enabled) throw new Error("Pi agent is disabled");
    if (!request.systemPrompt.trim() || !request.userPrompt.trim()) {
      throw new Error("system and user prompts are required");
    }
    const promptBytes = Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.userPrompt);
    if (promptBytes > maxAgentPromptBytes) {
      throw new Error(`agent prompt exceeds the conservative ${maxAgentPromptBytes}-byte request budget`);
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
      response = await this.runSession(request, workingDirectory, sessionSignal, trace);
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
      throw new Error(`Pi agent run failed: ${error instanceof Error ? error.message : String(error)}`, {
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
    trace?: JobTraceContext,
  ): Promise<ModelResponse> {
    const agentDir = resolve(join(this.config.storage.root, "pi-agent"));
    const repositoryRoot = await realpath(workingDirectory);
    const skillRoots = await Promise.all(this.config.agent.skillPaths.map((path) => realpath(resolve(path))));
    const allowedRoots = [repositoryRoot, ...skillRoots];
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const providerId = "corvex-openai-compatible";
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
          contextWindow: 128_000,
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
    const toolAccess = getAgentToolAccess(request.taskType, this.config.agent);
    const workspace = trace?.workspace;
    const mergeRequest = trace?.mergeRequest;

    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalSkillPaths: this.config.agent.skillPaths.map((path) => resolve(path)),
      extensionFactories: [
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
                    { jobId: trace.jobId, attempt: trace.attempt },
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
      sessionManager: SessionManager.inMemory(),
      noTools: "builtin",
    });
    const activeTools = new Map<string, { traceId: number; startedAt: number }>();
    let modelCallCount = 0;
    let currentRound = 0;
    const recordedContextEntryIds = new Set<string>();
    let hasRecordedContext = false;
    const unsubscribe = session.subscribe((event) => {
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
          `${event.message.provider}/${event.message.responseModel ?? event.message.model}`,
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
      if (signal?.aborted) throw new Error("Pi agent run was aborted");
      const content = session.getLastAssistantText()?.trim();
      if (!content) throw new Error("Pi returned an empty completion");
      const usage = session.getSessionStats().tokens;
      return {
        content,
        model: `${model.provider}/${model.id}`,
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
          error instanceof Error ? error.message : String(error),
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
    trace: JobTraceContext,
    step: string,
    input: unknown,
    operation: () => Promise<T>,
    output: (value: T) => unknown,
    failureStatus: (error: unknown) => "failed" | "unknown" = () => "failed",
  ): Promise<T> {
    if (!this.store) return operation();
    return traceExecutionStep(
      this.store,
      { jobId: trace.jobId, attempt: trace.attempt },
      step,
      input,
      operation,
      output,
      failureStatus,
    );
  }

  private startTrace(
    trace: JobTraceContext,
    kind: "tool" | "llm",
    name: string,
    model = "",
    rawContent: string | null = null,
    details: { round?: number; input?: string | null; schema?: string | null } = {},
  ): number | undefined {
    if (!this.store) return undefined;
    try {
      return this.store.startJobTrace(
        trace.jobId,
        trace.attempt,
        kind,
        name.slice(0, 128),
        model.slice(0, 256),
        rawContent,
        details,
      );
    } catch (error) {
      console.warn("record job trajectory start failed", {
        jobId: trace.jobId,
        kind,
        name: name.slice(0, 128),
        error: error instanceof Error ? error.message : String(error),
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
      this.store.finishJobTrace(
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
      console.warn("record job trajectory completion failed", {
        traceId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
