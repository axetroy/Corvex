import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { applyActiveModel, applyRuntimeSettingRows, copyRuntimeSettings } from "../config/settings.js";
import { errorMessage } from "../errors.js";
import { FixWorkflow } from "../fix/workflow.js";
import { ImplementWorkflow } from "../implement/workflow.js";
import { GitManager, GitPushError } from "../git/manager.js";
import type { DiffResult, Workspace } from "../git/types.js";
import type { Event, EventStatus } from "../events/model.js";
import { EventStore } from "../events/store.js";
import { GitLabApiError, GitLabClient, GitLabWriteError, repositoryCloneUrl, type MergeRequest } from "../gitlab/client.js";
import { maxAgentUserPromptBytes, PiAgent, type EventTraceContext } from "../agent/pi.js";
import { ReviewWorkflow, type Finding, type ReviewContext } from "../review/workflow.js";
import { traceExecutionStep } from "../events/execution.js";

/** Worker 事件租约时长，单位为毫秒；执行期间按该时长的三分之一续租。 */
const leaseMs = 30_000;
/** 自动重试时按事件尝试序号递增的基础退避时长，单位为毫秒。 */
const automaticRetryBaseDelayMs = 2_000;
/** 自动重试退避的最大等待时长，单位为毫秒。 */
const automaticRetryMaxDelayMs = 30_000;
/** 视为瞬时故障的 HTTP 状态码；鉴权、校验和其他客户端错误不重试。 */
const retryableHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Node.js/Undici 常见的短暂网络错误码。 */
const retryableNetworkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
/** Git CLI 在远端网络故障时可能返回文本而非系统错误码。 */
const retryableNetworkMessage = /network error|connection (?:reset|refused|timed out)|could not resolve host|failed to connect|remote end hung up unexpectedly|tls connection.*(?:timeout|terminated)/i;
function isRetryableEventFailure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    const value = current as {
      cause?: unknown;
      code?: unknown;
      errors?: unknown;
      message?: unknown;
      name?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    const status = value instanceof GitLabApiError
      ? value.status
      : typeof value.status === "number"
        ? value.status
        : value.statusCode;
    if (typeof status === "number" && retryableHttpStatuses.has(status)) return true;
    if (typeof value.code === "string" && retryableNetworkCodes.has(value.code)) return true;
    if (value.name === "TimeoutError") return true;
    if (typeof value.message === "string" && retryableNetworkMessage.test(value.message)) return true;
    if (value.cause !== undefined) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return false;
}

function automaticRetryDelay(attemptCount: number): number {
  return Math.min(automaticRetryMaxDelayMs, automaticRetryBaseDelayMs * 2 ** Math.max(0, attemptCount - 1));
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details: string[] = [];
  const seen = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    details.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (current !== undefined) details.push(String(current));
  return details.join("\nCaused by: ");
}

