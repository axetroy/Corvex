import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CorvexConfig } from "../config/config.js";
import type { JobType } from "../jobs/model.js";
import type { JobStore } from "../jobs/store.js";
import { createReadOnlyFileExtension } from "./repo-read.js";
import { createWebReadExtension } from "./web-read.js";

export interface ModelRequest {
  systemPrompt: string;
  userPrompt: string;
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
}

export class PiAgent {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store?: JobStore,
  ) {}

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
    // 以提示词字节数加最大输出量预留预算，避免并发请求突破每日上限。
    const reservedTokens =
      Buffer.byteLength(request.systemPrompt) +
      Buffer.byteLength(request.userPrompt) +
      this.config.agent.maxOutputTokens;
    const budgetDay =
      this.config.agent.dailyTokenBudget > 0
        ? this.store?.reserveModelTokens(this.config.agent.dailyTokenBudget, reservedTokens)
        : undefined;
    if (this.config.agent.dailyTokenBudget > 0 && !this.store) {
      throw new Error("daily model token budget requires a persistent task store");
    }

    let response: ModelResponse;
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.config.agent.requestTimeout)])
        : AbortSignal.timeout(this.config.agent.requestTimeout);
      response = await this.runSession(request, workingDirectory, requestSignal, trace);
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
    runtime.registerProvider(providerId, {
      name: "Corvex OpenAI-compatible provider",
      api: "openai-completions",
      baseUrl: this.config.agent.baseUrl.replace(/\/+$/, ""),
      apiKey: this.config.agent.apiKey,
      models: [
        {
          id: this.config.agent.model,
          name: this.config.agent.model,
          api: "openai-completions",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: this.config.agent.maxOutputTokens,
        },
      ],
    });
    const model = runtime.getModel(providerId, this.config.agent.model);
    if (!model) throw new Error("Pi could not resolve the configured model");

    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      additionalSkillPaths: this.config.agent.skillPaths.map((path) => resolve(path)),
      extensionFactories: [
        createReadOnlyFileExtension(allowedRoots),
        ...(this.config.agent.webEnabled
          ? [createWebReadExtension(this.config.agent.webBlockedHosts, signal)]
          : []),
        ...(this.config.agent.mcpEnabled ? [createMcpExtension()] : []),
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
    let activeModelCall: { traceId: number; startedAt: number; round: number } | undefined;
    let modelCallCount = 0;
    let currentRound = 0;
    const unsubscribe = session.subscribe((event) => {
      if (!trace) return;
      if (event.type === "message_start" && event.message.role === "assistant") {
        const round = ++currentRound;
        const traceId = this.startTrace(
          trace,
          "llm",
          trace.taskType,
          `${event.message.provider}/${event.message.responseModel ?? event.message.model}`,
          modelCallCount === 0 ? JSON.stringify(request) : null,
          {
            round,
            input: JSON.stringify({
              systemPrompt: session.systemPrompt,
              messages: session.sessionManager.buildContextEntries(),
            }),
          },
        );
        modelCallCount++;
        if (traceId !== undefined) activeModelCall = { traceId, startedAt: performance.now(), round };
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (!activeModelCall) return;
        const message = event.message;
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        this.finishTrace(
          activeModelCall.traceId,
          failed ? "failed" : "succeeded",
          message.durationMs ?? performance.now() - activeModelCall.startedAt,
          message.usage.input,
          message.usage.output,
          failed ? message.errorMessage ?? `model request ${message.stopReason}` : undefined,
          JSON.stringify({
            content: message.content.filter((part) => part.type === "text" || part.type === "toolCall"),
            stopReason: message.stopReason,
          }),
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
        this.finishTrace(
          activeModelCall.traceId,
          "failed",
          performance.now() - activeModelCall.startedAt,
          undefined,
          undefined,
          error instanceof Error ? error.message : String(error),
        );
        activeModelCall = undefined;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (activeModelCall) {
        this.finishTrace(
          activeModelCall.traceId,
          "failed",
          performance.now() - activeModelCall.startedAt,
          undefined,
          undefined,
          "model request did not complete",
        );
      }
      for (const active of activeTools.values()) {
        this.finishTrace(active.traceId, "failed", performance.now() - active.startedAt);
      }
      session.dispose();
    }
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
  ): void {
    if (!this.store || traceId === undefined) return;
    try {
      this.store.finishJobTrace(traceId, status, durationMs, inputTokens, outputTokens, errorDetail, output);
    } catch (error) {
      console.warn("record job trajectory completion failed", {
        traceId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
