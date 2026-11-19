import type { CorvexConfig } from "../config/config.js";
import { errorMessage } from "../errors.js";
import { conversationCapabilities } from "../events/model.js";
import type { ConversationStreamEvent, ConversationTurnContext } from "../events/model.js";
import type { EventStore } from "../events/store.js";
import { traceExecutionStep } from "../events/execution.js";
import { GitManager } from "../git/manager.js";
import type { Workspace } from "../git/types.js";
import { GitLabClient } from "../gitlab/client.js";
import { PiAgent, type EventTraceContext } from "../agent/pi.js";
import { buildConversationPrompt, chunkForSummary, estimateConservativeTokens, resolveHistoryBudgetTokens, trimHistory } from "../agent/budget.js";
import { getConversationSystemPrompt, getConversationTitleSystemPrompt, getSummarySystemPrompt } from "../agent/prompts.js";

/** 常驻对话工作区的空闲存活时间，超时后由 Runner 或 storage cleanup 回收。 */
const conversationWorkspaceTtlMs = 60 * 60_000;
/** 常驻对话工作区的数量上限，超出时按最近最少使用淘汰。 */
const maxCachedConversationWorkspaces = 8;

interface CachedConversationWorkspace {
  workspace: Workspace;
  lastUsedAt: number;
}

interface RunningTurn {
  controller: AbortController;
  conversationId: string;
}

/**
 * 在 Server 进程内联执行对话轮次：不走 Worker 队列、不占用事件租约，也从不向
 * GitLab 发布内容。每次执行都重新校验分支快照，过期即以 `stale` 结束。
 * 后续如需隔离执行环境，可把这里的模型调用替换为容器调用，其余流程不变。
 *
 * 每个对话常驻一个只读 worktree 并跨轮次复用：同一快照的追问只做一次
 * `rev-parse` 校验，不再重复 checkout 整棵工作树再删除。对话是只读的，
 * 且同一对话的轮次串行执行，因此复用在授权与并发上都安全。
 */