export class Worker {
  private readonly workerId = randomUUID();
  private readonly repo: GitManager;
  private reviewer!: ReviewWorkflow;
  private fixer!: FixWorkflow;
  private implementer!: ImplementWorkflow;
  private readonly agent: PiAgent;
  private contextByteLimit!: number;
  /** 配置文件基线：每次热加载先复位可覆盖字段，删除覆盖项后立即回到文件值。 */
  private readonly baseline: CorvexConfig;
  /** 上次应用的覆盖项签名；相同则跳过重建流程对象。 */
  private runtimeSignature = "";

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    private readonly gitlab: GitLabClient,
  ) {
    if (!config.agent.enabled) throw new Error("worker mode requires agent.enabled=true");
    this.baseline = structuredClone(config);
    this.repo = new GitManager(
      config.storage.root,
      config.gitlab.baseUrl,
      config.gitlab.readToken,
      config.gitlab.writeToken,
    );
    this.agent = new PiAgent(
      config,
      store,
      this.repo,
      (projectId, mrIid, limit, signal) => this.gitlab.getMergeRequestComments(projectId, mrIid, limit, signal),
      (projectId, mrIid, update, signal) => this.gitlab.updateMergeRequest(projectId, mrIid, update, signal),
      this.repo,
    );
    this.buildWorkflows();
  }

  /**
   * 按当前配置重建依赖构造期参数的流程对象。审查文件上限、发现的严重级别数量、
   * diff 字节上限与批量并发都在构造函数里读取，运行时设置变更后必须重建。
   */
  private buildWorkflows(): void {
    const config = this.config;
    this.contextByteLimit = Math.min(config.review.maxContextBytes, maxAgentUserPromptBytes);
    this.reviewer = new ReviewWorkflow(
      this.agent,
      config.review.maxFiles,
      config.review.maxFindings,
      this.contextByteLimit,
      config.agent.responseLanguage,
      config.review.batchConcurrency,
    );
    this.fixer = new FixWorkflow(
      this.agent,
      this.contextByteLimit,
      config.fix.maxPatchBytes,
      config.agent.responseLanguage,
    );
    this.implementer = new ImplementWorkflow(
      this.agent,
      this.contextByteLimit,
      config.fix.maxPatchBytes,
      config.agent.responseLanguage,
    );
  }

  /**
   * 从数据库读取运行时覆盖项并热加载。Server 写入后 Worker 在下一次轮询时生效，
   * 不需要重启；签名未变化时只做一次字符串比较，避免每轮重建对象。
   */
  private refreshRuntimeSettings(): void {
    try {
      const rows = this.store.listRuntimeSettings();
      const active = this.store.getActiveModel();
      const modelSignature = active
        ? `${active.provider.id}:${active.provider.baseUrl}:${active.provider.apiKey}:${active.model.id}:${active.model.name}:${active.model.contextWindow}:${active.model.maxOutputTokens}`
        : "";
      const signature = `${rows.map((row) => `${row.key}=${row.value}`).join("\n")}\n${modelSignature}`;
      if (signature === this.runtimeSignature) return;
      // 先复位到配置文件基线，再叠加覆盖：删除的键因此立即回到文件值。
      copyRuntimeSettings(this.baseline, this.config);
      const applied = applyRuntimeSettingRows(this.config, rows);
      if (active) applyActiveModel(this.config, active);
      this.runtimeSignature = signature;
      this.buildWorkflows();
      console.info("worker applied runtime settings", { keys: applied });
    } catch (error) {
      console.error("refresh runtime settings failed", { error: errorMessage(error) });
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.repo.initialize();
    try {
      const migrated = this.store.migrateLegacyModelSettings(
        { contextWindow: this.config.agent.contextWindow, maxOutputTokens: this.config.agent.maxOutputTokens },
        0,
      );
      if (migrated) {
        console.info("worker migrated legacy model settings", {
          provider: migrated.provider.name,
          model: migrated.model.name,
        });
      }
    } catch (error) {
      console.error("migrate legacy model settings failed", { error: errorMessage(error) });
    }
    console.info("Corvex worker started", { pollIntervalMs: this.config.worker.pollInterval });
    while (!signal.aborted) {
      this.refreshRuntimeSettings();
      try {
        this.store.heartbeatWorker(this.workerId);
      } catch (error) {
        console.error("update worker heartbeat failed", { error: errorMessage(error) });
      }
      let event: Event | undefined;
      try {
        event = this.store.claimNextWithLease(leaseMs);
      } catch (error) {
        console.error("claim worker event failed", { error: errorMessage(error) });
      }
      if (event) {
        console.info("Corvex worker claimed event", {
          eventId: event.id,
          type: event.type,
          projectId: event.projectId,
          mrIid: event.mrIid,
          targetType: event.targetType,
          targetIid: event.targetIid,
          status: event.status,
        });
        await this.process(event, signal);
        continue;
      }
      try {
        await sleep(this.config.worker.pollInterval, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }

  private async process(event: Event, shutdownSignal: AbortSignal): Promise<void> {
    let stage: EventStatus = event.status;
    const controller = new AbortController();
    const eventSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.config.worker.eventTimeout),
      shutdownSignal,
    ]);
    const onShutdown = () => controller.abort(new Error("worker shutting down"));
    shutdownSignal.addEventListener("abort", onShutdown, { once: true });
    const heartbeat = this.maintainLease(event, eventSignal, controller);
    let processingError: unknown;
    try {
      await this.execute(event, eventSignal, (next) => {
        const previous = stage;
        this.store.updateLeasedStatus(event.id, event.leaseToken, stage, next);
        stage = next;
        console.info("Corvex worker event status changed", {
          eventId: event.id,
          type: event.type,
          projectId: event.projectId,
          mrIid: event.mrIid,
          targetType: event.targetType,
          targetIid: event.targetIid,
          from: previous,
          to: next,
        });
      });
    } catch (error) {
      processingError = error;
    } finally {
      controller.abort();
      shutdownSignal.removeEventListener("abort", onShutdown);
      await heartbeat;
    }
    if (!processingError) {
      console.info("Corvex worker event completed", {
        eventId: event.id,
        type: event.type,
        projectId: event.projectId,
        mrIid: event.mrIid,
        targetType: event.targetType,
        targetIid: event.targetIid,
      });
      return;
    }
    // 进程关闭时保留租约，由过期租约恢复事件，避免把中断误记为事件失败。
    if (shutdownSignal.aborted) {
      console.warn("worker stopped during event; lease will recover it", {
        eventId: event.id,
        error: errorMessage(processingError),
      });
      return;
    }
    // 事件已到达终态（stale / cancelled / failed / completed）时，
    // 状态转换在 execute() 内已完成，无需再尝试标记失败，避免无效转换。
    if (stage === "stale" || stage === "cancelled" || stage === "failed" || stage === "completed") {
      console.info("worker event already in terminal state after error; no further recovery needed", {
        eventId: event.id,
        stage,
        error: errorMessage(processingError),
      });
      return;
    }
    try {
      if (this.store.cancellationRequested(event.id, event.leaseToken)) {
        this.store.updateLeasedStatus(
          event.id,
          event.leaseToken,
          stage,
          "cancelled",
          `Cancellation requested by task owner: ${errorDetails(processingError)}`,
        );
        return;
      }
    } catch (leaseError) {
      if (errorMessage(leaseError) !== errorMessage(processingError)) {
        console.error("could not check cancellation after event failure", {
          eventId: event.id,
          error: errorMessage(leaseError),
        });
      }
    }
    if (
      stage !== "publishing" &&
      (isRetryableEventFailure(processingError) || eventSignal.reason?.name === "TimeoutError")
    ) {
      const delayMs = automaticRetryDelay(event.attemptCount);
      const availableAt = Date.now() + delayMs;
      try {
        if (this.store.retryLeasedEvent(
          event.id,
          event.leaseToken,
          stage,
          availableAt,
          errorDetails(processingError),
        )) {
          console.warn("transient worker event failure; automatic retry scheduled", {
            eventId: event.id,
            attempt: event.attemptCount,
            retryAt: new Date(availableAt).toISOString(),
            error: errorMessage(processingError),
          });
          return;
        }
      } catch (retryError) {
        console.error("could not schedule automatic worker retry", {
          eventId: event.id,
          error: errorMessage(retryError),
        });
      }
    }
    // 发布请求可能已在 GitLab 生效，自动重试可能产生重复评论。
    const publishingStage = stage === "publishing";
    try {
      this.store.updateLeasedStatus(event.id, event.leaseToken, stage, "failed", errorDetails(processingError));
    } catch (statusError) {
      if (publishingStage) {
        console.error("publishing outcome is uncertain; no automatic retry will be attempted", {
          eventId: event.id,
          error: errorMessage(statusError),
        });
      } else {
        console.error("could not mark event failed", {
          eventId: event.id,
          error: errorMessage(statusError),
          processingError: errorMessage(processingError),
        });
      }
    }
    console.error("process worker event failed", { eventId: event.id, error: errorMessage(processingError) });
  }

  private async maintainLease(
    event: Event,
    signal: AbortSignal,
    controller: AbortController,
  ): Promise<void> {
    let elapsed = 0;
    while (!signal.aborted) {
      try {
        await sleep(1000, undefined, { signal });
      } catch {
        if (signal.aborted) return;
        throw new Error("worker heartbeat wait failed");
      }
      try {
        if (this.store.cancellationRequested(event.id, event.leaseToken)) {
          controller.abort(new Error("event cancellation requested"));
          return;
        }
        elapsed += 1000;
        if (elapsed >= leaseMs / 3) {
          // 提前续租，为调度延迟留出余量，避免其他 worker 抢占事件。
          this.store.renewLease(event.id, event.leaseToken, leaseMs);
          this.store.heartbeatWorker(this.workerId);
          elapsed = 0;
        }
      } catch (error) {
        controller.abort(new Error(`maintain event lease: ${errorMessage(error)}`, { cause: error }));
        return;
      }
    }
  }

  private async execute(
    event: Event,
    signal: AbortSignal,
    transition: (status: EventStatus) => void,
  ): Promise<void> {
    const trace: EventTraceContext = {
      scope: { kind: "event", eventId: event.id },
      attempt: event.attemptCount,
      taskType: event.type,
    };
    const stepContext = { eventId: event.id, attempt: event.attemptCount };
    if (!["review", "fix", "explain", "chat", "implement"].includes(event.type)) {
      throw new Error(`unsupported task type "${event.type}"`);
    }
    if (event.type === "fix" && !this.config.fix.enabled) {
      throw new Error("fix task cannot run because fix mode is disabled");
    }
    if (event.type === "implement") {
      if (event.targetType !== "issue") throw new Error("Issue task has an invalid target type");
      await this.executeIssueImplementation(event, signal, transition);
      return;
    }
    if (event.targetType !== "merge_request") throw new Error("MR task has an invalid target type");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(event.headSha)) {
      this.store.recordExecutionStep({
        ...stepContext,
        step: "worker.validate_head_sha",
        status: "ignored",
        input: { expectedHeadSha: event.headSha, actualHeadSha: event.headSha },
        output: { accepted: false, reason: "invalid_head_sha" },
      });
      transition("stale");
      return;
    }
    const mergeRequest = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_merge_request",
      { projectId: event.projectId, mrIid: event.mrIid },
      () => this.gitlab.getMergeRequest(event.projectId, event.mrIid, signal),
      (value) => ({
        iid: value.iid,
        state: value.state,
        title: value.title,
        description: value.description,
        sourceBranch: value.source_branch,
        targetBranch: value.target_branch,
        sha: value.sha,
        diffRefs: value.diff_refs,
      }),
    );
    trace.mergeRequest = {
      projectId: event.projectId,
      mrIid: event.mrIid,
      sourceProjectId: mergeRequest.source_project_id,
      targetProjectId: mergeRequest.target_project_id,
      sourceBranch: mergeRequest.source_branch,
      expectedRemoteSha: event.headSha,
    };
    if (mergeRequest.state !== "opened") {
      this.store.recordExecutionStep({
        ...stepContext,
        step: "worker.validate_mr_state",
        status: "ignored",
        input: { state: mergeRequest.state },
        output: { accepted: false, reason: "merge_request_not_opened" },
      });
      transition("stale");
      return;
    }
    if (!sameSha(headSha(mergeRequest), event.headSha)) {
      this.store.recordExecutionStep({
        ...stepContext,
        step: "worker.validate_head_sha",
        status: "ignored",
        input: { expectedHeadSha: event.headSha, actualHeadSha: headSha(mergeRequest) },
        output: { accepted: false, reason: "head_sha_changed" },
      });
      transition("stale");
      return;
    }
    const baseSha = mergeRequest.diff_refs.base_sha;
    if (!baseSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseSha)) {
      throw new Error("GitLab did not provide the MR base SHA");
    }
    const project = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_project",
      { projectId: event.projectId },
      () => this.gitlab.getProject(event.projectId, signal),
      (value) => ({ id: value.id, repositoryUrl: repositoryCloneUrl(this.config.gitlab.baseUrl, value) }),
    );
    if (trace.mergeRequest) trace.mergeRequest.repositoryUrl = repositoryCloneUrl(this.config.gitlab.baseUrl, project);
    // 差异比较以 GitLab 报告的 base SHA 为基准，它不一定在抓取 head 时一并到达，
    // 因此显式确保该快照存在；命中本地对象库时不联网。
    await traceExecutionStep(
      this.store,
      stepContext,
      "git.ensure_base_sha",
      { projectId: event.projectId, baseSha },
      () => this.repo.ensureCommitAvailable(event.projectId, repositoryCloneUrl(this.config.gitlab.baseUrl, project), baseSha, signal),
      () => ({ baseSha }),
    );
    const workspace = await traceExecutionStep(
      this.store,
      stepContext,
      "git.prepare_workspace",
      { projectId: event.projectId, eventId: event.id, repositoryUrl: repositoryCloneUrl(this.config.gitlab.baseUrl, project), expectedHeadSha: event.headSha },
      () => this.repo.prepareWorkspace(
        event.projectId,
        event.id,
        repositoryCloneUrl(this.config.gitlab.baseUrl, project),
        event.headSha,
        signal,
      ),
      (value) => ({ projectId: value.projectId, eventId: value.eventId, headSha: value.headSha }),
    );
    trace.workspace = workspace;
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      await traceExecutionStep(
        this.store,
        stepContext,
        "git.cleanup_workspace",
        { projectId: workspace.projectId, eventId: workspace.eventId },
        () => this.repo.cleanupWorkspace(workspace),
        () => ({ cleaned: true }),
      );
      cleaned = true;
    };
    try {
      const context = createReviewContext(event, mergeRequest, baseSha);
      if (event.type === "explain") {
        const content = await traceExecutionStep(
          this.store,
          stepContext,
          "git.read_file",
          { path: event.request, maxBytes: this.contextByteLimit, headSha: workspace.headSha },
          () => this.repo.readFile(
            workspace,
            event.request,
            this.contextByteLimit,
            signal,
          ),
          (value) => ({ bytes: value.byteLength, sha256: createHash("sha256").update(value).digest("hex") }),
        );
        transition("analyzing");
        const started = Date.now();
        let explanation;
        try {
          explanation = await traceExecutionStep(
            this.store,
            stepContext,
            "workflow.explain",
            { path: event.request, contentBytes: content.byteLength },
            () => this.reviewer.explain(
              context,
              event.request,
              content,
              workspace.path,
              signal,
              trace,
            ),
            (value) => ({ model: value.model, usage: value.usage, textBytes: Buffer.byteLength(value.text) }),
          );
          this.store.recordModelCall(
            "explain",
            "success",
            Date.now() - started,
            explanation.usage.inputTokens,
            explanation.usage.outputTokens,
          );
        } catch (error) {
          this.store.recordModelCall("explain", "failure", Date.now() - started, 0, 0);
          throw error;
        }
        if (!(await this.verifySnapshot(event, mergeRequest, signal, transition))) return;
        transition("publishing");
        const body = `## Corvex explanation for \`${escapeMarkdown(event.request)}\`\n\n${escapeMarkdown(explanation.text)}`;
        await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.post_note",
          { projectId: event.projectId, mrIid: event.mrIid, body },
          () => this.gitlab.postNote(event.projectId, event.mrIid, body, signal),
          (receipt) => receipt,
          (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
        );
        transition("completed");
        return;
      }

      const diff = await traceExecutionStep(
        this.store,
        stepContext,
        "git.create_diff",
        { baseSha, headSha: workspace.headSha, maxFiles: this.config.review.maxFiles, maxBytes: this.contextByteLimit },
        () => this.repo.diff(
          workspace,
          baseSha,
          this.config.review.maxFiles,
          this.contextByteLimit,
          signal,
        ),
        (value) => ({
          baseSha: value.baseSha,
          headSha: value.headSha,
          skippedFiles: value.skippedFiles,
          changes: value.changes.map(({ path, status, addedLines, removedLines, patch, skipped }) => ({
            path,
            status,
            addedLines,
            removedLines,
            patchBytes: Buffer.byteLength(patch),
            skipped,
          })),
        }),
      );
      if (event.type === "fix") {
        await this.executeFix(event, mergeRequest, workspace, diff, context, signal, transition, cleanup);
        return;
      }
      if (event.type === "chat") {
        transition("analyzing");
        const started = Date.now();
        let answer;
        try {
          const comments = this.config.chat.historyComments > 0
            ? await traceExecutionStep(
                this.store,
                stepContext,
                "gitlab.get_merge_request_comments",
                { projectId: event.projectId, mrIid: event.mrIid, limit: this.config.chat.historyComments },
                () => this.gitlab.getMergeRequestComments(
                  event.projectId,
                  event.mrIid,
                  this.config.chat.historyComments,
                  signal,
                ),
                (value) => ({ count: value.length, ids: value.map((comment) => comment.id) }),
              )
            : [];
          answer = await traceExecutionStep(
            this.store,
            stepContext,
            "workflow.chat",
            { baseSha, headSha: workspace.headSha, request: event.request },
            () => this.reviewer.chat(context, diff, event.request, workspace.path, signal, trace, comments),
            (value) => ({ model: value.model, usage: value.usage, textBytes: Buffer.byteLength(value.text) }),
          );
          this.store.recordModelCall(
            "chat",
            "success",
            Date.now() - started,
            answer.usage.inputTokens,
            answer.usage.outputTokens,
          );
        } catch (error) {
          this.store.recordModelCall("chat", "failure", Date.now() - started, 0, 0);
          throw error;
        }
        const chatSnapshotIsCurrent = trace.mergeRequest?.pushedSha
          ? await this.verifyPushedHead(event, mergeRequest, trace.mergeRequest.pushedSha, signal, transition)
          : await this.verifySnapshot(event, mergeRequest, signal, transition);
        if (!chatSnapshotIsCurrent) return;
        transition("publishing");
        const body = `## Corvex\n\n${answer.text}`;
        await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.post_note",
          { projectId: event.projectId, mrIid: event.mrIid, body },
          () => this.gitlab.postNote(event.projectId, event.mrIid, body, signal),
          (receipt) => receipt,
          (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
        );
        transition("completed");
        return;
      }
      transition("analyzing");
      const started = Date.now();
      let outcome;
      try {
        outcome = await traceExecutionStep(
          this.store,
          stepContext,
          "workflow.review",
          { baseSha, headSha: workspace.headSha, changedFiles: diff.changes.map((change) => change.path) },
          () => this.reviewer.review(context, diff, workspace.path, signal, trace, event.request),
          (value) => ({ model: value.model, usage: value.usage, findings: value.result.findings, rejected: value.rejected }),
        );
        this.store.recordModelCall(
          "review",
          "success",
          Date.now() - started,
          outcome.usage.inputTokens,
          outcome.usage.outputTokens,
        );
      } catch (error) {
        this.store.recordModelCall("review", "failure", Date.now() - started, 0, 0);
        throw error;
      }
      // 模型调用可能超过 MR 快照的有效期；发布前必须再次确认 diff refs 未变化。
      if (!(await this.verifySnapshot(event, mergeRequest, signal, transition))) return;
      transition("publishing");
      let inlinePosted = 0;
      for (const finding of outcome.result.findings) {
        try {
          const body = formatFinding(finding);
          const position = {
              baseSha: mergeRequest.diff_refs.base_sha,
              startSha: mergeRequest.diff_refs.start_sha,
              headSha: event.headSha,
              oldPath: finding.filePath,
              newPath: finding.filePath,
              newLine: finding.line,
            };
          await traceExecutionStep(
            this.store,
            stepContext,
            "gitlab.post_discussion",
            { projectId: event.projectId, mrIid: event.mrIid, body, position },
            () => this.gitlab.postDiscussion(event.projectId, event.mrIid, body, position, signal),
            (receipt) => receipt,
            (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
          );
          inlinePosted++;
        } catch (error) {
          console.warn("inline review comment failed; using summary fallback", {
            eventId: event.id,
            path: finding.filePath,
            line: finding.line,
            error: errorMessage(error),
          });
        }
      }
      const reviewBody = formatReview(event, outcome.result.summary, outcome.result.findings, inlinePosted);
      await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.post_review_summary",
        { projectId: event.projectId, mrIid: event.mrIid, body: reviewBody },
        () => this.gitlab.postNote(event.projectId, event.mrIid, reviewBody, signal),
        (receipt) => receipt,
        (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
      );
      transition("completed");
    } finally {
      await cleanup();
    }
  }

  private async executeIssueImplementation(
    event: Event,
    signal: AbortSignal,
    transition: (status: EventStatus) => void,
  ): Promise<void> {
    if (event.targetIid <= 0) throw new Error("Issue implementation event has an invalid Issue IID");
    const stepContext = { eventId: event.id, attempt: event.attemptCount };
    const issue = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_issue",
      { projectId: event.projectId, issueIid: event.targetIid },
      () => this.gitlab.getIssue(event.projectId, event.targetIid, signal),
      (value) => ({ iid: value.iid, title: value.title, state: value.state, descriptionCharacters: [...value.description].length }),
    );
    if (issue.state !== "opened") {
      this.store.recordExecutionStep({
        ...stepContext,
        step: "worker.validate_issue_state",
        status: "ignored",
        input: { state: issue.state },
        output: { accepted: false, reason: "issue_not_opened" },
      });
      transition("stale");
      return;
    }
    const comments = this.config.issue.historyComments > 0
      ? await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.get_issue_comments",
          { projectId: event.projectId, issueIid: event.targetIid, limit: this.config.issue.historyComments },
          () => this.gitlab.getIssueComments(event.projectId, event.targetIid, this.config.issue.historyComments, signal),
          (value) => ({ count: value.length, ids: value.map((comment) => comment.id), bytes: value.reduce((sum, comment) => sum + Buffer.byteLength(comment.body), 0) }),
        )
      : [];
    const project = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_project",
      { projectId: event.projectId },
      () => this.gitlab.getProject(event.projectId, signal),
      (value) => ({
        id: value.id,
        repositoryUrl: repositoryCloneUrl(this.config.gitlab.baseUrl, value),
        defaultBranch: value.default_branch,
      }),
    );
    if (!project.default_branch?.trim()) throw new Error("GitLab project does not have a default branch");
    let sourceBranch = `corvex/issue-${event.targetIid}-${event.id.slice(0, 8)}-a${event.attemptCount}`;
    const prepareBranch = (targetBranch: string) => traceExecutionStep(
      this.store,
      stepContext,
      "git.prepare_issue_workspace",
      { projectId: event.projectId, eventId: event.id, repositoryUrl: repositoryCloneUrl(this.config.gitlab.baseUrl, project), targetBranch, sourceBranch },
      () => this.repo.prepareIssueWorkspace(event.projectId, event.id, repositoryCloneUrl(this.config.gitlab.baseUrl, project), targetBranch, sourceBranch, signal),
      (value) => ({ projectId: value.workspace.projectId, eventId: value.workspace.eventId, baseSha: value.baseSha, sourceBranch, targetBranch }),
    );
    let prepared = await prepareBranch(project.default_branch);
    let workspace = prepared.workspace;
    const cleanedWorkspaces = new Set<string>();
    const trace: EventTraceContext = {
      scope: { kind: "event", eventId: event.id },
      attempt: event.attemptCount,
      taskType: event.type,
      workspace,
      issue: {
        projectId: event.projectId,
        issueIid: event.targetIid,
        sourceBranch,
        targetBranch: project.default_branch,
        repositoryUrl: repositoryCloneUrl(this.config.gitlab.baseUrl, project),
        expectedTargetSha: prepared.baseSha,
      },
    };
    let targetBranch = project.default_branch;
    const cleanupWorkspace = async (target: Workspace, issueSourceBranch = sourceBranch): Promise<void> => {
      if (cleanedWorkspaces.has(target.path)) return;
      await traceExecutionStep(
        this.store,
        stepContext,
        "git.cleanup_workspace",
        { projectId: target.projectId, eventId: target.eventId, sourceBranch: issueSourceBranch },
        () => this.repo.cleanupWorkspace(target, undefined, issueSourceBranch),
        () => ({ cleaned: true }),
      );
      cleanedWorkspaces.add(target.path);
    };
    const cleanup = async (): Promise<void> => cleanupWorkspace(workspace, sourceBranch);
    try {
      transition("analyzing");
      const decide = async () => {
        const started = Date.now();
        try {
          const outcome = await traceExecutionStep(
            this.store,
            stepContext,
            "workflow.issue_decision",
            { issueIid: issue.iid, baseSha: prepared.baseSha, request: event.request, commentCount: comments.length },
            () => this.implementer.implement({
              projectId: event.projectId,
              issueIid: issue.iid,
              title: issue.title,
              description: issue.description,
              webUrl: issue.web_url,
              defaultBranch: targetBranch,
              baseSha: prepared.baseSha,
              comments,
              implementationEnabled: this.config.issue.implementEnabled,
            }, event.request, workspace.path, signal, trace),
            (value) => value.action === "reply"
              ? { action: value.action, model: value.model, usage: value.usage, replyCharacters: [...value.reply].length }
              : { action: value.action, model: value.model, usage: value.usage, summaryCharacters: [...value.summary].length, patchBytes: Buffer.byteLength(value.patch), targetBranch: value.targetBranch ?? "" },
          );
          this.store.recordModelCall("implement", "success", Date.now() - started, outcome.usage.inputTokens, outcome.usage.outputTokens);
          return outcome;
        } catch (error) {
          this.store.recordModelCall("implement", "failure", Date.now() - started, 0, 0);
          throw error;
        }
      };
      const publishReply = async (body: string): Promise<void> => {
        transition("publishing");
        await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.post_issue_reply",
          { projectId: event.projectId, issueIid: event.targetIid, bodyCharacters: [...body].length },
          () => this.gitlab.postIssueNote(event.projectId, event.targetIid, body, signal),
          (receipt) => receipt,
          (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
        );
        transition("completed");
      };
      let outcome = await decide();
      if (outcome.action === "reply") {
        await publishReply(`## Corvex\n\n${outcome.reply}`);
        return;
      }
      if (!this.config.issue.implementEnabled) {
        const reply = this.config.agent.responseLanguage === "zh-CN"
          ? "管理员尚未启用 Issue 代码实现；我可以继续分析需求和可行性，但不会修改或推送代码。"
          : "Issue code implementation is disabled by the administrator. I can still discuss the request and its feasibility, but will not modify or push code.";
        await publishReply(`## Corvex\n\n${reply}`);
        return;
      }
      const requestedTargetBranch = outcome.targetBranch ?? project.default_branch;
      if (requestedTargetBranch !== project.default_branch) {
        const previousWorkspace = workspace;
        await cleanupWorkspace(previousWorkspace, sourceBranch);
        sourceBranch = `${sourceBranch}-t${createHash("sha256").update(requestedTargetBranch).digest("hex").slice(0, 8)}`;
        targetBranch = requestedTargetBranch;
        if (trace.issue) trace.issue.sourceBranch = sourceBranch;
        prepared = await prepareBranch(targetBranch);
        workspace = prepared.workspace;
        trace.workspace = workspace;
        if (trace.issue) {
          trace.issue.targetBranch = targetBranch;
          trace.issue.expectedTargetSha = prepared.baseSha;
        }
        outcome = await decide();
        if (outcome.action === "reply") {
          await publishReply(`## Corvex\n\n${outcome.reply}`);
          return;
        }
        if (outcome.targetBranch && outcome.targetBranch !== targetBranch) {
          throw new Error("Issue agent selected inconsistent target branches across the pinned workspaces");
        }
      }

      transition("fixing");
      const applied = await traceExecutionStep(
        this.store,
        stepContext,
        "git.apply_issue_patch",
        { patchBytes: Buffer.byteLength(outcome.patch), patchSha256: createHash("sha256").update(outcome.patch).digest("hex") },
        () => this.repo.applyIssuePatch(workspace, outcome.patch, this.config.fix.maxPatchBytes, signal),
        (value) => ({ changedFiles: value.changedFiles, patchBytes: Buffer.byteLength(value.patch) }),
      );
      const commitTitle = `Implement issue #${issue.iid}: ${[...issue.title.replace(/[\r\n]+/g, " ").trim()].slice(0, 140).join("")}`;
      const commit = await traceExecutionStep(
        this.store,
        stepContext,
        "git.commit_issue",
        { message: commitTitle, changedFiles: applied.changedFiles },
        () => this.repo.commitIssueWorkspace(workspace, commitTitle, applied.changedFiles, signal),
        (value) => ({ sha: value.sha, changedFiles: value.changedFiles }),
      );

      transition("verifying");
      const latestIssue = await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.verify_issue_open",
        { projectId: event.projectId, issueIid: event.targetIid },
        () => this.gitlab.getIssue(event.projectId, event.targetIid, signal),
        (value) => ({ iid: value.iid, state: value.state }),
      );
      if (latestIssue.state !== "opened") {
        transition("stale");
        return;
      }
      transition("publishing");
      const pushed = await traceExecutionStep(
        this.store,
        stepContext,
        "git.push_issue_branch",
        { projectId: event.projectId, sourceBranch, targetBranch, sha: commit.sha },
        () => this.repo.pushIssueWorkspace(
          workspace,
          sourceBranch,
          targetBranch,
          repositoryCloneUrl(this.config.gitlab.baseUrl, project),
          prepared.baseSha,
          signal,
        ),
        (value) => value,
        (error) => error instanceof GitPushError ? "unknown" : "failed",
      );
      const titlePrefix = `Implement issue #${issue.iid}: `;
      const mr = await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.create_draft_merge_request",
        { projectId: event.projectId, sourceBranch, targetBranch, sha: pushed.sha },
        () => this.gitlab.createDraftMergeRequest(event.projectId, {
          title: titlePrefix + [...issue.title.trim()].slice(0, Math.max(1, 248 - [...titlePrefix].length)).join(""),
          description: `Relates to issue #${issue.iid}.\n\n${outcome.summary}`,
          sourceBranch,
          targetBranch,
        }, signal),
        (value) => value,
        (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
      );
      try {
        await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.post_issue_result",
          { projectId: event.projectId, issueIid: event.targetIid, mergeRequestIid: mr.iid },
          () => this.gitlab.postIssueNote(event.projectId, event.targetIid, `Draft merge request created: ${mr.webUrl}`, signal),
          (receipt) => receipt,
          (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
        );
      } catch (error) {
        console.warn("Issue result note failed after draft merge request creation", { eventId: event.id, mergeRequestIid: mr.iid, error: errorMessage(error) });
      }
      transition("completed");
    } finally {
      await cleanup();
    }
  }

  private async executeFix(
    event: Event,
    original: MergeRequest,
    workspace: Workspace,
    diff: DiffResult,
    context: ReviewContext,
    signal: AbortSignal,
    transition: (status: EventStatus) => void,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    transition("analyzing");
    transition("fixing");
    const stepContext = { eventId: event.id, attempt: event.attemptCount };
    const started = Date.now();
    let outcome;
    try {
      outcome = await traceExecutionStep(
        this.store,
        stepContext,
        "workflow.fix",
        { request: event.request, changedFiles: diff.changes.map((change) => change.path) },
        () => this.fixer.fix(context, event.request, diff, workspace.path, signal, {
          scope: { kind: "event", eventId: event.id },
          attempt: event.attemptCount,
          taskType: event.type,
          workspace,
        }),
        (value) => ({
          model: value.model,
          usage: value.usage,
          summary: value.summary,
          patchBytes: Buffer.byteLength(value.patch),
          patchSha256: createHash("sha256").update(value.patch).digest("hex"),
        }),
      );
      this.store.recordModelCall(
        "fix",
        "success",
        Date.now() - started,
        outcome.usage.inputTokens,
        outcome.usage.outputTokens,
      );
    } catch (error) {
      this.store.recordModelCall("fix", "failure", Date.now() - started, 0, 0);
      throw error;
    }
    transition("verifying");
    const allowedPaths = diff.changes
      .filter((change) => !change.skipped && change.patch)
      .map((change) => change.path);
    const finalPatch = outcome.patch
      ? await traceExecutionStep(
          this.store,
          stepContext,
          "git.apply_patch",
          {
            patchBytes: Buffer.byteLength(outcome.patch),
            patchSha256: createHash("sha256").update(outcome.patch).digest("hex"),
            allowedPaths,
            maxBytes: this.config.fix.maxPatchBytes,
          },
          () => this.repo.applyPatch(
            workspace,
            outcome.patch,
            allowedPaths,
            this.config.fix.maxPatchBytes,
            signal,
          ),
          (value) => ({ bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") }),
        )
      : "";
    await cleanup();
    if (!(await this.verifySnapshot(event, original, signal, transition))) return;
    transition("publishing");
    const note = [
      `## Corvex fix proposal for \`${event.headSha.slice(0, 12)}\``,
      "",
      escapeMarkdown(outcome.summary),
      finalPatch
        ? "\n\nThe patch passed `git apply --check` and `git diff --check` in an isolated worktree. It was not committed or pushed; apply it manually after review."
        : "\n\nNo patch was proposed. No files were changed.",
      ...(finalPatch ? ["", `${patchFence(finalPatch)}diff`, finalPatch] : []),
    ].join("\n");
    await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.post_fix_proposal",
      { projectId: event.projectId, mrIid: event.mrIid, body: note },
      () => this.gitlab.postNote(event.projectId, event.mrIid, note, signal),
      (receipt) => receipt,
      (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
    );
    transition("completed");
  }

  private async verifySnapshot(
    event: Event,
    original: MergeRequest,
    signal: AbortSignal,
    transition: (status: EventStatus) => void,
  ): Promise<boolean> {
    const stepContext = { eventId: event.id, attempt: event.attemptCount };
    const latest = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_merge_request_for_snapshot",
      { projectId: event.projectId, mrIid: event.mrIid, expectedHeadSha: event.headSha },
      () => this.gitlab.getMergeRequest(event.projectId, event.mrIid, signal),
      (value) => ({ state: value.state, sha: value.sha, diffRefs: value.diff_refs }),
    );
    const current = sameSnapshot(original, latest, event.headSha);
    this.store.recordExecutionStep({
      ...stepContext,
      step: "worker.verify_snapshot",
      status: current ? "succeeded" : "ignored",
      input: { expectedHeadSha: event.headSha, original: original.diff_refs },
      output: { current, latest: latest.diff_refs, latestState: latest.state },
    });
    if (!current) {
      transition("stale");
      return false;
    }
    return true;
  }

  private async verifyPushedHead(
    event: Event,
    original: MergeRequest,
    pushedSha: string,
    signal: AbortSignal,
    transition: (status: EventStatus) => void,
  ): Promise<boolean> {
    const stepContext = { eventId: event.id, attempt: event.attemptCount };
    const latest = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_merge_request_after_push",
      { projectId: event.projectId, mrIid: event.mrIid, pushedSha },
      () => this.gitlab.getMergeRequest(event.projectId, event.mrIid, signal),
      (value) => ({ state: value.state, sha: value.sha, diffRefs: value.diff_refs }),
    );
    // GitLab 重算 MR diff refs 有延迟：diff_refs.head_sha 可能尚未更新为刚推送的
    // commit，而 mr.sha 已指向新 head。任一字段与推送的 SHA 匹配即视为快照有效。
    const current =
      latest.state === "opened" &&
      (sameSha(latest.diff_refs.head_sha, pushedSha) || sameSha(latest.sha, pushedSha)) &&
      sameSha(original.diff_refs.base_sha, latest.diff_refs.base_sha) &&
      sameSha(original.diff_refs.start_sha, latest.diff_refs.start_sha);
    this.store.recordExecutionStep({
      ...stepContext,
      step: "worker.verify_pushed_head",
      status: current ? "succeeded" : "ignored",
      input: { expectedHeadSha: pushedSha, original: original.diff_refs },
      output: { current, latest: latest.diff_refs, latestState: latest.state },
    });
    if (!current) {
      transition("stale");
      return false;
    }
    return true;
  }
}

