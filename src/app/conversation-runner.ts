import type { CorvexConfig } from "../config/config.js";
import { errorMessage } from "../errors.js";
import { conversationCapabilities } from "../events/model.js";
import type { ConversationTurnContext } from "../events/model.js";
import type { EventStore } from "../events/store.js";
import { traceExecutionStep } from "../events/execution.js";
import { GitManager } from "../git/manager.js";
import type { Workspace } from "../git/types.js";
import { GitLabClient } from "../gitlab/client.js";
import { PiAgent, type EventTraceContext } from "../agent/pi.js";
import { buildConversationPrompt, trimHistory } from "../agent/budget.js";
import { getConversationSystemPrompt, getSummarySystemPrompt } from "../agent/prompts.js";

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
   * 摘要失败不影响本轮结果——它只是优化，不能因为压缩出错就让已回答的轮次变失败。
   */
  private async updateSummary(
    turn: ConversationTurnContext,
    dropped: { id?: string; role: "user" | "assistant"; content: string }[],
    workspacePath: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.config.agent.summaryEnabled || dropped.length === 0) return;
    const summaryMessageId = dropped.at(-1)?.id;
    if (!summaryMessageId) return;
    const transcript = [
      ...(turn.summary ? [{ role: "assistant" as const, content: `[Existing summary]\n${turn.summary}` }] : []),
      ...dropped.map((message) => ({ role: message.role, content: message.content })),
    ];
    try {
      const summary = await this.agent.generate(
        {
          taskType: "conversation",
          systemPrompt: getSummarySystemPrompt(this.config.agent.responseLanguage),
          userPrompt: JSON.stringify({ conversation: transcript }),
        },
        workspacePath,
        signal,
      );
      this.store.saveConversationSummary(turn.conversationId, summary.content, summaryMessageId);
    } catch (error) {
      console.warn("conversation summary update failed", {
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
      // 出站前按 token 预算裁剪历史：注入多少由预算决定，而不是由条数决定，
      // 否则 30 条 × 20K 字符的历史足以撑爆任何窗口。
      const { messages: history, dropped } = trimHistory(
        turn.history,
        this.config.agent.historyTokenBudget,
      );
      if (dropped.length > 0) {
        console.info("conversation history trimmed to fit the token budget", {
          turnId: turn.turnId,
          dropped: dropped.length,
          kept: history.length,
        });
      }
      const userPrompt = buildConversationPrompt({
        repository: {
          project: turn.projectName,
          branch: turn.targetBranch,
          headSha: turn.headSha,
        },
        summary: turn.summary,
        currentRequest: turn.request,
      });
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
              systemPrompt: getConversationSystemPrompt(this.config.agent.responseLanguage, turn.mode),
              userPrompt,
              history,
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
      await this.updateSummary(turn, dropped, workspace.path, signal);
    } catch (error) {
      if (signal.aborted) {
        this.store.cancelConversationTurn(turn.turnId, "This turn was cancelled before it could finish.");
      } else {
        console.error("conversation turn failed", { turnId: turn.turnId, error: errorMessage(error) });
        this.store.failConversationTurn(turn.turnId, "failed", `This turn failed: ${errorMessage(error)}`);
      }
    }
  }
}
