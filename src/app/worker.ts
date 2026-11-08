import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { FixWorkflow } from "../fix/workflow.js";
import { ImplementWorkflow } from "../implement/workflow.js";
import { GitManager, GitPushError } from "../git/manager.js";
import type { DiffResult, Workspace } from "../git/types.js";
import type { Job, JobStatus } from "../jobs/model.js";
import { JobStore } from "../jobs/store.js";
import { GitLabApiError, GitLabClient, GitLabWriteError, type MergeRequest } from "../gitlab/client.js";
import { maxAgentUserPromptBytes, PiAgent, type JobTraceContext } from "../agent/pi.js";
import { ReviewWorkflow, type Finding, type ReviewContext } from "../review/workflow.js";
import { traceExecutionStep } from "../jobs/execution.js";
import { getSessionSystemPrompt } from "../agent/prompts.js";

/** Worker 任务租约时长，单位为毫秒；执行期间按该时长的三分之一续租。 */
const leaseMs = 30_000;
/** 自动重试时按任务尝试序号递增的基础退避时长，单位为毫秒。 */
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

function isRetryableJobFailure(error: unknown): boolean {
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private readonly reviewer: ReviewWorkflow;
  private readonly fixer: FixWorkflow;
  private readonly implementer: ImplementWorkflow;
  private readonly agent: PiAgent;
  private readonly contextByteLimit: number;

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: JobStore,
    private readonly gitlab: GitLabClient,
  ) {
    if (!config.agent.enabled) throw new Error("worker mode requires agent.enabled=true");
    this.contextByteLimit = Math.min(config.review.maxContextBytes, maxAgentUserPromptBytes);
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

  async run(signal: AbortSignal): Promise<void> {
    await this.repo.initialize();
    console.info("Corvex worker started", { pollIntervalMs: this.config.worker.pollInterval });
    while (!signal.aborted) {
      try {
        this.store.heartbeatWorker(this.workerId);
      } catch (error) {
        console.error("update worker heartbeat failed", { error: message(error) });
      }
      let job: Job | undefined;
      try {
        job = this.store.claimNextWithLease(leaseMs);
      } catch (error) {
        console.error("claim worker job failed", { error: message(error) });
      }
      if (job) {
        console.info("Corvex worker claimed job", {
          jobId: job.id,
          type: job.type,
          projectId: job.projectId,
          mrIid: job.mrIid,
          targetType: job.targetType,
          targetIid: job.targetIid,
          status: job.status,
        });
        await this.process(job, signal);
        continue;
      }
      try {
        await sleep(this.config.worker.pollInterval, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }

  private async process(job: Job, shutdownSignal: AbortSignal): Promise<void> {
    let stage: JobStatus = job.status;
    const controller = new AbortController();
    const jobSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(this.config.worker.jobTimeout),
      shutdownSignal,
    ]);
    const onShutdown = () => controller.abort(new Error("worker shutting down"));
    shutdownSignal.addEventListener("abort", onShutdown, { once: true });
    const heartbeat = this.maintainLease(job, jobSignal, controller);
    let processingError: unknown;
    try {
      await this.execute(job, jobSignal, (next) => {
        const previous = stage;
        this.store.updateLeasedStatus(job.id, job.leaseToken, stage, next);
        stage = next;
        console.info("Corvex worker job status changed", {
          jobId: job.id,
          type: job.type,
          projectId: job.projectId,
          mrIid: job.mrIid,
          targetType: job.targetType,
          targetIid: job.targetIid,
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
      console.info("Corvex worker job completed", {
        jobId: job.id,
        type: job.type,
        projectId: job.projectId,
        mrIid: job.mrIid,
        targetType: job.targetType,
        targetIid: job.targetIid,
      });
      return;
    }
    // 进程关闭时保留租约，由过期租约恢复任务，避免把中断误记为任务失败。
    if (shutdownSignal.aborted) {
      console.warn("worker stopped during job; lease will recover it", {
        jobId: job.id,
        error: message(processingError),
      });
      return;
    }
    // 任务已到达终态（stale / cancelled / failed / completed）时，
    // 状态转换在 execute() 内已完成，无需再尝试标记失败，避免无效转换。
    if (stage === "stale" || stage === "cancelled" || stage === "failed" || stage === "completed") {
      console.info("worker job already in terminal state after error; no further recovery needed", {
        jobId: job.id,
        stage,
        error: message(processingError),
      });
      return;
    }
    try {
      if (this.store.cancellationRequested(job.id, job.leaseToken)) {
        this.store.updateLeasedStatus(
          job.id,
          job.leaseToken,
          stage,
          "cancelled",
          `Cancellation requested by task owner: ${errorDetails(processingError)}`,
        );
        if (job.type === "session") {
          this.store.finishChatSessionResponse(job.id, "cancelled", "This turn was cancelled before it could finish.");
        }
        return;
      }
    } catch (leaseError) {
      if (message(leaseError) !== message(processingError)) {
        console.error("could not check cancellation after job failure", {
          jobId: job.id,
          error: message(leaseError),
        });
      }
    }
    if (
      stage !== "publishing" &&
      (isRetryableJobFailure(processingError) || jobSignal.reason?.name === "TimeoutError")
    ) {
      const delayMs = automaticRetryDelay(job.attemptCount);
      const availableAt = Date.now() + delayMs;
      try {
        if (this.store.retryLeasedJob(
          job.id,
          job.leaseToken,
          stage,
          availableAt,
          errorDetails(processingError),
        )) {
          console.warn("transient worker job failure; automatic retry scheduled", {
            jobId: job.id,
            attempt: job.attemptCount,
            retryAt: new Date(availableAt).toISOString(),
            error: message(processingError),
          });
          return;
        }
      } catch (retryError) {
        console.error("could not schedule automatic worker retry", {
          jobId: job.id,
          error: message(retryError),
        });
      }
    }
    // 发布请求可能已在 GitLab 生效，自动重试可能产生重复评论。
    if (stage !== "publishing") {
      try {
        this.store.updateLeasedStatus(job.id, job.leaseToken, stage, "failed", errorDetails(processingError));
        if (job.type === "session") {
          this.store.finishChatSessionResponse(job.id, "failed", `This turn failed: ${message(processingError)}`);
        }
      } catch (statusError) {
        console.error("could not mark job failed", {
          jobId: job.id,
          error: message(statusError),
          processingError: message(processingError),
        });
      }
    } else {
      try {
        this.store.updateLeasedStatus(job.id, job.leaseToken, stage, "failed", errorDetails(processingError));
      } catch (statusError) {
        console.error("publishing outcome is uncertain; no automatic retry will be attempted", {
          jobId: job.id,
          error: message(statusError),
        });
      }
    }
    console.error("process worker job failed", { jobId: job.id, error: message(processingError) });
  }

  private async maintainLease(
    job: Job,
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
        if (this.store.cancellationRequested(job.id, job.leaseToken)) {
          controller.abort(new Error("job cancellation requested"));
          return;
        }
        elapsed += 1000;
        if (elapsed >= leaseMs / 3) {
          // 提前续租，为调度延迟留出余量，避免其他 worker 抢占任务。
          this.store.renewLease(job.id, job.leaseToken, leaseMs);
          this.store.heartbeatWorker(this.workerId);
          elapsed = 0;
        }
      } catch (error) {
        controller.abort(new Error(`maintain job lease: ${message(error)}`, { cause: error }));
        return;
      }
    }
  }

  private async execute(
    job: Job,
    signal: AbortSignal,
    transition: (status: JobStatus) => void,
  ): Promise<void> {
    const trace: JobTraceContext = {
      jobId: job.id,
      attempt: job.attemptCount,
      taskType: job.type,
    };
    const stepContext = { jobId: job.id, attempt: job.attemptCount };
    if (job.type === "session") {
      await this.executeChatSession(job, signal, transition);
      return;
    }
    if (!["review", "fix", "explain", "chat", "implement"].includes(job.type)) {
      throw new Error(`unsupported task type "${job.type}"`);
    }
    if (job.type === "fix" && !this.config.fix.enabled) {
      throw new Error("fix task cannot run because fix mode is disabled");
    }
      if (job.type === "implement") {
        if (job.targetType !== "issue") throw new Error("Issue task has an invalid target type");
        await this.executeIssueImplementation(job, signal, transition);
        return;
      }
      if (job.targetType !== "merge_request") throw new Error("MR task has an invalid target type");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(job.headSha)) {
      this.store.recordExecutionEvent({
        ...stepContext,
        step: "worker.validate_head_sha",
        status: "ignored",
        input: { expectedHeadSha: job.headSha, actualHeadSha: job.headSha },
        output: { accepted: false, reason: "invalid_head_sha" },
      });
      transition("stale");
      return;
    }
    const mergeRequest = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_merge_request",
      { projectId: job.projectId, mrIid: job.mrIid },
      () => this.gitlab.getMergeRequest(job.projectId, job.mrIid, signal),
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
      projectId: job.projectId,
      mrIid: job.mrIid,
      sourceProjectId: mergeRequest.source_project_id,
      targetProjectId: mergeRequest.target_project_id,
      sourceBranch: mergeRequest.source_branch,
      expectedRemoteSha: job.headSha,
    };
    if (mergeRequest.state !== "opened") {
      this.store.recordExecutionEvent({
        ...stepContext,
        step: "worker.validate_mr_state",
        status: "ignored",
        input: { state: mergeRequest.state },
        output: { accepted: false, reason: "merge_request_not_opened" },
      });
      transition("stale");
      return;
    }
    if (!sameSha(headSha(mergeRequest), job.headSha)) {
      this.store.recordExecutionEvent({
        ...stepContext,
        step: "worker.validate_head_sha",
        status: "ignored",
        input: { expectedHeadSha: job.headSha, actualHeadSha: headSha(mergeRequest) },
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
      { projectId: job.projectId },
      () => this.gitlab.getProject(job.projectId, signal),
      (value) => ({ id: value.id, httpUrlToRepo: value.http_url_to_repo }),
    );
    if (trace.mergeRequest) trace.mergeRequest.repositoryUrl = project.http_url_to_repo;
    const workspace = await traceExecutionStep(
      this.store,
      stepContext,
      "git.prepare_workspace",
      { projectId: job.projectId, jobId: job.id, repositoryUrl: project.http_url_to_repo, expectedHeadSha: job.headSha },
      () => this.repo.prepareWorkspace(
        job.projectId,
        job.id,
        project.http_url_to_repo,
        job.headSha,
        signal,
      ),
      (value) => ({ projectId: value.projectId, jobId: value.jobId, headSha: value.headSha }),
    );
    trace.workspace = workspace;
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      await traceExecutionStep(
        this.store,
        stepContext,
        "git.cleanup_workspace",
        { projectId: workspace.projectId, jobId: workspace.jobId },
        () => this.repo.cleanupWorkspace(workspace),
        () => ({ cleaned: true }),
      );
      cleaned = true;
    };
    try {
      const context = createReviewContext(job, mergeRequest, baseSha);
      if (job.type === "explain") {
        const content = await traceExecutionStep(
          this.store,
          stepContext,
          "git.read_file",
          { path: job.request, maxBytes: this.contextByteLimit, headSha: workspace.headSha },
          () => this.repo.readFile(
            workspace,
            job.request,
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
            { path: job.request, contentBytes: content.byteLength },
            () => this.reviewer.explain(
              context,
              job.request,
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
        if (!(await this.verifySnapshot(job, mergeRequest, signal, transition))) return;
        transition("publishing");
        const body = `## Corvex explanation for \`${escapeMarkdown(job.request)}\`\n\n${escapeMarkdown(explanation.text)}`;
        await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.post_note",
          { projectId: job.projectId, mrIid: job.mrIid, body },
          () => this.gitlab.postNote(job.projectId, job.mrIid, body, signal),
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
      if (job.type === "fix") {
        await this.executeFix(job, mergeRequest, workspace, diff, context, signal, transition, cleanup);
        return;
      }
      if (job.type === "chat") {
        transition("analyzing");
        const started = Date.now();
        let answer;
        try {
          const comments = this.config.chat.historyComments > 0
            ? await traceExecutionStep(
                this.store,
                stepContext,
                "gitlab.get_merge_request_comments",
                { projectId: job.projectId, mrIid: job.mrIid, limit: this.config.chat.historyComments },
                () => this.gitlab.getMergeRequestComments(
                  job.projectId,
                  job.mrIid,
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
            { baseSha, headSha: workspace.headSha, request: job.request },
            () => this.reviewer.chat(context, diff, job.request, workspace.path, signal, trace, comments),
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
          ? await this.verifyPushedHead(job, mergeRequest, trace.mergeRequest.pushedSha, signal, transition)
          : await this.verifySnapshot(job, mergeRequest, signal, transition);
        if (!chatSnapshotIsCurrent) return;
        transition("publishing");
        const body = `## Corvex\n\n${answer.text}`;
        await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.post_note",
          { projectId: job.projectId, mrIid: job.mrIid, body },
          () => this.gitlab.postNote(job.projectId, job.mrIid, body, signal),
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
          () => this.reviewer.review(context, diff, workspace.path, signal, trace, job.request),
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
      if (!(await this.verifySnapshot(job, mergeRequest, signal, transition))) return;
      transition("publishing");
      let inlinePosted = 0;
      for (const finding of outcome.result.findings) {
        try {
          const body = formatFinding(finding);
          const position = {
              baseSha: mergeRequest.diff_refs.base_sha,
              startSha: mergeRequest.diff_refs.start_sha,
              headSha: job.headSha,
              oldPath: finding.filePath,
              newPath: finding.filePath,
              newLine: finding.line,
            };
          await traceExecutionStep(
            this.store,
            stepContext,
            "gitlab.post_discussion",
            { projectId: job.projectId, mrIid: job.mrIid, body, position },
            () => this.gitlab.postDiscussion(job.projectId, job.mrIid, body, position, signal),
            (receipt) => receipt,
            (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
          );
          inlinePosted++;
        } catch (error) {
          console.warn("inline review comment failed; using summary fallback", {
            jobId: job.id,
            path: finding.filePath,
            line: finding.line,
            error: message(error),
          });
        }
      }
      const reviewBody = formatReview(job, outcome.result.summary, outcome.result.findings, inlinePosted);
      await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.post_review_summary",
        { projectId: job.projectId, mrIid: job.mrIid, body: reviewBody },
        () => this.gitlab.postNote(job.projectId, job.mrIid, reviewBody, signal),
        (receipt) => receipt,
        (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
      );
      transition("completed");
    } finally {
      await cleanup();
    }
  }

  private async executeChatSession(
    job: Job,
    signal: AbortSignal,
    transition: (status: JobStatus) => void,
  ): Promise<void> {
    if (!job.sessionId || !job.sessionResponseId) throw new Error("session job is missing its message association");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(job.headSha)) {
      transition("stale");
      this.store.finishChatSessionResponse(job.id, "stale", "The target did not have a valid commit snapshot.");
      return;
    }
    const stepContext = { jobId: job.id, attempt: job.attemptCount };
    const session = this.store.getChatSession(job.sessionId);
    if (!session) throw new Error(`chat session "${job.sessionId}" not found`);
    if (session.projectId !== job.projectId || session.targetType !== job.targetType || session.targetIid !== job.targetIid) {
      throw new Error("session job target does not match its stored session");
    }

    let remoteHeadSha: string;
    if (job.targetType === "merge_request") {
      const mergeRequest = await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.get_session_merge_request",
        { projectId: job.projectId, mrIid: job.targetIid },
        () => this.gitlab.getMergeRequest(job.projectId, job.targetIid, signal),
        (value) => ({ iid: value.iid, state: value.state, sourceBranch: value.source_branch, headSha: value.diff_refs.head_sha }),
      );
      if (mergeRequest.source_branch !== job.targetBranch) {
        transition("stale");
        this.store.finishChatSessionResponse(job.id, "stale", "The merge request source branch changed; refresh the session before continuing.");
        return;
      }
      remoteHeadSha = mergeRequest.diff_refs.head_sha;
    } else {
      if (job.targetType === "issue") {
        await traceExecutionStep(
          this.store,
          stepContext,
          "gitlab.get_session_issue",
          { projectId: job.projectId, issueIid: job.targetIid },
          () => this.gitlab.getIssue(job.projectId, job.targetIid, signal),
          (value) => ({ iid: value.iid, state: value.state, title: value.title }),
        );
      }
      const branch = await traceExecutionStep(
        this.store,
        stepContext,
        "gitlab.get_session_branch",
        { projectId: job.projectId, branch: job.targetBranch },
        () => this.gitlab.getBranch(job.projectId, job.targetBranch, signal),
        (value) => ({ name: value.name, headSha: value.commit.id }),
      );
      remoteHeadSha = branch.commit.id;
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(remoteHeadSha) || remoteHeadSha.toLowerCase() !== job.headSha.toLowerCase()) {
      transition("stale");
      this.store.finishChatSessionResponse(job.id, "stale", "The target changed after this turn was queued; send a new message to use the current snapshot.");
      return;
    }
    const project = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_session_project",
      { projectId: job.projectId },
      () => this.gitlab.getProject(job.projectId, signal),
      (value) => ({ id: value.id, httpUrlToRepo: value.http_url_to_repo }),
    );
    const workspace = await traceExecutionStep(
      this.store,
      stepContext,
      "git.prepare_session_workspace",
      { projectId: job.projectId, jobId: job.id, expectedHeadSha: job.headSha },
      () => this.repo.prepareWorkspace(job.projectId, job.id, project.http_url_to_repo, job.headSha, signal),
      (value) => ({ projectId: value.projectId, jobId: value.jobId, headSha: value.headSha }),
    );
    const trace: JobTraceContext = {
      jobId: job.id,
      attempt: job.attemptCount,
      taskType: job.type,
      workspace,
    };
    try {
      transition("analyzing");
      let lastUserIndex = -1;
      for (let index = 0; index < session.messages.length; index++) {
        if (session.messages[index]?.role === "user") lastUserIndex = index;
      }
      const history = session.messages
        .slice(0, lastUserIndex)
        .filter((item) => item.status === "completed")
        .slice(-30)
        .map(({ role, content }) => ({ role, content }));
      const userPrompt = JSON.stringify({
        target: {
          project: session.projectName,
          type: session.targetType,
          iid: session.targetIid || null,
          title: session.targetTitle,
          branch: job.targetBranch,
          headSha: job.headSha,
        },
        conversation: history,
        currentRequest: job.request,
      });
      const started = Date.now();
      try {
        const answer = await traceExecutionStep(
          this.store,
          stepContext,
          "workflow.read_only_session",
          { projectId: job.projectId, targetType: job.targetType, headSha: job.headSha, requestCharacters: [...job.request].length },
          () => this.agent.generate(
            { taskType: "session", systemPrompt: getSessionSystemPrompt(this.config.agent.responseLanguage), userPrompt },
            workspace.path,
            signal,
            trace,
          ),
          (value) => ({ model: value.model, usage: value.usage, textBytes: Buffer.byteLength(value.content) }),
        );
        this.store.recordModelCall("session", "success", Date.now() - started, answer.usage.inputTokens, answer.usage.outputTokens);
        transition("completed");
        this.store.finishChatSessionResponse(job.id, "completed", answer.content);
      } catch (error) {
        this.store.recordModelCall("session", "failure", Date.now() - started, 0, 0);
        throw error;
      }
    } finally {
      await traceExecutionStep(
        this.store,
        stepContext,
        "git.cleanup_session_workspace",
        { projectId: workspace.projectId, jobId: workspace.jobId },
        () => this.repo.cleanupWorkspace(workspace),
        () => ({ cleaned: true }),
      );
    }
  }

  private async executeIssueImplementation(
    job: Job,
    signal: AbortSignal,
    transition: (status: JobStatus) => void,
  ): Promise<void> {
    if (job.targetIid <= 0) throw new Error("Issue implementation job has an invalid Issue IID");
    const stepContext = { jobId: job.id, attempt: job.attemptCount };
    const issue = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_issue",
      { projectId: job.projectId, issueIid: job.targetIid },
      () => this.gitlab.getIssue(job.projectId, job.targetIid, signal),
      (value) => ({ iid: value.iid, title: value.title, state: value.state, descriptionCharacters: [...value.description].length }),
    );
    if (issue.state !== "opened") {
      this.store.recordExecutionEvent({
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
          { projectId: job.projectId, issueIid: job.targetIid, limit: this.config.issue.historyComments },
          () => this.gitlab.getIssueComments(job.projectId, job.targetIid, this.config.issue.historyComments, signal),
          (value) => ({ count: value.length, ids: value.map((comment) => comment.id), bytes: value.reduce((sum, comment) => sum + Buffer.byteLength(comment.body), 0) }),
        )
      : [];
    const project = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_project",
      { projectId: job.projectId },
      () => this.gitlab.getProject(job.projectId, signal),
      (value) => ({ id: value.id, httpUrlToRepo: value.http_url_to_repo, defaultBranch: value.default_branch }),
    );
    if (!project.default_branch?.trim()) throw new Error("GitLab project does not have a default branch");
    let sourceBranch = `corvex/issue-${job.targetIid}-${job.id.slice(0, 8)}-a${job.attemptCount}`;
    const prepareBranch = (targetBranch: string) => traceExecutionStep(
      this.store,
      stepContext,
      "git.prepare_issue_workspace",
      { projectId: job.projectId, jobId: job.id, repositoryUrl: project.http_url_to_repo, targetBranch, sourceBranch },
      () => this.repo.prepareIssueWorkspace(job.projectId, job.id, project.http_url_to_repo, targetBranch, sourceBranch, signal),
      (value) => ({ projectId: value.workspace.projectId, jobId: value.workspace.jobId, baseSha: value.baseSha, sourceBranch, targetBranch }),
    );
    let prepared = await prepareBranch(project.default_branch);
    let workspace = prepared.workspace;
    const cleanedWorkspaces = new Set<string>();
    const trace: JobTraceContext = {
      jobId: job.id,
      attempt: job.attemptCount,
      taskType: job.type,
      workspace,
      issue: {
        projectId: job.projectId,
        issueIid: job.targetIid,
        sourceBranch,
        targetBranch: project.default_branch,
        repositoryUrl: project.http_url_to_repo,
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
        { projectId: target.projectId, jobId: target.jobId, sourceBranch: issueSourceBranch },
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
            { issueIid: issue.iid, baseSha: prepared.baseSha, request: job.request, commentCount: comments.length },
            () => this.implementer.implement({
              projectId: job.projectId,
              issueIid: issue.iid,
              title: issue.title,
              description: issue.description,
              webUrl: issue.web_url,
              defaultBranch: targetBranch,
              baseSha: prepared.baseSha,
              comments,
              implementationEnabled: this.config.issue.implementEnabled,
            }, job.request, workspace.path, signal, trace),
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
          { projectId: job.projectId, issueIid: job.targetIid, bodyCharacters: [...body].length },
          () => this.gitlab.postIssueNote(job.projectId, job.targetIid, body, signal),
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
        { projectId: job.projectId, issueIid: job.targetIid },
        () => this.gitlab.getIssue(job.projectId, job.targetIid, signal),
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
        { projectId: job.projectId, sourceBranch, targetBranch, sha: commit.sha },
        () => this.repo.pushIssueWorkspace(
          workspace,
          sourceBranch,
          targetBranch,
          project.http_url_to_repo,
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
        { projectId: job.projectId, sourceBranch, targetBranch, sha: pushed.sha },
        () => this.gitlab.createDraftMergeRequest(job.projectId, {
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
          { projectId: job.projectId, issueIid: job.targetIid, mergeRequestIid: mr.iid },
          () => this.gitlab.postIssueNote(job.projectId, job.targetIid, `Draft merge request created: ${mr.webUrl}`, signal),
          (receipt) => receipt,
          (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
        );
      } catch (error) {
        console.warn("Issue result note failed after draft merge request creation", { jobId: job.id, mergeRequestIid: mr.iid, error: message(error) });
      }
      transition("completed");
    } finally {
      await cleanup();
    }
  }

  private async executeFix(
    job: Job,
    original: MergeRequest,
    workspace: Workspace,
    diff: DiffResult,
    context: ReviewContext,
    signal: AbortSignal,
    transition: (status: JobStatus) => void,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    transition("analyzing");
    transition("fixing");
    const stepContext = { jobId: job.id, attempt: job.attemptCount };
    const started = Date.now();
    let outcome;
    try {
      outcome = await traceExecutionStep(
        this.store,
        stepContext,
        "workflow.fix",
        { request: job.request, changedFiles: diff.changes.map((change) => change.path) },
        () => this.fixer.fix(context, job.request, diff, workspace.path, signal, {
          jobId: job.id,
          attempt: job.attemptCount,
          taskType: job.type,
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
    if (!(await this.verifySnapshot(job, original, signal, transition))) return;
    transition("publishing");
    const note = [
      `## Corvex fix proposal for \`${job.headSha.slice(0, 12)}\``,
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
      { projectId: job.projectId, mrIid: job.mrIid, body: note },
      () => this.gitlab.postNote(job.projectId, job.mrIid, note, signal),
      (receipt) => receipt,
      (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
    );
    transition("completed");
  }

  private async verifySnapshot(
    job: Job,
    original: MergeRequest,
    signal: AbortSignal,
    transition: (status: JobStatus) => void,
  ): Promise<boolean> {
    const stepContext = { jobId: job.id, attempt: job.attemptCount };
    const latest = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_merge_request_for_snapshot",
      { projectId: job.projectId, mrIid: job.mrIid, expectedHeadSha: job.headSha },
      () => this.gitlab.getMergeRequest(job.projectId, job.mrIid, signal),
      (value) => ({ state: value.state, sha: value.sha, diffRefs: value.diff_refs }),
    );
    const current = sameSnapshot(original, latest, job.headSha);
    this.store.recordExecutionEvent({
      ...stepContext,
      step: "worker.verify_snapshot",
      status: current ? "succeeded" : "ignored",
      input: { expectedHeadSha: job.headSha, original: original.diff_refs },
      output: { current, latest: latest.diff_refs, latestState: latest.state },
    });
    if (!current) {
      transition("stale");
      return false;
    }
    return true;
  }

  private async verifyPushedHead(
    job: Job,
    original: MergeRequest,
    pushedSha: string,
    signal: AbortSignal,
    transition: (status: JobStatus) => void,
  ): Promise<boolean> {
    const stepContext = { jobId: job.id, attempt: job.attemptCount };
    const latest = await traceExecutionStep(
      this.store,
      stepContext,
      "gitlab.get_merge_request_after_push",
      { projectId: job.projectId, mrIid: job.mrIid, pushedSha },
      () => this.gitlab.getMergeRequest(job.projectId, job.mrIid, signal),
      (value) => ({ state: value.state, sha: value.sha, diffRefs: value.diff_refs }),
    );
    // GitLab 重算 MR diff refs 有延迟：diff_refs.head_sha 可能尚未更新为刚推送的
    // commit，而 mr.sha 已指向新 head。任一字段与推送的 SHA 匹配即视为快照有效。
    const current =
      latest.state === "opened" &&
      (sameSha(latest.diff_refs.head_sha, pushedSha) || sameSha(latest.sha, pushedSha)) &&
      sameSha(original.diff_refs.base_sha, latest.diff_refs.base_sha) &&
      sameSha(original.diff_refs.start_sha, latest.diff_refs.start_sha);
    this.store.recordExecutionEvent({
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

function createReviewContext(job: Job, mr: MergeRequest, baseSha: string): ReviewContext {
  return {
    projectId: job.projectId,
    mrIid: job.mrIid,
    title: mr.title,
    description: mr.description ?? "",
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    baseSha,
    headSha: job.headSha,
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
  job: Job,
  summary: string,
  findings: Finding[],
  inlinePosted: number,
): string {
  const lines = [
    `## Corvex review for \`${job.headSha.slice(0, 12)}\``,
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