function headSha(mr: MergeRequest): string {
  return mr.diff_refs.head_sha || mr.sha;
}

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameSnapshot(original: MergeRequest, latest: MergeRequest, expectedHead: string): boolean {
  return (
    latest.state === "opened" &&
    sameSha(headSha(latest), expectedHead) &&
    sameSha(original.diff_refs.base_sha, latest.diff_refs.base_sha) &&
    sameSha(original.diff_refs.start_sha, latest.diff_refs.start_sha) &&
    sameSha(original.diff_refs.head_sha, latest.diff_refs.head_sha)
  );
}

function createReviewContext(event: Event, mr: MergeRequest, baseSha: string): ReviewContext {
  return {
    projectId: event.projectId,
    mrIid: event.mrIid,
    title: mr.title,
    description: mr.description ?? "",
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    baseSha,
    headSha: event.headSha,
  };
}

function escapeMarkdown(value: string): string {
  const escaped = new Set(["\\", "`", "*", "_", "{", "}", "[", "]", "(", ")", "#", "+", ".", "!", "|", ">"]);
  return [...value].map((character) => `${escaped.has(character) ? "\\" : ""}${character}`).join("");
}

function formatFinding(finding: Finding): string {
  return `**${finding.severity.toUpperCase()}: ${escapeMarkdown(finding.title)}**\n\n${escapeMarkdown(finding.explanation)}\n\nEvidence: \`${finding.evidence.replace(/`/g, "\\`")}\`${finding.suggestion ? `\n\nSuggestion: ${escapeMarkdown(finding.suggestion)}` : ""}`;
}

