import type { CorvexConfig } from "../config/config.js";
import { errorMessage } from "../errors.js";
import type { ConversationTurnContext } from "../events/model.js";
import type { EventStore } from "../events/store.js";
import { traceExecutionStep } from "../events/execution.js";
import { GitManager } from "../git/manager.js";
import type { Workspace } from "../git/types.js";
import { GitLabClient } from "../gitlab/client.js";
import { PiAgent, type EventTraceContext } from "../agent/pi.js";
import { getConversationSystemPrompt } from "../agent/prompts.js";

/** 单次对话请求注入模型上下文的历史消息条数上限，按最近优先截断。 */
const conversationHistoryMessages = 30;

/**
 * 在 Server 进程内联执行对话轮次：不走 Worker 队列、不占用事件租约，也从不向
 * GitLab 发布内容。每次执行都重新校验分支快照，过期即以 `stale` 结束。
 * 后续如需隔离执行环境，可把这里的模型调用替换为容器调用，其余流程不变。
 */
export class ConversationRunner {
  private readonly repo: GitManager;
  private readonly agent: PiAgent;
  private readonly running = new Map<string, AbortController>();

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
    this.running.set(turnId, controller);
    try {
      await this.execute(turn, controller.signal);
    } finally {
      this.running.delete(turnId);
      signal.removeEventListener("abort", abort);
    }
    return true;
  }

  /** 请求取消正在执行的轮次；轮次不在运行时忽略。 */
  cancelTurn(turnId: string): boolean {
    const controller = this.running.get(turnId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /** 是否正在执行该轮次，用于界面提示「执行中」。 */
  isRunning(turnId: string): boolean {
    return this.running.has(turnId);
  }

  private async execute(turn: ConversationTurnContext, signal: AbortSignal): Promise<void> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(turn.headSha)) {
      this.store.failConversationTurn(turn.turnId, "stale", "The branch did not have a valid commit snapshot.");
      return;
    }
    const stepContext = { turnId: turn.turnId, attempt: turn.attempt };
    let workspace: Workspace | undefined;
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
      workspace = await traceExecutionStep(
        this.store,
        stepContext,
        "git.prepare_conversation_workspace",
        { projectId: turn.projectId, turnId: turn.turnId, expectedHeadSha: turn.headSha },
        () => this.repo.prepareWorkspace(turn.projectId, turn.turnId, project.http_url_to_repo, turn.headSha, signal),
        (value) => ({ projectId: value.projectId, turnId: value.eventId, headSha: value.headSha }),
      );
      const trace: EventTraceContext = {
        scope: { kind: "conversation", turnId: turn.turnId },
        attempt: turn.attempt,
        taskType: "conversation",
        workspace,
      };
      const userPrompt = JSON.stringify({
        repository: {
          project: turn.projectName,
          branch: turn.targetBranch,
          headSha: turn.headSha,
        },
        conversation: turn.history.slice(-conversationHistoryMessages),
        currentRequest: turn.request,
      });
      const started = Date.now();
      let answer: Awaited<ReturnType<PiAgent["generate"]>>;
      try {
        answer = await traceExecutionStep(
          this.store,
          stepContext,
          "workflow.read_only_conversation",
          {
            projectId: turn.projectId,
            branch: turn.targetBranch,
            headSha: turn.headSha,
            requestCharacters: [...turn.request].length,
          },
          () => this.agent.generate(
            { taskType: "conversation", systemPrompt: getConversationSystemPrompt(this.config.agent.responseLanguage), userPrompt },
            workspace!.path,
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
    } catch (error) {
      if (signal.aborted) {
        this.store.cancelConversationTurn(turn.turnId, "This turn was cancelled before it could finish.");
      } else {
        console.error("conversation turn failed", { turnId: turn.turnId, error: errorMessage(error) });
        this.store.failConversationTurn(turn.turnId, "failed", `This turn failed: ${errorMessage(error)}`);
      }
    } finally {
      if (workspace) {
        try {
          await traceExecutionStep(
            this.store,
            stepContext,
            "git.cleanup_conversation_workspace",
            { projectId: workspace.projectId, turnId: turn.turnId },
            () => this.repo.cleanupWorkspace(workspace!),
            () => ({ cleaned: true }),
          );
        } catch (error) {
          console.warn("cleanup conversation workspace failed", { turnId: turn.turnId, error: errorMessage(error) });
        }
      }
    }
  }
}