export class ConversationRunner {
  private readonly repo: GitManager;
  private readonly agent: PiAgent;
  private readonly running = new Map<string, RunningTurn>();
  private readonly workspaces = new Map<string, CachedConversationWorkspace>();
  /** 每轮对话的流式订阅者；轮次结束后立即清理，避免连接与内存泄漏。 */
  private readonly streamListeners = new Map<string, Set<(event: ConversationStreamEvent) => void>>();
  /** 最近一条正文快照：界面晚于轮次启动才建连时先补发，避免丢掉开头内容。 */
  private readonly streamSnapshots = new Map<string, ConversationStreamEvent>();

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    private readonly gitlab: GitLabClient,
  ) {
    this.repo = new GitManager(
      config.storage.root,
      config.gitlab.baseUrl,
      config.gitlab.readToken,
      config.gitlab.writeToken,
    );
    this.agent = new PiAgent(config, store, this.repo);
  }

  /** 领取并执行一轮对话；轮次已被领取或不存在时返回 false。 */
  async runTurn(turnId: string, signal: AbortSignal): Promise<boolean> {
    const turn = this.store.claimConversationTurn(turnId);
    if (!turn) return false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.running.set(turnId, { controller, conversationId: turn.conversationId });
    try {
      await this.execute(turn, controller.signal);
    } finally {
      this.running.delete(turnId);
      signal.removeEventListener("abort", abort);
      // 兜底：正常路径已在落库后推送 done；提前 return 的分支（快照过期）由这里收尾。
      try {
        const status = this.store.getConversationTurn(turn.conversationId, turnId)?.status;
        if (status) this.publishStream(turnId, { type: "done", status });
      } catch (error) {
        console.warn("conversation stream completion could not be resolved", {
          turnId,
          error: errorMessage(error),
        });
      }
      await this.releaseIdleWorkspaces();
    }
    return true;
  }

  /** 请求取消正在执行的轮次；轮次不在运行时忽略。 */
  cancelTurn(turnId: string): boolean {
    const running = this.running.get(turnId);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  /** 是否正在执行该轮次，用于界面提示「执行中」。 */
  isRunning(turnId: string): boolean {
    return this.running.has(turnId);
  }

  /**
   * 订阅一轮对话的流式输出，返回取消订阅函数。
   *
   * 订阅时补发最近一条正文快照：轮次通常由 POST 触发、界面随后才建立连接，
   * 直接只转发之后的增量会丢掉开头几段。快照是累计正文而不是增量，重连后
   * 覆盖展示即可，不需要客户端拼接。
   */
  subscribeTurn(turnId: string, listener: (event: ConversationStreamEvent) => void): () => void {
    const listeners = this.streamListeners.get(turnId) ?? new Set<(event: ConversationStreamEvent) => void>();
    listeners.add(listener);
    this.streamListeners.set(turnId, listeners);
    const snapshot = this.streamSnapshots.get(turnId);
    if (snapshot) listener(snapshot);
    return () => {
      const current = this.streamListeners.get(turnId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.streamListeners.delete(turnId);
    };
  }

  /** 推送流式事件；订阅者的异常不能影响轮次执行。 */
  private publishStream(turnId: string, event: ConversationStreamEvent): void {
    if (event.type === "text") {
      this.streamSnapshots.set(turnId, event);
    } else {
      this.streamSnapshots.delete(turnId);
    }
    for (const listener of [...(this.streamListeners.get(turnId) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        console.warn("conversation stream listener failed", { turnId, error: errorMessage(error) });
      }
    }
    if (event.type === "done") this.streamListeners.delete(turnId);
  }

  /**
   * 关闭 Server 时删除所有常驻对话工作区：先等待在途轮次收敛（取消信号已发出），
   * 再统一回收，避免删掉仍在使用的目录。
   */
  async releaseAll(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const cached = [...this.workspaces.values()];
    this.workspaces.clear();
    for (const entry of cached) {
      try {
        await this.repo.removeConversationWorkspace(entry.workspace);
      } catch (error) {
        console.warn("release conversation workspace failed", {
          conversationId: entry.workspace.eventId,
          error: errorMessage(error),
        });
      }
    }
  }

  /** 定期回收空闲超时的常驻工作区，由 Server 的保留任务调用。 */
  async releaseIdleWorkspaces(now = Date.now()): Promise<void> {
    const stale = [...this.workspaces.entries()].filter(
      ([conversationId, entry]) => !this.hasActiveTurn(conversationId) && now - entry.lastUsedAt >= conversationWorkspaceTtlMs,
    );
    for (const [conversationId, entry] of stale) {
      this.workspaces.delete(conversationId);
      try {
        await this.repo.removeConversationWorkspace(entry.workspace);
      } catch (error) {
        console.warn("evict idle conversation workspace failed", {
          conversationId,
          error: errorMessage(error),
        });
      }
    }
    while (this.workspaces.size > maxCachedConversationWorkspaces) {
      const candidate = [...this.workspaces.entries()]
        .filter(([conversationId]) => !this.hasActiveTurn(conversationId))
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!candidate) break;
      this.workspaces.delete(candidate[0]);
      try {
        await this.repo.removeConversationWorkspace(candidate[1].workspace);
      } catch (error) {
        console.warn("evict least recently used conversation workspace failed", {
          conversationId: candidate[0],
          error: errorMessage(error),
        });
      }
    }
  }

  private hasActiveTurn(conversationId: string): boolean {
    for (const running of this.running.values()) {
      if (running.conversationId === conversationId) return true;
    }
    return false;
  }

  /**
   * 维护跨轮滚动摘要：把「上一份摘要 + 本轮被裁剪掉的历史」压缩成新摘要并持久化。
   *
   * 摘要本身也是模型请求，必须遵守同一个窗口预算，否则长对话的历史会越攒越多，
   * 一次摘要请求超窗后失败被吞掉、边界不再推进，早期上下文就永久丢失。这里按预算
   * 分块滚动摘要；任一环节失败都不保存，下一轮会从同一个边界重试。
   * 摘要失败不影响本轮结果——它只是优化，不能因为压缩出错就让已回答的轮次变失败。
   */
  private async updateSummary(
    turn: ConversationTurnContext,
    dropped: { id?: string; role: "user" | "assistant"; content: string }[],
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.config.agent.summaryEnabled || dropped.length === 0) return;
    if (!dropped.at(-1)?.id) return;
    // 分块预算：与对话历史预算同源，并给摘要的系统提示预留固定开销。
    const chunkBudget = Math.max(4_000, resolveHistoryBudgetTokens(this.config.agent, 4_000));
    try {
      let rolling = turn.summary;
      let summarizedMessageId: string | undefined;
      for (const chunk of chunkForSummary(turn.summary, dropped, chunkBudget)) {
        const transcript = [
          ...(rolling ? [{ role: "assistant" as const, content: `[Existing summary]\n${rolling}` }] : []),
          ...chunk.map((message) => ({ role: message.role, content: message.content })),
        ];
        const summary = await this.agent.generate(
          {
            taskType: "conversation",
            systemPrompt: getSummarySystemPrompt(this.config.agent.responseLanguage),
            userPrompt: JSON.stringify({ conversation: transcript }),
          },
          workspacePath,
          signal,
        );
        rolling = summary.content;
        summarizedMessageId = chunk.at(-1)?.id ?? summarizedMessageId;
      }
      if (rolling && summarizedMessageId) {
        this.store.saveConversationSummary(turn.conversationId, rolling, summarizedMessageId);
      }
    } catch (error) {
      console.warn("conversation summary update failed", {
        conversationId: turn.conversationId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * 为首轮对话生成标题：只根据用户的首条提问推断主题并持久化。
   * 标题失败不影响本轮结果——它只是列表展示的优化，不能让已回答的轮次变失败。
   */
  private async updateTitle(
    turn: ConversationTurnContext,
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (turn.history.length > 0 || turn.summary) return;
    try {
      const title = await this.agent.generate(
        {
          taskType: "conversation",
          systemPrompt: getConversationTitleSystemPrompt(this.config.agent.responseLanguage),
          userPrompt: turn.request,
        },
        workspacePath,
        signal,
      );
      this.store.saveConversationTitle(turn.conversationId, title.content);
    } catch (error) {
      console.warn("conversation title generation failed", {
        conversationId: turn.conversationId,
        error: errorMessage(error),
      });
    }
  }

  private async execute(turn: ConversationTurnContext, signal: AbortSignal): Promise<void> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(turn.headSha)) {
      this.store.failConversationTurn(turn.turnId, "stale", "The branch did not have a valid commit snapshot.");
      return;
    }
    const stepContext = { turnId: turn.turnId, attempt: turn.attempt };
    try {
      const branch = await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.get_conversation_branch",
        { projectId: turn.projectId, branch: turn.targetBranch },
        () => this.gitlab.getBranch(turn.projectId, turn.targetBranch, signal),
        (value) => ({ name: value.name, headSha: value.commit.id }),
      );
      if (branch.commit.id.toLowerCase() !== turn.headSha.toLowerCase()) {
        this.store.failConversationTurn(
          turn.turnId,
          "stale",
          "The branch changed after this turn was queued; send a new message to use the current snapshot.",
        );
        return;
      }
      const project = await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.get_conversation_project",
        { projectId: turn.projectId },
        () => this.gitlab.getProject(turn.projectId, signal),
        (value) => ({ id: value.id, httpUrlToRepo: value.http_url_to_repo }),
      );
      const workspace = await traceExecutionStep(
        this.store,
        stepContext,
        "git.prepare_conversation_workspace",
        { projectId: turn.projectId, conversationId: turn.conversationId, expectedHeadSha: turn.headSha },
        () => this.repo.prepareConversationWorkspace(
          turn.projectId,
          turn.conversationId,
          project.http_url_to_repo,
          turn.headSha,
        ),
        (value) => ({ projectId: value.projectId, conversationId: turn.conversationId, headSha: value.headSha }),
      );
      this.workspaces.set(turn.conversationId, { workspace, lastUsedAt: Date.now() });
      const trace: EventTraceContext = {
        scope: { kind: "conversation", turnId: turn.turnId },
        attempt: turn.attempt,
        taskType: "conversation",
        workspace,
      };
      const systemPrompt = getConversationSystemPrompt(this.config.agent.responseLanguage, turn.mode);
      const userPrompt = buildConversationPrompt({
        repository: {
          project: turn.projectName,
          branch: turn.targetBranch,
          headSha: turn.headSha,
        },
        summary: turn.summary,
        currentRequest: turn.request,
      });
      // 出站前按 token 预算裁剪历史：注入多少由预算决定，而不是由条数决定，
      // 否则 30 条 × 20K 字符的历史足以撑爆任何窗口。预算同时受
      // `agent.max_input_tokens` 约束，使这个配置真正限制单次请求的输入。
      const historyBudget = resolveHistoryBudgetTokens(
        this.config.agent,
        estimateConservativeTokens(systemPrompt) + estimateConservativeTokens(userPrompt),
      );
      const { messages: history, dropped } = trimHistory(turn.history, historyBudget);
      if (dropped.length > 0) {
        console.info("conversation history trimmed to fit the token budget", {
          turnId: turn.turnId,
          dropped: dropped.length,
          kept: history.length,
        });
      }
      const started = Date.now();
      let answer: Awaited<ReturnType<PiAgent["generate"]>>;
      try {
        answer = await traceExecutionStep(
          this.store,
          stepContext,
          conversationCapabilities(turn.mode).workflowStep,
          {
            projectId: turn.projectId,
            branch: turn.targetBranch,
            headSha: turn.headSha,
            requestCharacters: [...turn.request].length,
          },
          () => this.agent.generate(
            {
              taskType: "conversation",
              conversationMode: turn.mode,
              systemPrompt,
              userPrompt,
              history,
              // 正文在落库前先按增量推送给控制台；轮次完成后由 done 事件触发刷新。
              onTextDelta: (update) =>
                this.publishStream(turn.turnId, { type: "text", reset: update.reset, text: update.text }),
            },
            workspace.path,
            signal,
            trace,
          ),
          (value) => ({ model: value.model, usage: value.usage, textBytes: Buffer.byteLength(value.content) }),
        );
      } catch (error) {
        this.store.recordModelCall("conversation", "failure", Date.now() - started, 0, 0);
        throw error;
      }
      this.store.recordModelCall("conversation", "success", Date.now() - started, answer.usage.inputTokens, answer.usage.outputTokens);
      this.store.finishConversationTurn(turn.turnId, answer.content);
      // 正文已落库，立即结束流：标题与摘要生成还需额外模型调用，不应让界面继续等流。
      this.publishStream(turn.turnId, { type: "done", status: "completed" });
      await this.updateTitle(turn, workspace.path, signal);
      await this.updateSummary(turn, dropped, workspace.path, signal);
    } catch (error) {
      if (signal.aborted) {
        this.store.cancelConversationTurn(turn.turnId, "This turn was cancelled before it could finish.");
        this.publishStream(turn.turnId, { type: "done", status: "cancelled" });
      } else {
        console.error("conversation turn failed", { turnId: turn.turnId, error: errorMessage(error) });
        this.store.failConversationTurn(turn.turnId, "failed", `This turn failed: ${errorMessage(error)}`);
        this.publishStream(turn.turnId, {
          type: "done",
          status: "failed",
          error: errorMessage(error),
        });
      }
    }
  }
}