function formatReview(
  event: Event,
  summary: string,
  findings: Finding[],
  inlinePosted: number,
): string {
  const lines = [
    `## Corvex review for \`${event.headSha.slice(0, 12)}\``,
    "",
    escapeMarkdown(summary),
    "",
    `${findings.length} validated finding(s); ${inlinePosted} posted inline.`,
  ];
  findings.forEach((finding, index) => {
    lines.push(
      "",
      "<details>",
      `<summary>Finding ${index + 1}: ${finding.severity.toUpperCase()} - ${escapeMarkdown(finding.title)}</summary>`,
      "",
      `- **Severity:** ${finding.severity.toUpperCase()}`,
      `- **Location:** \`${finding.filePath}:${finding.line}\``,
      `- **Title:** ${escapeMarkdown(finding.title)}`,
      `- **Explanation:** ${escapeMarkdown(finding.explanation)}`,
      `- **Evidence:** \`${finding.evidence.replace(/`/g, "\\`")}\``,
    );
    if (finding.suggestion) {
      lines.push(`- **Suggested fix:** ${escapeMarkdown(finding.suggestion)}`);
    }
    lines.push("", "</details>");
  });
  return lines.join("\n");
}

function patchFence(patch: string): string {
  const ticks = [...patch.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 2) + 1;
  return "`".repeat(ticks);
}
