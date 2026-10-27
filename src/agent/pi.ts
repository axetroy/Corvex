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
import type { JobStore } from "../jobs/store.js";
import { createReadOnlyFileExtension } from "./repo-read.js";

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

export class PiAgent {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store?: JobStore,
  ) {}

  async generate(
    request: ModelRequest,
    workingDirectory: string,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (!this.config.agent.enabled) throw new Error("Pi agent is disabled");
    if (!request.systemPrompt.trim() || !request.userPrompt.trim()) {
      throw new Error("system and user prompts are required");
    }
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
      response = await this.runSession(request, workingDirectory, requestSignal);
    } catch (error) {
      if (budgetDay) {
        try {
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
    } finally {
      signal?.removeEventListener("abort", abort);
      session.dispose();
    }
  }
}
