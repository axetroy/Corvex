import { copyFile as copyFileFs, lstat, mkdir, readFile as readFileFs, rename, rm, writeFile as writeFileFs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { errorMessage } from "../errors.js";
import { applyActiveModel } from "../config/settings.js";
import { conversationCapabilities, normalizeConversationTitle } from "../model.js";
import type { Conversation, ConversationFollowUp, ConversationProcessEntry, ConversationSkill, ConversationStreamEvent, ConversationTurnContext, ConversationTurnStatus, ResponseLanguage } from "../model.js";
import type { AppStore } from "../store.js";
import { traceExecutionStep } from "../execution.js";
import { conversationWorkspaceName, GitManager, type SubmoduleOptions } from "../git/manager.js";
import type { Workspace } from "../git/types.js";
import { GitLabClient, repositoryCloneUrl, type GitLabBranch } from "../gitlab/client.js";
import { createSteerChannel, PiAgent, type SteerChannel, type TraceContext } from "../agent/pi.js";
import { maxWriteBytes, replaceTextExactly, resolveWorktreePath, type WorkspaceFs } from "../agent/fs/index.js";
import type { GitToolAdapter } from "../agent/git/index.js";
import { withGitToolBudget } from "../agent/git/budget.js";
import { USER_STOPPED_REASON } from "../agent/execution/types.js";
import { resolveTurnBaseSha } from "./conversation-base.js";
import { buildStaleConflictNote, type StaleConflictDetail } from "./stale-conflict.js";
import { buildConversationPrompt, chunkForSummary, estimateConservativeTokens, resolveHistoryBudgetTokens, trimHistory } from "../agent/budget.js";
import { buildToolEvidence } from "../agent/tool-evidence.js";
import { buildUploadContext } from "./upload.js";
import { imageUploadMaxBytes, maxImagesPerMessage } from "../upload-constants.js";
import { verifyAnswerClaims } from "../agent/claim-verification.js";
import { parseFollowups } from "../agent/followups.js";
import { getConversationSystemPrompt, getConversationTitleSystemPrompt, getSummarySystemPrompt } from "../agent/prompts.js";
import { resolveCommandRequest } from "./conversation-command.js";
import type { SkillStore } from "../agent/skill-store.js";
import type { SkillRegistry } from "../agent/skill-registry.js";
import { assignSkillLabels } from "../agent/fs/virtual-path.js";
import { createProviderTokenCounter } from "../agent/token-counter.js";
import { callAsyncHook, type CorvexHooks } from "./hooks.js";

interface CachedConversationWorkspace {
  workspace: Workspace;
  lastUsedAt: number;
}

interface RunningTurn {
  controller: AbortController;
  conversationId: string;
  /** 本轮的插话通道；轮次终结时关闭，缓冲中的补充消息不再投递。 */
  steer: SteerChannel;
}

/**
 * 在 Server 进程内联执行对话轮次：不进入事件队列、不占用事件租约。对话统一为
 * 可读可写，可在用户明确要求时通过 GitLab 写工具发布内容。每次执行都重新校验
 * 分支快照，过期即以 `stale` 结束。后续如需隔离执行环境，可把这里的模型调用
 * 替换为容器调用，其余流程不变。
 *
 * 每个对话常驻一个 worktree 并跨轮次复用：同一快照的追问只做一次
 * `rev-parse` 校验，不再重复 checkout 整棵工作树再删除。文件改动仅通过受限的
 * fs-write 工具写入并持久化到会话 ref，且同一对话的轮次串行执行，因此复用安全。
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
  /** 正在运行的命令：execId（工具调用 ID）→ 所属轮次 + 独立停止回调，用于 UI 单命令停止。 */
  private readonly execStops = new Map<string, { turnId: string; stop: (reason: string) => void }>();
  /** 每个对话只允许一个排队消费者，避免并发轮次重复取出同一条补充。 */
  private readonly draining = new Set<string>();
  /** 上次检查 worktree 大小的时间：高频对话不必每轮都遍历（node_modules 可达百万文件）。 */
  private readonly workspaceSizeCheckedAt = new Map<string, number>();
  /** 正在送进各轮次的插话正文，供 SSE delivered 事件复用（SDK 状态回调本身不带文本）。 */
  private readonly steerTexts = new Map<string, string>();
  /** Server 关闭信号；排队轮次也必须在关闭时中止。 */
  private shutdownSignal: AbortSignal | undefined;

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: AppStore,
    private readonly hooks: CorvexHooks,
    // 只有斜杠指令解析需要同步查技能；未注入时不展开任何指令，兼容旧调用方与测试。
    private readonly skills: Pick<SkillStore, "getCached" | "listCached"> = {
      getCached: () => undefined, listCached: () => [],
    },
    private readonly registry?: SkillRegistry,
  ) {
    this.repo = new GitManager(config.storage.root, config.gitlab.baseUrl);
    // GitLab 协作模式的读写工具需要访问同一个客户端；必须把 gitlab 传给 PiAgent，
    // 否则 request.conversationMode==="gitlab" 时扩展根本不会注册。
    this.agent = new PiAgent(config, store, this.repo, undefined, this.hooks);
    // 上下文快照的默认消费者：只做有界落库，插件可在同一 hook 上追加分析。
    this.hooks.contextSnapshot.tapPromise({ name: "store-context-snapshot", stage: 100 }, async (snapshot) => {
      try {
        this.store.saveContextSnapshot(snapshot);
      } catch (error) {
        console.warn("context snapshot could not be stored", { error: errorMessage(error) });
      }
    });
    // 会话删除时的默认清理：先释放 Git ref/工作区，再清掉按轮次的内存流状态。
    // 每个 tap 独立捕获错误写入 context.errors，调用方据此决定 HTTP 状态，
    // 同时保证一个资源清理失败不会阻断其余 tap（插件同样可追加自己的清理）。
    this.hooks.conversationDelete.tapPromise({ name: "git-resources", stage: 100 }, async (context) => {
      try {
        await this.discardConversationChanges(context.conversationId, context.projectId);
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    this.hooks.conversationDelete.tapPromise({ name: "stream-state", stage: 200 }, async (context) => {
      try {
        this.workspaces.delete(context.conversationId);
        // 排队补充消息的消费者也按会话记账；删除后不应继续向已消失的会话投递。
        this.draining.delete(context.conversationId);
        for (const turnId of context.turnIds) {
          this.streamSnapshots.delete(turnId);
          this.streamListeners.delete(turnId);
        }
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
    // 上传附件随会话删除/保留裁剪一起清理；「放弃改动」只处理 Git 改动，不动用户附件。
    this.hooks.conversationDelete.tapPromise({ name: "uploads", stage: 300 }, async (context) => {
      if (context.reason === "changes") return;
      try {
        await rm(resolve(this.config.storage.root, "uploads", context.conversationId), { recursive: true, force: true });
      } catch (error) {
        context.errors.push(errorMessage(error));
      }
    });
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

  /** 运维台修改 GitLab 地址后同步更新镜像来源校验；认证始终使用当前用户 token。 */
  reconfigureGitLab(baseUrl: string): void {
    this.repo.reconfigureGitLab(baseUrl);
  }

  /** 领取并执行一轮对话；轮次已被领取或不存在时返回 false。 */
  async runTurn(
    turnId: string,
    signal: AbortSignal,
    gitlab: GitLabClient,
    responseLanguage?: ResponseLanguage,
    drainFollowUps = true,
  ): Promise<boolean> {
    const turn = this.store.claimConversationTurn(turnId);
    if (!turn) return false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const steer = createSteerChannel();
    this.running.set(turnId, { controller, conversationId: turn.conversationId, steer });
    try {
      const language = responseLanguage ?? this.config.agent.responseLanguage;
      await callAsyncHook(this.hooks.conversationBeforeTurn, turn);
      // 用户可在个人设置里选择自己的模型：用克隆配置承载它，避免改动全局配置影响并发轮次。
      let agent = this.agent;
      const ownerUserId = this.store.getConversation(turn.conversationId)?.ownerUserId;
      const active = ownerUserId ? this.store.getActiveModelForUser(ownerUserId) : undefined;
      const userThinking = ownerUserId ? this.store.getUserThinkingLevel(ownerUserId) : undefined;
      if (active || userThinking) {
        const config = structuredClone(this.config);
        if (active) applyActiveModel(config, active);
        if (userThinking) config.agent.thinkingLevel = userThinking;
        agent = new PiAgent(config, this.store, this.repo, gitlab, this.hooks);
      }
      await this.execute(turn, controller.signal, gitlab, language, agent, steer);
      await callAsyncHook(this.hooks.conversationAfterTurn, turn);
    } finally {
      // 会话尚未就绪就被终止时，缓冲的插话没有真正送达模型：降级为持久排队消息，
      // 由下一轮消费，避免用户补充只留下一个没有回复的气泡。
      const undelivered = steer.close();
      for (const text of undelivered) {
        this.store.enqueueFollowUp(turn.conversationId, text);
      }
      if (undelivered.length > 0) this.publishQueue(turn.conversationId);
      this.running.delete(turnId);
      this.steerTexts.delete(turnId);
      // 轮次结束兜底清理命令停止回调（命令信号已与 turn signal 关联，无需再次 abort）。
      // 只清本轮，避免影响并发运行的其他轮次。
      for (const [execId, entry] of this.execStops) {
        if (entry.turnId === turnId) this.execStops.delete(execId);
      }
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
      // 本轮已落库：按 FIFO 启动该对话下一条排队消息；排出来的轮次不再重复触发消费。
      if (drainFollowUps) {
        void this.drainFollowUps(turn.conversationId, gitlab, responseLanguage).catch((error: unknown) => {
          console.warn("conversation follow-up queue could not be drained", {
            conversationId: turn.conversationId,
            error: errorMessage(error),
          });
        });
      }
    }
    return true;
  }

  /** 只读统计镜像与工作树，供运维台存储管理页展示。 */
  async describeStorage() {
    return this.repo.describeStorage();
  }

  /** 从控制台触发一次 Git 存储清理（可先 dry-run）。 */
  async cleanupStorage(olderThanDays: number, apply: boolean) {
    return this.repo.cleanupStorage(
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

  /** 清理 workspaces 下已空的项目目录（删除 worktree 后的残留）。 */
  async pruneEmptyWorkspaceDirs(): Promise<number> {
    const removed = await this.repo.pruneEmptyWorkspaceDirs();
    if (removed > 0) console.info("removed empty workspace directories", { count: removed });
    return removed;
  }

  /** 删除一个对话的常驻工作区；正在执行的对话不能删除。 */
  async removeConversationWorkspace(conversationId: string, projectId: number): Promise<boolean> {
    if (this.running.has(conversationId)) return false;
    this.workspaces.delete(conversationId);
    this.workspaceSizeCheckedAt.delete(conversationId);
    await this.repo.removeConversationWorkspaceById(projectId, conversationId);
    return true;
  }

  /** 把文件系统能力绑定到当前会话的 worktree；所有路径都走共享守卫。 */
  private workspaceFs(workspacePath: string, submodules: readonly string[] = []): WorkspaceFs {
    // 子模块是只读依赖：写进去的改动不会进入 superproject 的会话 ref，必须直接拒绝。
    const isSubmodulePath = (path: string): boolean =>
      submodules.some((sub) => path === sub || path.startsWith(`${sub}/`));
    const resolveWritable = async (requested: string) => {
      const resolved = await resolveWorktreePath(workspacePath, requested);
      if (isSubmodulePath(resolved.path)) {
        throw new Error(`submodule paths are read-only: ${resolved.path}`);
      }
      return resolved;
    };
    const writeFile = async (requested: string, content: string) => {
      const bytes = Buffer.byteLength(content);
      if (bytes > maxWriteBytes) throw new Error(`file content exceeds the ${maxWriteBytes}-byte limit`);
      const { target, path } = await resolveWritable(requested);
      await mkdir(dirname(target), { recursive: true });
      await writeFileFs(target, content, "utf8");
      return { path, bytes };
    };
    const editFile = async (requested: string, oldString: string, newString: string, replaceAll: boolean) => {
      const { target, path } = await resolveWritable(requested);
      const current = await readFileFs(target, "utf8");
      const { updated, replaced } = replaceTextExactly(current, oldString, newString, replaceAll);
      const bytes = Buffer.byteLength(updated);
      if (bytes > maxWriteBytes) throw new Error(`file content exceeds the ${maxWriteBytes}-byte limit`);
      await writeFileFs(target, updated, "utf8");
      return { path, bytes, replaced };
    };
    const deleteFile = async (requested: string) => {
      const { target, path } = await resolveWritable(requested);
      await rm(target, { force: false });
      return { path, bytes: 0 };
    };
    const resolvePair = async (from: string, to: string, overwrite: boolean) => {
      const source = await resolveWritable(from);
      const destination = await resolveWritable(to);
      // 用 lstat 判存在而不读文件内容：大文件/二进制不会浪费内存，
      // 也不会把权限错误误判为「不存在」。
      let existing;
      try {
        existing = await lstat(destination.target);
      } catch {
        existing = undefined;
      }
      if (existing && !overwrite) throw new Error(`destination already exists: ${destination.path}`);
      // 这些工具只操作文件；不允许把目标指向目录，避免覆盖时递归删掉整棵子树。
      if (existing?.isDirectory()) throw new Error(`destination is a directory: ${destination.path}`);
      return { source, destination, existing };
    };
    const moveFile = async (from: string, to: string, overwrite: boolean) => {
      const { source, destination, existing } = await resolvePair(from, to, overwrite);
      await mkdir(dirname(destination.target), { recursive: true });
      // Windows 上 rename 到已存在的文件会失败，覆盖时先显式删除目标。
      if (existing) await rm(destination.target, { recursive: true, force: true });
      await rename(source.target, destination.target);
      return { path: destination.path, bytes: 0 };
    };
    const copyFile = async (from: string, to: string, overwrite: boolean) => {
      const { source, destination } = await resolvePair(from, to, overwrite);
      await mkdir(dirname(destination.target), { recursive: true });
      await copyFileFs(source.target, destination.target);
      return { path: destination.path, bytes: 0 };
    };
    return { writeFile, editFile, deleteFile, moveFile, copyFile };
  }

  /**
   * 把 Git 工具绑定到当前会话的 worktree、项目镜像与同步基线。
   *
   * publish 成功后把基线推进到已发布的提交：本轮后续 commit 才会以它为父提交并保持快进，
   * 否则同一轮内第二次 push 必然非快进。任何分支的 publish 都推进基线，失败不影响发布结果；
   * 发布到功能分支时另外尝试复用/创建 MR。
   */
  private gitTools(
    workspace: Workspace,
    conversationId: string,
    turnId: string,
    targetBranch: string,
    gitlab: GitLabClient,
    signal?: AbortSignal,
  ): GitToolAdapter {
    // 令牌在每次 Git 网络操作时现读，避免长轮次里后台刷新后仍用旧 token。
    const authToken = () => gitlab.authToken;
    const onPublished = async (sha: string, branch: string): Promise<void> => {
      try {
        // 不管推到哪个分支，发布出去的提交都是新的同步基线：本轮后续 commit 以它为父提交。
        this.store.setConversationBaseSha(conversationId, sha, branch);
        workspace.headSha = sha;
        // 改动已经进入 GitLab，不再是未发布改动：清掉会话 ref，Changes 视图回到空状态。
        await this.repo.clearConversationChangesRef(workspace.projectId, conversationId, signal);
      } catch (error) {
        // 发布本身已经成功，基线同步失败只记日志，不把成功报成失败。
        console.warn("advance conversation base SHA failed", {
          conversationId, branch, sha, error: errorMessage(error),
        });
      }
      await this.ensureMergeRequest(turnId, conversationId, workspace.projectId, branch, targetBranch, sha, gitlab, signal);
    };
    const adapter: GitToolAdapter = {
      status: () => this.repo.getWorkspaceStatus(workspace, signal),
      log: (limit, path) => this.repo.getCommitLog(workspace, limit, path, signal),
      show: (sha, path) => this.repo.showCommit(workspace, sha, path, signal),
      diff: (path) => this.repo.getWorkspaceDiff(workspace, path, signal),
      // worktree 已由 Runner 准备到同步基线；这里只返回当前位置，不克隆任意 URL。
      // 只回虚拟根，绝不把宿主机 worktree 绝对路径交给模型。
      clone: async () => ({ path: "worktree://", headSha: workspace.headSha }),
      branches: () => this.repo.listBranches(workspace, signal),
      createBranch: (name) => this.repo.createBranch(workspace, name, signal),
      switchBranch: (name) => this.repo.switchBranch(workspace, name, signal),
      checkout: (name) => this.repo.checkoutBranch(workspace, name, signal),
      pull: () => this.repo.fetchFromMirror(workspace, signal, authToken()),
      sync: () => this.repo.syncMirrorFromGitLab(workspace.projectId, signal, authToken()),
      merge: (ref) => this.repo.mergeRef(workspace, ref, signal),
      commit: (message) => this.repo.saveConversationChanges(workspace, conversationId, signal, message, turnId),
      push: async () => {
        const result = await this.repo.saveConversationChanges(workspace, conversationId, signal, undefined, turnId);
        return result ? { ref: `refs/conversations/${conversationId}`, sha: result.sha } : undefined;
      },
      pushBranch: async (sha, branch) => {
        const result = await this.repo.pushBranchToGitLab(workspace.projectId, sha, branch, signal, authToken());
        await onPublished(result.sha, branch);
        return result;
      },
      publish: async (branch, message) => {
        const result = await this.repo.publishToGitLabBranch(
          workspace.projectId, conversationId, workspace, branch, message, signal, authToken(),
        );
        await onPublished(result.sha, branch);
        return result;
      },
      rebase: (onto) => this.repo.rebaseWorktree(workspace, onto, signal),
      cherryPick: (sha) => this.repo.cherryPickWorktree(workspace, sha, signal),
      revert: (sha) => this.repo.revertWorktreeCommit(workspace, sha, signal),
    };
    // 预算只约束模型主动调用的 Git 工具；轮末由 Runner 自己调用的 persistChanges 不走这里。
    return withGitToolBudget(adapter, this.config.agent.gitToolCallLimit);
  }

  private async persistChanges(workspace: Workspace, conversationId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.repo.saveConversationChanges(workspace, conversationId, signal, undefined, turnId);
    } catch (error) {
      console.warn("save conversation workspace changes failed", {
        conversationId,
        error: errorMessage(error),
      });
    }
  }

  /** 查询/放弃会话的本地改动；放弃时同时清掉 worktree。 */
  /**
   * 命令执行后检查单个会话 worktree 的大小：超过配置上限只警告与记录，不删除任何文件。
   * 只在轮末做一次、且每个会话有冷却时间；有界扫描且超限即提前结束，不阻断轮次。
   */
  private async checkWorkspaceSize(
    workspace: Workspace,
    conversationId: string,
    turnId: string,
    actorId: number,
  ): Promise<void> {
    const cooldownMs = 5 * 60_000;
    const now = Date.now();
    const last = this.workspaceSizeCheckedAt.get(conversationId);
    if (last !== undefined && now - last < cooldownMs) return;
    this.workspaceSizeCheckedAt.set(conversationId, now);

    const limitBytes = this.config.storage.conversationWorkspaceMaxMb * 1024 * 1024;
    try {
      const { bytes, truncated, exceeded } = await this.repo.measureWorkspace(workspace, limitBytes);
      const limited = exceeded || bytes > limitBytes;
      if (limited || truncated) {
        const sizeMb = Math.round(bytes / 1024 / 1024);
        const limitMb = this.config.storage.conversationWorkspaceMaxMb;
        const zh = this.config.agent.responseLanguage === "zh-CN";
        const text = limited
          ? zh
            ? `会话工作区已占用约 ${sizeMb} MiB，超过上限 ${limitMb} MiB；请清理不再需要的文件或放弃改动。`
            : `Conversation workspace uses about ${sizeMb} MiB, above the ${limitMb} MiB limit. Remove unneeded files or discard the changes.`
          : zh
            ? `会话工作区大小统计已达扫描上限（约 ${sizeMb} MiB），实际可能更大，请检查是否有大文件。`
            : `Workspace size scan hit its bound (about ${sizeMb} MiB); the real size may be larger. Check for large files.`;
        this.publishStream(turnId, {
          type: "context",
          context: { id: `workspace-size-${turnId}`, text },
        });
        this.store.insertWorkspaceSizeAudit(actorId, conversationId, turnId, bytes, limitBytes, truncated);
        console.warn("conversation workspace size warning", {
          conversationId, turnId, bytes, limitBytes, truncated, exceeded,
        });
      }
    } catch (error) {
      console.warn("conversation workspace size check failed", {
        conversationId, turnId, error: errorMessage(error),
      });
    }
  }

  /** 子模块检出结果写进同一轮的 context 提示，让用户知道哪些没拉到。 */
  private submoduleOptions(turnId?: string): SubmoduleOptions {
    const agent = this.config.agent;
    return {
      allowedOrigins: agent.submoduleAllowedHosts ?? [],
      hostTokens: agent.submoduleHostTokens ?? "",
      ...(turnId ? {
        onNotice: (reason, path) => {
          const zh = agent.responseLanguage === "zh-CN";
          const text = reason === "fetched"
            ? zh ? `已只读检出子模块 ${path}。` : `Checked out submodule ${path} (read-only).`
            : zh ? `子模块 ${path} 已跳过（${reason}），其内容不可读。` : `Submodule ${path} skipped (${reason}); its files are unavailable.`;
          this.publishStream(turnId, {
            type: "context",
            context: { id: `submodule-${reason}-${path}`, text },
          });
        },
      } : {}),
    };
  }

  getConversationChanges(conversationId: string, projectId: number) {
    return this.repo.getConversationChanges(projectId, conversationId);
  }

  async discardConversationChanges(conversationId: string, projectId: number): Promise<void> {
    if (this.running.has(conversationId) || this.hasActiveTurn(conversationId) ||
      this.store.activeConversationIds().has(conversationId)) {
      throw new Error("cannot discard changes while a turn is active");
    }
    this.workspaces.delete(conversationId);
    await this.repo.discardConversationChanges(projectId, conversationId);
  }

  /** 撤销会话改动中的单个文件；worktree 被淘汰时按会话基线重建后再操作。 */
  async discardConversationFile(
    conversation: Conversation,
    path: string,
    gitlab: GitLabClient,
    signal?: AbortSignal,
  ): Promise<void> {
    const id = conversation.id;
    if (this.running.has(id) || this.hasActiveTurn(id) || this.store.activeConversationIds().has(id)) {
      throw new Error("cannot discard changes while a turn is active");
    }
    let workspace = this.workspaces.get(id)?.workspace;
    if (!workspace) {
      const project = await gitlab.getProject(conversation.projectId, signal);
      workspace = await this.repo.prepareConversationWorkspace(
        conversation.projectId,
        id,
        repositoryCloneUrl(this.config.gitlab.baseUrl, project),
        conversation.baseSha,
        signal,
        gitlab.authToken,
        this.submoduleOptions(),
      );
      this.workspaces.set(id, { workspace, lastUsedAt: Date.now() });
    }
    await this.repo.discardConversationFile(workspace, id, path, signal);
  }

  /** 控制台文件操作后把 worktree 改动写入会话 ref，避免淘汰 worktree 时丢失。 */
  async saveConversationChangesById(conversationId: string, projectId: number, expectedSha: string): Promise<void> {
    await this.repo.saveConversationChangesById(projectId, conversationId, expectedSha);
  }

  getCommitGraph(projectId: number, options: { limit: number; offset?: number; author?: string }) {
    return this.repo.getCommitGraph(projectId, options);
  }

  /** 读取会话 worktree 的当前检出状态，供 Git 图谱标记当前分支。工作区不存在时返回空值。 */
  async gitWorktreeState(conversationId: string): Promise<{ headSha: string; branch: string }> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) return { headSha: "", branch: "" };
    const workspace: Workspace = {
      projectId: conversation.projectId,
      workspaceName: conversationWorkspaceName(conversationId),
      path: join(this.config.storage.root, "workspaces", String(conversation.projectId), conversationWorkspaceName(conversationId)),
      headSha: conversation.baseSha || this.store.getConversationTurns(conversationId)?.turns.at(-1)?.headSha || "",
    };
    try {
      const [status, branch] = await Promise.all([
        this.repo.getWorkspaceStatus(workspace),
        this.repo.currentBranch(workspace),
      ]);
      return { headSha: status.headSha, branch };
    } catch {
      return { headSha: "", branch: "" };
    }
  }

  /** 控制台快捷操作：从本地镜像抓取远端更新。 */
  async gitPull(conversationId: string, authToken: string): Promise<{ sha: string; fetched: boolean }> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("conversation not found");
    const workspace: Workspace = {
      projectId: conversation.projectId,
      workspaceName: conversationWorkspaceName(conversationId),
      path: join(this.config.storage.root, "workspaces", String(conversation.projectId), conversationWorkspaceName(conversationId)),
      headSha: conversation.baseSha || this.store.getConversationTurns(conversationId)?.turns.at(-1)?.headSha || "",
    };
    if (!authToken) throw new Error("the logged-in user's GitLab token is required");
    return this.repo.fetchFromMirror(workspace, undefined, authToken);
  }

  /** 控制台快捷操作：把 worktree 改动保存到会话 ref（不推送 GitLab 分支）。 */
  async gitPush(conversationId: string): Promise<{ sha: string; saved: boolean }> {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("conversation not found");
    const expectedSha = conversation.baseSha || this.store.getConversationTurns(conversationId)?.turns.at(-1)?.headSha || "";
    const saved = await this.repo.saveConversationChangesById(conversation.projectId, conversation.id, expectedSha);
    return saved ? { sha: saved.sha, saved: true } : { sha: expectedSha, saved: false };
  }

  getConversationChangeDetails(conversationId: string) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("conversation not found");
    return this.repo.getConversationChangeDetails(conversation.projectId, conversationId);
  }

  getConversationTurnChanges(conversationId: string, turnId: string) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("conversation not found");
    return this.repo.getConversationTurnChanges(conversation.projectId, conversationId, turnId);
  }

  listCommitAuthors(projectId: number) {
    return this.repo.listCommitAuthors(projectId);
  }

  showCommitFromMirror(projectId: number, sha: string) {
    return this.repo.showCommitFromMirror(projectId, sha);
  }

  formatCommitPatch(projectId: number, sha: string) {
    return this.repo.formatPatchFromMirror(projectId, sha);
  }

  pruneConversationChanges(validIds: ReadonlySet<string>) {
    return this.repo.pruneConversationChanges(validIds);
  }

  gcMirrors(retentionDays: number) {
    return this.repo.gcMirrors(retentionDays);
  }

  /** 请求取消正在执行的轮次；轮次不在运行时忽略。 */
  cancelTurn(turnId: string): boolean {
    const running = this.running.get(turnId);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  /** 停止一条正在运行的命令（不取消整轮）；reason 固定为用户手动停止，供模型据此决策。 */
  cancelExecution(turnId: string, execId: string): boolean {
    // 只有属于该轮次且仍在运行的命令才能停止，避免跨轮次误停。
    const entry = this.execStops.get(execId);
    if (!entry || entry.turnId !== turnId || !this.running.has(turnId)) return false;
    entry.stop(USER_STOPPED_REASON);
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
      const previous = events.at(-1);
      // 同一个 token 流里的连续文本事件只需保留最新一条，避免快照无限增长。
      if (event.type === "text" && previous?.type === "text") {
        events[events.length - 1] = event;
      } else if (event.type === "exec" && !event.done && previous?.type === "exec" &&
        previous.execId === event.execId && previous.stream === event.stream && !previous.done) {
        // 同一条命令的连续输出增量合并为一条，防止高频 chunk 撑大重连快照。
        events[events.length - 1] = { ...previous, chunk: previous.chunk + event.chunk };
      } else {
        events.push(event);
      }
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
          conversationId: entry.workspace.workspaceName,
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

  /** 注入 Server 的关闭信号，让启动恢复的排队轮次也能在关闭时中止。 */
  setShutdownSignal(signal: AbortSignal): void {
    this.shutdownSignal = signal;
  }

  /** 当前正在执行的轮次 ID；排队但未领取的轮次不算，因为没有可插话的会话。 */
  activeTurnId(conversationId: string): string | undefined {
    for (const [turnId, running] of this.running) {
      if (running.conversationId === conversationId) return turnId;
    }
    return undefined;
  }

  /**
   * 把用户在执行期间的补充消息送进当前轮次。会话未就绪的消息由通道缓冲；
   * 轮次已结束时返回 unavailable，由调用方降级为普通的下一轮。
   */
  async interject(turnId: string, text: string): Promise<"steer" | "unavailable"> {
    const running = this.running.get(turnId);
    if (!running) return "unavailable";
    const disposition = await running.steer.send(text);
    if (disposition === "unavailable") return "unavailable";
    this.steerTexts.set(turnId, text);
    // "delivered" 由 onSteerStatus 回调在 SDK 真正消费补充时推送；这里只兜底推送一次 queued。
    if (disposition === "buffered") {
      this.publishStream(turnId, { type: "interjection", turnId, status: "queued", text });
    }
    return "steer";
  }

  private publishQueue(conversationId: string): void {
    const turnId = this.activeTurnId(conversationId);
    if (turnId) this.publishStream(turnId, { type: "queue", count: this.store.listFollowUps(conversationId).length });
  }

  listFollowUps(conversationId: string): ConversationFollowUp[] {
    return this.store.listFollowUps(conversationId);
  }

  enqueueFollowUp(conversationId: string, content: string): ConversationFollowUp {
    const item = this.store.enqueueFollowUp(conversationId, content);
    this.publishQueue(conversationId);
    return item;
  }

  removeFollowUp(conversationId: string, itemId: string): boolean {
    const removed = this.store.removeFollowUp(conversationId, itemId);
    if (removed) this.publishQueue(conversationId);
    return removed;
  }

  moveFollowUp(conversationId: string, itemId: string, direction: "up" | "down"): boolean {
    const moved = this.store.moveFollowUp(conversationId, itemId, direction);
    if (moved) this.publishQueue(conversationId);
    return moved;
  }

  /**
   * 当前轮结束后按 FIFO 执行排队的补充消息。每条消息都在真正开始时重新获取分支
   * 快照，避免排队期间分支移动导致整队 stale；某个排队项失败时放回队首并停止，
   * 防止同一个失败项反复重试。
   */
  async drainFollowUps(
    conversationId: string,
    gitlab?: GitLabClient,
    responseLanguage?: ResponseLanguage,
    clientForUser?: (ownerUserId: string) => Promise<GitLabClient | undefined>,
  ): Promise<void> {
    if (this.draining.has(conversationId)) return;
    this.draining.add(conversationId);
    try {
      const signal = this.shutdownSignal ?? new AbortController().signal;
      while (!this.hasActiveTurn(conversationId)) {
        const item = this.store.takeNextFollowUp(conversationId);
        if (!item) break;
        this.publishQueue(conversationId);
        try {
          const conversation = this.store.getConversation(conversationId);
          if (!conversation) break;
          // 启动恢复时没有 HTTP 请求可派生用户凭证：按对话 owner 解析其登录令牌，
          // 保证排队轮次的 GitLab API 与工具仍然绑定该用户，而不是宿主机/全局账号。
          const client = gitlab ??
            (conversation.ownerUserId && clientForUser
              ? await clientForUser(conversation.ownerUserId)
              : undefined);
          // 不允许回退到全局凭据：拿不到当前用户令牌时保留队列项，等下次再试。
          if (!client) throw new Error("the conversation owner's GitLab token is unavailable");
          const headSha = (await client.getBranch(conversation.projectId, conversation.targetBranch, signal)).commit.id;
          const created = this.store.addConversationMessage(conversationId, {
            ownerUserId: conversation.ownerUserId,
            projectId: conversation.projectId,
            targetBranch: conversation.targetBranch,
            headSha,
            actorId: 0,
            request: item.content,
          });
          // 排出来的轮次不再触发下一轮消费，避免递归；下面的 while 继续处理队列。
          await this.runTurn(created.turnId, signal, client, responseLanguage, false);
        } catch (error) {
          this.store.restoreFollowUp(conversationId, item.content);
          this.publishQueue(conversationId);
          console.warn("queued conversation follow-up could not start", {
            conversationId,
            error: errorMessage(error),
          });
          break;
        }
      }
    } finally {
      this.draining.delete(conversationId);
    }
  }

  /** 进程启动时恢复尚未执行的排队消息，并用对话所属用户的 GitLab 凭据执行。 */
  async resumeFollowUps(clientForUser?: (ownerUserId: string) => Promise<GitLabClient | undefined>): Promise<void> {
    for (const conversationId of this.store.conversationsWithFollowUps()) {
      await this.drainFollowUps(conversationId, undefined, undefined, clientForUser);
    }
  }

  /**
   * 立即打断：中止当前轮并等待其落库，之后调用方可以用新的快照创建下一轮。
   * 已完成的文件改动由现有的取消路径落库，不会被丢弃。
   */
  async interruptForSend(conversationId: string, turnId: string): Promise<boolean> {
    const turn = this.store.getConversationTurn(conversationId, turnId);
    const settled: ConversationTurnStatus[] = ["completed", "failed", "stale", "cancelled"];
    if (!turn || settled.includes(turn.status)) return false;
    if (!this.cancelTurn(turnId)) {
      // 还没被领取的排队轮次没有 AbortController，直接按取消收尾。
      this.store.cancelConversationTurn(turnId, "Interrupted by a new message.");
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const current = this.store.getConversationTurn(conversationId, turnId);
      // 必须等到运行表也清掉该轮次：否则新消息会在它尚未退场时被误判为重叠轮次。
      if ((!current || settled.includes(current.status)) && !this.running.has(turnId)) return true;
      await delay(50);
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
    compactionSummary?: string,
  ): Promise<void> {
    if (!this.config.agent.summaryEnabled) return;
    const boundaryId = dropped.at(-1)?.id ?? turn.history.at(-1)?.id ?? turn.summaryMessageId;
    if (!boundaryId) return;
    // SDK 本轮已经压缩过：直接复用它的摘要作为跨轮记忆，避免再调用一次摘要模型。
    if (compactionSummary) {
      this.store.saveConversationSummary(turn.conversationId, compactionSummary, boundaryId);
      return;
    }
    if (dropped.length === 0) return;
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

  /** 斜杠技能查询绑定到会话拥有者，避免跨用户命中个人技能。 */
  private skillLookup(conversationId: string): (name: string) => ConversationSkill | undefined {
    if (!this.registry) return (name) => this.skills.getCached(name);
    const userId = this.store.getConversation(conversationId)?.ownerUserId ?? "";
    return (name) => this.registry!.resolve(userId, name);
  }

  /** 首轮完成后用 LLM 从用户消息精炼标题；失败时保留创建时的确定性标题。 */
  private async refineTitle(
    turn: ConversationTurnContext,
    workspacePath: string,
    signal: AbortSignal,
    trace: TraceContext,
    language: ResponseLanguage,
  ): Promise<void> {
    if (turn.history.length > 0) return;
    if (this.registry) {
      const owner = this.store.getConversation(turn.conversationId)?.ownerUserId ?? "";
      await this.registry.ensureUser(owner);
      await this.registry.refreshIfStale(owner);
    }
    try {
      const title = await callAsyncHook(this.hooks.conversationTitleRefine, {
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        request: resolveCommandRequest(
          turn.request,
          this.skillLookup(turn.conversationId),
        ).titleRequest,
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
    // 命令输出按 execId 汇总：SSE 里是增量 chunk，落库时拼成完整 stdout/stderr，
    // 刷新后据此还原终端内容（见 UI 的 ConversationExecTerminal）。
    const execAccum = new Map<string, {
      stdout: string;
      stderr: string;
      exitCode?: number | null;
      aborted?: boolean;
      reason?: string;
      truncated?: boolean;
    }>();
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
      if (event.type === "exec") {
        const output = execAccum.get(event.execId) ?? { stdout: "", stderr: "" };
        if (event.done) {
          output.exitCode = event.exitCode;
          output.aborted = event.aborted;
          output.reason = event.reason;
          output.truncated = event.truncated;
        } else if (event.chunk) {
          if (event.stream === "stdout") output.stdout += event.chunk;
          else output.stderr += event.chunk;
        }
        execAccum.set(event.execId, output);
      } else if (event.type === "thinking") {
        if (event.reset) entries.push({ kind: "thinking", text: event.text });
        else updateText("thinking", event.text);
      } else if (event.type === "text") {
        if (event.reset) entries.push({ kind: "text", text: event.text });
        else updateText("text", event.text);
      } else if (event.type === "context") {
        entries.push({ kind: "context", id: event.context.id, text: event.context.text });
      } else if (event.type === "interjection") {
        // queued 与 delivered 可能描述同一条插话，按正文去重，保持它在过程里的先后顺序。
        const text = event.text.trim();
        const last = entries.at(-1);
        if (text && !(last?.kind === "interjection" && last.text === text)) {
          entries.push({ kind: "interjection", text });
        }
      } else if (event.type === "scheduled_task_card") {
        entries.push({ kind: "scheduleCard", card: event.card });
      } else if (event.type === "tool") {
        const { tool } = event;
        const existing = entries.find((entry) => entry.kind === "tool" && entry.id === tool.id);
        if (existing?.kind === "tool") {
          existing.name = tool.name;
          existing.input = tool.input;
          existing.status = tool.status;
          existing.durationMs = tool.durationMs;
          if (tool.output) existing.output = tool.output;
        } else {
          entries.push({
            kind: "tool",
            id: tool.id,
            name: tool.name,
            input: tool.input,
            status: tool.status,
            durationMs: tool.durationMs,
            ...(tool.output ? { output: tool.output } : {}),
          });
        }
      }
    }
    // 命令终态晚于工具开始事件，循环结束后再把完整输出挂到对应工具条目上。
    for (const entry of entries) {
      if (entry.kind === "tool" && entry.id) {
        const output = execAccum.get(entry.id);
        if (output) entry.execOutput = output;
      }
    }
    const answer = finalAnswer?.trim();
    return entries.filter((entry) => {
      if (entry.kind === "tool" || entry.kind === "scheduleCard") return true;
      if (!entry.text.trim()) return false;
      // 最终回答在消息正文里已有，过程块不再重复；中间回复照常保留。
      return !(answer && entry.kind === "text" && entry.text.trim() === answer);
    });
  }

  /**
   * 首次发布到功能分支后创建（或复用）MR。失败只记日志，绝不影响已经成功的 publish。
   * 复用判断按 source/target 分支匹配已打开的 MR，避免模型随后再建一个重复 MR。
   */
  private async ensureMergeRequest(
    turnId: string,
    conversationId: string,
    projectId: number,
    sourceBranch: string,
    targetBranch: string,
    sha: string,
    gitlab: GitLabClient,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.config.agent.autoCreateMergeRequest || sourceBranch === targetBranch) return;
    try {
      const open = await gitlab.listMergeRequests(projectId, { state: "opened", perPage: 100 }, signal);
      if (open.some((mr) => mr.sourceBranch === sourceBranch && mr.targetBranch === targetBranch)) return;
      const title = this.store.getConversation(conversationId)?.title?.trim() || `Corvex: ${sourceBranch}`;
      const created = await gitlab.createMergeRequest(projectId, {
        title,
        sourceBranch,
        targetBranch,
        description: `Opened automatically by Corvex after publishing ${sha.slice(0, 12)}.\nConversation: ${conversationId}`,
      }, signal);
      const text = this.config.agent.responseLanguage === "zh-CN"
        ? `已将 ${sha.slice(0, 12)} 发布到 ${sourceBranch}，并自动创建合并请求 ${created.webUrl}（目标分支 ${targetBranch}）。`
        : `Published ${sha.slice(0, 12)} to ${sourceBranch} and opened merge request ${created.webUrl} (target ${targetBranch}).`;
      this.publishStream(turnId, {
        type: "context",
        context: { id: `${turnId}-merge-request-${sha.slice(0, 8)}`, text },
      });
    } catch (error) {
      const reason = errorMessage(error);
      console.warn("auto create merge request failed", {
        conversationId, sourceBranch, targetBranch, error: reason,
      });
      // 模型已被告知不要自己建 MR，因此失败必须告诉操作人员，避免没人发现没有 MR。
      this.publishStream(turnId, {
        type: "context",
        context: {
          id: `${turnId}-merge-request-failed-${sha.slice(0, 8)}`,
          text: this.config.agent.responseLanguage === "zh-CN"
            ? `已发布到 ${sourceBranch}，但自动创建合并请求失败：${reason}。请检查权限或手动创建。`
            : `Published to ${sourceBranch}, but automatic merge request creation failed: ${reason}. Check permissions or create it manually.`,
        },
      });
    }
  }

  /**
   * 记录分支被别人推进的具体提交：写一条 context 轨迹供 Trace 查看，并把作者/标题
   * 放进轮次失败原因。GitLab 提交详情查询失败时退回分支接口自带的标题，不改变 stale 终态。
   */
  private async recordStaleConflict(
    turn: ConversationTurnContext,
    gitlab: GitLabClient,
    branch: GitLabBranch,
    stepContext: { turnId: string; attempt: number },
    signal: AbortSignal,
  ): Promise<void> {
    let detail: StaleConflictDetail = {
      title: branch.commit.title,
      committedDate: branch.commit.committed_date,
    };
    try {
      const commit = await gitlab.getCommit(turn.projectId, branch.commit.id, signal);
      detail = {
        authorName: commit.authorName,
        title: commit.title || detail.title,
        committedDate: commit.committedDate || detail.committedDate,
      };
    } catch (error) {
      detail = { ...detail, lookupError: errorMessage(error).slice(0, 200) };
    }
    const note = buildStaleConflictNote(turn.headSha, branch.commit.id, turn.targetBranch, detail);
    const traceId = this.store.startTrace(
      stepContext,
      turn.attempt,
      "context",
      note.traceName,
      "",
      note.input,
      { input: note.input },
    );
    this.store.finishTrace(traceId, "failed", 0, undefined, undefined, undefined, note.output);
    this.store.failConversationTurn(turn.turnId, "stale", note.message);
  }

  private async execute(
    turn: ConversationTurnContext,
    signal: AbortSignal,
    gitlab: GitLabClient,
    language: ResponseLanguage,
    agent: PiAgent,
    steer: SteerChannel,
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
        await this.recordStaleConflict(turn, gitlab, branch, stepContext, signal);
        return;
      }
      // 基线是「本地未发布改动的父提交」，与只用于过期检测的轮次快照分开维护：
      // 没有未发布改动时，远端快照就是新基线；有改动时保留原基线，直到成功 publish 才前进。
      const conversation = this.store.getConversation(turn.conversationId);
      if (!conversation) {
        this.store.failConversationTurn(turn.turnId, "stale", "The conversation no longer exists.");
        return;
      }
      const unpublished = await this.repo.getConversationChanges(turn.projectId, turn.conversationId, signal);
      const baseSha = resolveTurnBaseSha(
        conversation.baseSha, conversation.baseBranch, turn.headSha, turn.targetBranch, Boolean(unpublished),
      );
      if (baseSha !== conversation.baseSha) {
        this.store.setConversationBaseSha(turn.conversationId, baseSha, conversation.baseBranch || turn.targetBranch);
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
        { projectId: turn.projectId, conversationId: turn.conversationId, expectedHeadSha: baseSha },
        () => this.repo.prepareConversationWorkspace(
          turn.projectId,
          turn.conversationId,
          repositoryCloneUrl(this.config.gitlab.baseUrl, project),
          baseSha,
          signal,
          gitlab.authToken,
          this.submoduleOptions(turn.turnId),
        ),
        (value) => ({ projectId: value.projectId, conversationId: turn.conversationId, headSha: value.headSha, submodules: value.submodules }),
      );
      this.workspaces.set(turn.conversationId, { workspace, lastUsedAt: Date.now() });
      const trace: TraceContext = {
        scope: { turnId: turn.turnId },
        attempt: turn.attempt,
        taskType: "conversation",
        workspace,
      };
      // 斜杠指令按当前用户可见的技能模板展开；命令名不进入发给模型的请求。
      if (this.registry) {
        const owner = this.store.getConversation(turn.conversationId)?.ownerUserId ?? "";
        await this.registry.ensureUser(owner);
        await this.registry.refreshIfStale(owner);
      }
      const { effectiveRequest } = resolveCommandRequest(turn.request, this.skillLookup(turn.conversationId));
      const systemPrompt = getConversationSystemPrompt(language, turn.mode, this.config.agent.followupsEnabled);
      // 注入过去轮次真实执行过的工具调用与结果：历史只带文本，「说过」不等于「做过」。
      // 取最近若干轮，避开早期被裁剪的长轨迹；上限由 buildToolEvidence 统一约束。
      const historyTurnIds = turn.history
        .filter((message) => message.role === "assistant" && message.turnId)
        .map((message) => message.turnId!)
        .slice(-10);
      const toolEvidence = buildToolEvidence(this.store.getToolEvidence(historyTurnIds));
      const uploadContext = buildUploadContext(this.store.getTurnUploads(turn.turnId), this.config.storage.root, language);
      // 图片只在视觉模型开启时转成多模态内容；否则明确告知用户，避免"上传了但没看到"的困惑。
      const imageUploads = uploadContext.uploads.filter((item) => item.mime.startsWith("image/"));
      const images: { data: string; mimeType: string; filename: string }[] = [];
      let imageNotice = "";
      if (imageUploads.length > 0 && !this.config.agent.visionEnabled) {
        imageNotice = language === "zh-CN"
          ? "\n\n[本轮上传的图片未发送给模型：当前模型不支持图片输入。]"
          : "\n\n[Uploaded images were not sent: the current model does not support image input.]";
      } else {
        let totalBytes = 0;
        const budget = imageUploadMaxBytes * maxImagesPerMessage;
        for (const item of imageUploads.slice(0, maxImagesPerMessage)) {
          const bytes = await readFileFs(item.filePath);
          if (bytes.length > imageUploadMaxBytes || totalBytes + bytes.length > budget) continue;
          totalBytes += bytes.length;
          images.push({ data: bytes.toString("base64"), mimeType: item.mime, filename: item.filename });
        }
      }
      const userPrompt = buildConversationPrompt({
        repository: {
          project: turn.projectName,
          branch: turn.targetBranch,
          headSha: turn.headSha,
        },
        summary: turn.summary,
        currentRequest: effectiveRequest,
        toolEvidence,
      }) + (uploadContext.manifest ? `\n\n${uploadContext.manifest}` : "") + imageNotice;
      // 出站前按 token 预算裁剪历史：注入多少由预算决定，而不是由条数决定，
      // 否则 30 条 × 20K 字符的历史足以撑爆任何窗口。预算同时受
      // `agent.max_input_tokens` 约束，使这个配置真正限制单次请求的输入。
      const tokenCounter = createProviderTokenCounter(this.config.agent.baseUrl);
      const fixedText = `${systemPrompt}\n${userPrompt}`;
      const countedFixed = await tokenCounter.count(fixedText, signal);
      this.store.recordContextMetric(countedFixed === undefined ? "token_count_fallback" : "token_count_real", 1);
      const fixedTokens = countedFixed ??
        estimateConservativeTokens(systemPrompt) + estimateConservativeTokens(userPrompt);
      const historyBudget = resolveHistoryBudgetTokens(this.config.agent, fixedTokens);
      // 真实 token 计数优先；模型服务不支持 /tokenize 时回退到保守字节估算。
      const measured = await Promise.all(turn.history.map((message) => tokenCounter.count(message.content, signal)));
      const counts = new Map(turn.history.map((message, index) => [message, measured[index]] as const));
      const { messages: history, dropped } = trimHistory(
        turn.history,
        historyBudget,
        (message) => counts.get(message) ?? estimateConservativeTokens(message.content),
      );
      if (dropped.length > 0) {
        console.info("conversation history trimmed to fit the token budget", {
          turnId: turn.turnId,
          dropped: dropped.length,
          kept: history.length,
        });
      }
      // 技能视图按会话拥有者派生：全局 + 个人，别名与 Pi 的资源加载顺序一致。
      const skillUserId = this.store.getConversation(turn.conversationId)?.ownerUserId ?? "";
      const globalSkillRoot = resolve(this.config.storage.root, "skills");
      const personalSkillRoot = resolve(this.config.storage.root, "user-skills", skillUserId);
      const skillAliases = assignSkillLabels([
        ...this.config.agent.skillPaths.map((path) => resolve(path)),
        globalSkillRoot,
        personalSkillRoot,
      ]);
      const globalAlias = skillAliases.at(-2) ?? "skills";
      const personalAlias = skillAliases.at(-1) ?? "me";
      if (this.registry) {
        await mkdir(personalSkillRoot, { recursive: true, mode: 0o700 });
      }
      const visibleSkills = this.registry
        ? this.registry.listForUser(skillUserId)
        : this.skills.listCached().map((skill) => ({ ...skill, scope: "global" as const, commandName: skill.name }));
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
              conversationId: turn.conversationId,
              turnId: turn.turnId,
              actorId: turn.actorId,
              // 历史回查工具固定到当前会话，工具参数不接受会话 ID，避免跨会话读取。
              turnTools: {
                listTurns: (limit, before) => this.store.listAgentTurns(turn.conversationId, limit, before),
                getTurn: (index) => this.store.getAgentTurn(turn.conversationId, index),
              },
              // 技能目录与命令只取当前用户可见的合并视图；执行开关与后端仍由配置决定。
              ...(this.registry
                ? {
                    managedSkillRoots: [
                      { path: globalSkillRoot, alias: globalAlias },
                      { path: personalSkillRoot, alias: personalAlias },
                    ],
                    managedSkills: visibleSkills
                      .filter((skill) => skill.enabled && skill.status !== "missing")
                      .map((skill) => ({
                        name: skill.name,
                        commandName: skill.commandName,
                        description: skill.description,
                        skillFile: skill.skillFile || "SKILL.md",
                        alias: skill.scope === "global" ? globalAlias : personalAlias,
                        scope: skill.scope,
                        disableModelInvocation: skill.disableModelInvocation,
                      })),
                  }
                : {}),
              skillCommandCatalog: {
                get: (name) => visibleSkills.find((skill) => skill.commandName === name && skill.status !== "missing"),
                available: () => visibleSkills
                  .filter((skill) => skill.commandsEnabled && skill.status !== "missing")
                  .flatMap((skill) => (skill.commands ?? []).map((command) => ({
                    skill: skill.commandName, command: command.name, description: command.description,
                  }))),
              },
              gitlab,
              // 上传目录作为仅本轮有效的只读根注入；模型侧只看到 upload://<id>/<filename>。
              uploads: uploadContext.uploads.map(({ id, rootPath }) => ({ id, rootPath })),
              images,
              systemPrompt,
              userPrompt,
              history,
              // 正文与思考在落库前先推送给控制台；轮次完成后由 done 事件触发刷新。
              onTextDelta: (update) =>
                this.publishStream(turn.turnId, { type: "text", reset: update.reset, text: update.text }),
              onThinkingDelta: (update) =>
                this.publishStream(turn.turnId, { type: "thinking", reset: update.reset, text: update.text }),
              onToolDelta: (tool) => this.publishStream(turn.turnId, { type: "tool", tool }),
              onSteerStatus: (status) => {
                const text = this.steerTexts.get(turn.turnId) ?? "";
                if (status === "delivered") this.steerTexts.delete(turn.turnId);
                this.publishStream(turn.turnId, { type: "interjection", turnId: turn.turnId, status, text });
              },
              onScheduleCard: (card) => this.publishStream(turn.turnId, { type: "scheduled_task_card", card }),
              onContextDelta: (context) => this.publishStream(turn.turnId, { type: "context", context }),
              onExecStart: (execId, stop) => this.execStops.set(execId, { turnId: turn.turnId, stop }),
              onExecEnd: (execId) => this.execStops.delete(execId),
              onExecDelta: (delta) => this.publishStream(turn.turnId, { type: "exec", ...delta }),
              steer,
              fs: this.workspaceFs(workspace.path, workspace.submodules ?? []),
              ...(conversationCapabilities(turn.mode).gitToolset
                ? { gitTools: this.gitTools(workspace, turn.conversationId, turn.turnId, turn.targetBranch, gitlab, signal) }
                : {}),
            },
            workspace.path,
            signal,
            trace,
          ),
          (value) => ({ model: value.model, usage: value.usage, textBytes: Buffer.byteLength(value.content) }),
        );
      } catch (error) {
        this.store.recordModelCall("conversation", "failure", Date.now() - started, 0, 0);
        // 失败的轮次里模型也可能已经写入文件；取消信号已中止时用无信号保存，
        // 否则这些改动会随下一次 worktree 淘汰而丢失。
        await this.persistChanges(workspace, turn.conversationId, turn.turnId, signal.aborted ? undefined : signal);
        throw error;
      }
      this.store.recordModelCall("conversation", "success", Date.now() - started, answer.usage.inputTokens, answer.usage.outputTokens);
      // 确定性兜底：回答声称「已发布 / 已评论 / 已合并」但本轮没有对应工具调用时，
      // 追加一条 context 警告进入过程快照。提示词是软约束，这里是代码级硬校验。
      const toolEntries = this.store.getTraceEntries({ turnId: turn.turnId }, turn.attempt)
        .filter((entry) => entry.kind === "tool");
      const turnTools = toolEntries.map((entry) => entry.name);
      // 只有本轮真的执行过命令才做有界大小扫描；普通问答不承担扫描开销。
      if (turnTools.includes("run_command")) {
        void this.checkWorkspaceSize(workspace, turn.conversationId, turn.turnId, turn.actorId);
      }
      const successfulTools = toolEntries
        .filter((entry) => entry.status === "succeeded")
        .map((entry) => entry.name);
      const claim = verifyAnswerClaims(answer.content, turnTools, language, new Set(), new Set(successfulTools));
      if (claim.unverified.length > 0) {
        this.publishStream(turn.turnId, {
          type: "context",
          context: { id: `unverified-${turn.turnId}`, text: claim.detail },
        });
        console.warn("unverified claims in conversation answer", {
          turnId: turn.turnId,
          claims: claim.unverified,
        });
      }
      await this.persistChanges(workspace, turn.conversationId, turn.turnId, signal);
      const parsed = this.config.agent.followupsEnabled
        ? parseFollowups(answer.content, this.config.agent.followupsCount)
        : { content: answer.content, suggestions: [] };
      this.store.finishConversationTurn(turn.turnId, parsed.content, answer.model, parsed.suggestions, {
        read: answer.usage.cacheReadTokens,
        write: answer.usage.cacheWriteTokens,
      });
      this.store.saveConversationTurnProcess(turn.turnId, this.collectProcess(turn.turnId, answer.content));
      // 先展示创建时从用户消息派生的标题；done 后再用 LLM 精炼，失败则保留原标题。
      this.publishStream(turn.turnId, { type: "done", status: "completed" });
      void this.refineTitle(turn, workspace.path, signal, trace, language);
      await this.updateSummary(turn, dropped, workspace.path, signal, language, answer.compactionSummary);
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
