import { mkdir, realpath, writeFile as writeFileFs } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CorvexConfig } from "../config/config.js";
import { errorMessage } from "../errors.js";
import { applyActiveModel } from "../config/settings.js";
import { conversationCapabilities, normalizeConversationTitle } from "../events/model.js";
import type { ConversationProcessEntry, ConversationStreamEvent, ConversationTurnContext, ResponseLanguage } from "../events/model.js";
import type { EventStore } from "../events/store.js";
import { traceExecutionStep } from "../events/execution.js";
import { GitManager } from "../git/manager.js";
import type { Workspace } from "../git/types.js";
import { GitLabClient, repositoryCloneUrl } from "../gitlab/client.js";
import { PiAgent, type EventTraceContext } from "../agent/pi.js";
import { maxWriteBytes } from "../agent/repo-write.js";
import { buildConversationPrompt, chunkForSummary, estimateConservativeTokens, resolveHistoryBudgetTokens, trimHistory } from "../agent/budget.js";
import { getConversationCommandInstruction, getConversationSystemPrompt, getConversationTitleSystemPrompt, getSummarySystemPrompt } from "../agent/prompts.js";
import { parseConversationCommand } from "./conversation-command.js";
import { callAsyncHook, type CorvexHooks } from "./hooks.js";

interface CachedConversationWorkspace {
  workspace: Workspace;
  lastUsedAt: number;
}

interface RunningTurn {
  controller: AbortController;
  conversationId: string;
}

/**
 * 在 Server 进程内联执行对话轮次：不进入事件队列、不占用事件租约。对话统一为
 * 可读可写，可在用户明确要求时通过 GitLab 写工具发布内容。每次执行都重新校验
 * 分支快照，过期即以 `stale` 结束。后续如需隔离执行环境，可把这里的模型调用
 * 替换为容器调用，其余流程不变。
 *
 * 每个对话常驻一个只读 worktree 并跨轮次复用：同一快照的追问只做一次
 * `rev-parse` 校验，不再重复 checkout 整棵工作树再删除。对话从不写入 worktree，
 * 且同一对话的轮次串行执行，因此复用在授权与并发上都安全。
 */
export class ConversationRunner {
  private readonly repo: GitManager;
  private readonly agent: PiAgent;
  private readonly running = new Map<string, RunningTurn>();
  private readonly workspaces = new Map<string, CachedConversationWorkspace>();
  /** 每轮对话的流式订阅者；轮次结束后立即清理，避免连接与内存泄漏。 */
  private readonly streamListeners = new Map<string, Set<(event: ConversationStreamEvent) => void>>();
  /**
   * 每轮已推送事件的有序快照：界面晚于轮次启动才建连时按顺序补发，
   * 思考与工具调用的相对次序因此不会因重连而改变。
   */
  private readonly streamSnapshots = new Map<string, ConversationStreamEvent[]>();

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    private readonly gitlab: GitLabClient,
    private readonly hooks: CorvexHooks,
  ) {
    this.repo = new GitManager(
      config.storage.root,
      config.gitlab.baseUrl,
      config.gitlab.readToken,
      config.gitlab.writeToken,
    );
    // GitLab 协作模式的读写工具需要访问同一个客户端；必须把 gitlab 传给 PiAgent，
    // 否则 request.conversationMode==="gitlab" 时扩展根本不会注册。
    this.agent = new PiAgent(config, store, this.repo, undefined, undefined, undefined, gitlab, this.hooks);
    // LLM 精炼标题是默认实现；插件可用更高优先级的 tap 覆盖。
    this.hooks.conversationTitleRefine.tapPromise({ name: "llm-summary", stage: 100 }, async (input) => {
      const result = await this.agent.generate(
        {
          taskType: "conversation",
          systemPrompt: getConversationTitleSystemPrompt(input.language),
          userPrompt: input.request,
          noTools: true,
        },
        input.workspacePath,
        input.signal,
        input.trace ? { scope: input.trace, attempt: 1, taskType: "conversation" } : undefined,
      );
      return normalizeConversationTitle(result.content, input.language);
    });
  }

  /** 运维台修改 GitLab 连接设置后同步重建对话侧 Git 客户端。 */
  reconfigureGitLab(baseUrl: string, readToken: string, writeToken: string): void {
    this.gitlab.configure(baseUrl, readToken, writeToken);
    this.repo.reconfigureGitLab(baseUrl, readToken, writeToken);
  }

  /** 领取并执行一轮对话；轮次已被领取或不存在时返回 false。 */
  async runTurn(turnId: string, signal: AbortSignal, gitlab?: GitLabClient, responseLanguage?: ResponseLanguage): Promise<boolean> {
    const turn = this.store.claimConversationTurn(turnId);
    if (!turn) return false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.running.set(turnId, { controller, conversationId: turn.conversationId });
    try {
      const language = responseLanguage ?? this.config.agent.responseLanguage;
      await callAsyncHook(this.hooks.conversationBeforeTurn, turn);
      // 用户可在个人设置里选择自己的模型：用克隆配置承载它，避免改动全局配置影响并发轮次。
      let agent = this.agent;
      const ownerUserId = this.store.getConversation(turn.conversationId)?.ownerUserId;
      const active = ownerUserId ? this.store.getActiveModelForUser(ownerUserId) : undefined;
      if (active) {
        const config = structuredClone(this.config);
        applyActiveModel(config, active);
        agent = new PiAgent(config, this.store, this.repo, undefined, undefined, undefined, gitlab ?? this.gitlab, this.hooks);
      }
      await this.execute(turn, controller.signal, gitlab ?? this.gitlab, language, agent);
      await callAsyncHook(this.hooks.conversationAfterTurn, turn);
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

  /** 从控制台触发一次 Git 存储清理（可先 dry-run）。 */
  async cleanupStorage(olderThanDays: number, apply: boolean) {
    return this.repo.cleanupStorage(
      this.store.activeEventIds(),
      this.store.pendingProjectIds(),
      new Date(Date.now() - olderThanDays * 86_400_000),
      apply,
      this.store.activeConversationIds(),
    );
  }

  /** 启动时清理上次进程遗留的对话 worktree（不触碰项目镜像）。 */
  async cleanupStaleWorkspaces(): Promise<number> {
    const result = await this.repo.removeAllConversationWorkspaces();
    if (result.removed > 0) {
      console.info("removed stale conversation workspaces", { count: result.removed });
    }
    return result.removed;
  }

  /** 删除一个对话的常驻工作区；正在执行的对话不能删除。 */
  async removeConversationWorkspace(conversationId: string, projectId: number): Promise<boolean> {
    if (this.running.has(conversationId)) return false;
    this.workspaces.delete(conversationId);
    await this.repo.removeConversationWorkspaceById(projectId, conversationId);
    return true;
  }

  /** 把模型写入限定在该会话 worktree：拒绝绝对路径、上层遍历与 .git。 */
  private async writeWorkspaceFile(workspacePath: string, requested: string, content: string) {
    if (!requested || [...requested].length > 4096 || requested.includes("\0")) {
      throw new Error("invalid file path");
    }
    if (isAbsolute(requested) || /^[a-zA-Z]:/.test(requested)) {
      throw new Error("absolute paths are not allowed; use a repository-relative path");
    }
    const bytes = Buffer.byteLength(content);
    if (bytes > maxWriteBytes) throw new Error(`file content exceeds the ${maxWriteBytes}-byte limit`);
    const parts = requested.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("invalid repository-relative path");
    }
    if (parts[0] === ".git") throw new Error("writing .git is not allowed");
    const root = await realpath(workspacePath);
    const target = resolve(root, ...parts);
    const parent = await realpath(dirname(target)).catch(() => dirname(target));
    const inside = relative(root, parent);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error("file path escapes the conversation worktree");
    }
    await mkdir(parent, { recursive: true });
    await writeFileFs(target, content, "utf8");
    return { path: parts.join("/"), bytes };
  }

  /** 查询/放弃会话的本地改动；放弃时同时清掉 worktree。 */
  getConversationChanges(conversationId: string, projectId: number) {
    return this.repo.getConversationChanges(projectId, conversationId);
  }

  async discardConversationChanges(conversationId: string, projectId: number): Promise<void> {
    this.workspaces.delete(conversationId);
    await this.repo.discardConversationChanges(projectId, conversationId);
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
   * 订阅时按顺序补发已发生的事件：轮次通常由 POST 触发、界面随后才建立连接，
   * 直接只转发之后的增量会丢掉开头几段。文本是累计值，工具带调用 ID，
   * 重连后按同一套规则回放即可得到完整时间线。
   */
  subscribeTurn(turnId: string, listener: (event: ConversationStreamEvent) => void): () => void {
    const listeners = this.streamListeners.get(turnId) ?? new Set<(event: ConversationStreamEvent) => void>();
    listeners.add(listener);
    this.streamListeners.set(turnId, listeners);
    for (const event of this.streamSnapshots.get(turnId) ?? []) listener(event);
    return () => {
      const current = this.streamListeners.get(turnId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.streamListeners.delete(turnId);
    };
  }

  /** 推送流式事件；订阅者的异常不能影响轮次执行。 */
  private publishStream(turnId: string, event: ConversationStreamEvent): void {
    if (event.type === "done") {
      this.streamSnapshots.delete(turnId);
    } else {
      const events = this.streamSnapshots.get(turnId) ?? [];
      // 同一个 token 流里的连续文本事件只需保留最新一条，避免快照无限增长。
      if (event.type === "text" && events.at(-1)?.type === "text") events[events.length - 1] = event;
      else events.push(event);
      this.streamSnapshots.set(turnId, events);
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
    const ttlMs = this.config.storage.conversationWorkspaceTtlMinutes * 60_000;
    const maxWorkspaces = this.config.storage.conversationWorkspaceMax;
    // 正在执行或已排队但尚未领取的轮次都必须保护：它们下一刻就要用到这个目录。
    // 被淘汰的工作区只删目录，下次提问会按需重建，不会让轮次失败。
    const busy = new Set(this.store.activeConversationIds());
    for (const running of this.running.values()) busy.add(running.conversationId);
    const isProtected = (conversationId: string) => busy.has(conversationId) || this.hasActiveTurn(conversationId);

    const stale = [...this.workspaces.entries()].filter(
      ([conversationId, entry]) => !isProtected(conversationId) && now - entry.lastUsedAt >= ttlMs,
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
    let evicted = 0;
    while (this.workspaces.size > maxWorkspaces) {
      const candidate = [...this.workspaces.entries()]
        .filter(([conversationId]) => !isProtected(conversationId))
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
      if (!candidate) break;
      this.workspaces.delete(candidate[0]);
      try {
        await this.repo.removeConversationWorkspace(candidate[1].workspace);
        evicted += 1;
      } catch (error) {
        console.warn("evict least recently used conversation workspace failed", {
          conversationId: candidate[0],
          error: errorMessage(error),
        });
      }
    }
    if (evicted > 0) {
      console.info("evicted conversation workspaces by capacity", { evicted, maxWorkspaces });
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
    language: ResponseLanguage,
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
            systemPrompt: getSummarySystemPrompt(language),
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

  /** 首轮完成后用 LLM 从用户消息精炼标题；失败时保留创建时的确定性标题。 */
  private async refineTitle(
    turn: ConversationTurnContext,
    workspacePath: string,
    signal: AbortSignal,
    trace: EventTraceContext,
    language: ResponseLanguage,
  ): Promise<void> {
    if (turn.history.length > 0) return;
    try {
      const title = await callAsyncHook(this.hooks.conversationTitleRefine, {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        request: turn.request,
        language,
        workspacePath,
        signal,
        trace: trace.scope,
      });
      if (title) this.store.refineConversationTitle(turn.conversationId, title);
    } catch (error) {
      console.warn("conversation title refinement failed", {
        conversationId: turn.conversationId,
        error: errorMessage(error),
      });
    }
  }

  /**
   * 把本轮已推送的流式事件折成最终过程条目：文本按轮累计、工具按调用 ID 合并终态，
   * 最终回答由消息正文单独保存，不重复进入过程快照。
   */
  private collectProcess(turnId: string, finalAnswer?: string): ConversationProcessEntry[] {
    const entries: ConversationProcessEntry[] = [];
    const updateText = (kind: "thinking" | "text", text: string) => {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry?.kind === kind) {
          entry.text = text;
          return;
        }
      }
      entries.push({ kind, text });
    };
    for (const event of this.streamSnapshots.get(turnId) ?? []) {
      if (event.type === "thinking") {
        if (event.reset) entries.push({ kind: "thinking", text: event.text });
        else updateText("thinking", event.text);
      } else if (event.type === "text") {
        if (event.reset) entries.push({ kind: "text", text: event.text });
        else updateText("text", event.text);
      } else if (event.type === "context") {
        entries.push({ kind: "context", id: event.context.id, text: event.context.text });
      } else if (event.type === "tool") {
        const { tool } = event;
        const existing = entries.find((entry) => entry.kind === "tool" && entry.id === tool.id);
        if (existing?.kind === "tool") {
          existing.name = tool.name;
          existing.input = tool.input;
          existing.status = tool.status;
          existing.durationMs = tool.durationMs;
        } else {
          entries.push({
            kind: "tool",
            id: tool.id,
            name: tool.name,
            input: tool.input,
            status: tool.status,
            durationMs: tool.durationMs,
          });
        }
      }
    }
    const answer = finalAnswer?.trim();
    return entries.filter((entry) => {
      if (entry.kind === "tool") return true;
      if (!entry.text.trim()) return false;
      // 最终回答在消息正文里已有，过程块不再重复；中间回复照常保留。
      return !(answer && entry.kind === "text" && entry.text.trim() === answer);
    });
  }

  private async execute(
    turn: ConversationTurnContext,
    signal: AbortSignal,
    gitlab: GitLabClient,
    language: ResponseLanguage,
    agent: PiAgent,
  ): Promise<void> {
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
        () => gitlab.getBranch(turn.projectId, turn.targetBranch, signal),
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
        () => gitlab.getProject(turn.projectId, signal),
        (value) => ({ id: value.id, repositoryUrl: repositoryCloneUrl(this.config.gitlab.baseUrl, value) }),
      );
      const workspace = await traceExecutionStep(
        this.store,
        stepContext,
        "git.prepare_conversation_workspace",
        { projectId: turn.projectId, conversationId: turn.conversationId, expectedHeadSha: turn.headSha },
        () => this.repo.prepareConversationWorkspace(
          turn.projectId,
          turn.conversationId,
          repositoryCloneUrl(this.config.gitlab.baseUrl, project),
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
      const command = parseConversationCommand(turn.request);
      const systemPrompt = command
        ? `${getConversationSystemPrompt(language, turn.mode)}\n\n${getConversationCommandInstruction(command.command, language)}`
        : getConversationSystemPrompt(language, turn.mode);
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
          () => agent.generate(
            {
              taskType: "conversation",
              conversationMode: turn.mode,
              conversationProjectId: turn.projectId,
              gitlab,
              systemPrompt,
              userPrompt,
              history,
              // 正文与思考在落库前先推送给控制台；轮次完成后由 done 事件触发刷新。
              onTextDelta: (update) =>
                this.publishStream(turn.turnId, { type: "text", reset: update.reset, text: update.text }),
              onThinkingDelta: (update) =>
                this.publishStream(turn.turnId, { type: "thinking", reset: update.reset, text: update.text }),
              onToolDelta: (tool) => this.publishStream(turn.turnId, { type: "tool", tool }),
              onContextDelta: (context) => this.publishStream(turn.turnId, { type: "context", context }),
              writeFile: (path, content) => this.writeWorkspaceFile(workspace.path, path, content),
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
      try {
        await this.repo.saveConversationChanges(workspace, turn.conversationId, signal);
      } catch (error) {
        console.warn("save conversation workspace changes failed", {
          conversationId: turn.conversationId,
          error: errorMessage(error),
        });
      }
      this.store.finishConversationTurn(turn.turnId, answer.content, answer.model);
      this.store.saveConversationTurnProcess(turn.turnId, this.collectProcess(turn.turnId, answer.content));
      // 先展示创建时从用户消息派生的标题；done 后再用 LLM 精炼，失败则保留原标题。
      this.publishStream(turn.turnId, { type: "done", status: "completed" });
      void this.refineTitle(turn, workspace.path, signal, trace, language);
      await this.updateSummary(turn, dropped, workspace.path, signal, language);
    } catch (error) {
      // 失败/取消也保留已发生的思考与工具调用，刷新后仍能看到过程停在哪一步。
      this.store.saveConversationTurnProcess(turn.turnId, this.collectProcess(turn.turnId));
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
