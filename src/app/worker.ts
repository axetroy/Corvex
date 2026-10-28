import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { FixWorkflow } from "../fix/workflow.js";
import { GitManager } from "../git/manager.js";
import type { DiffResult, Workspace } from "../git/types.js";
import type { Job, JobStatus } from "../jobs/model.js";
import { JobStore } from "../jobs/store.js";
import { GitLabClient, type MergeRequest } from "../gitlab/client.js";
import { PiAgent } from "../agent/pi.js";
import { ReviewWorkflow, type Finding, type ReviewContext } from "../review/workflow.js";

const leaseMs = 30_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Worker {
  private readonly workerId = randomUUID();
  private readonly repo: GitManager;
  private readonly reviewer: ReviewWorkflow;
  private readonly fixer: FixWorkflow;
  private readonly agent: PiAgent;

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: JobStore,
    private readonly gitlab: GitLabClient,
  ) {
    if (!config.agent.enabled) throw new Error("worker mode requires agent.enabled=true");
    if (config.fix.enabled && config.fix.allowedUserIds.length === 0) {
      throw new Error("enabled fix mode requires an authorized user allowlist");
    }
    this.repo = new GitManager(config.storage.root, config.gitlab.baseUrl, config.gitlab.readToken);
    this.agent = new PiAgent(config, store);
    this.reviewer = new ReviewWorkflow(
      this.agent,
      config.review.maxFiles,
      config.review.maxFindings,
      config.review.maxContextBytes,
    );
    this.fixer = new FixWorkflow(this.agent, config.review.maxContextBytes, config.fix.maxPatchBytes);
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
        this.store.updateLeasedStatus(job.id, job.leaseToken, stage, next);
        stage = next;
      });
    } catch (error) {
      processingError = error;
    } finally {
      controller.abort();
      shutdownSignal.removeEventListener("abort", onShutdown);
      await heartbeat;
    }
    if (!processingError) return;
    if (shutdownSignal.aborted) {
      console.warn("worker stopped during job; lease will recover it", {
        jobId: job.id,
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
          `Cancellation requested by task owner: ${message(processingError)}`,
        );
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
    if (stage !== "publishing") {
      try {
        this.store.updateLeasedStatus(job.id, job.leaseToken, stage, "failed", message(processingError));
      } catch (statusError) {
        console.error("could not mark job failed", {
          jobId: job.id,
          error: message(statusError),
          processingError: message(processingError),
        });
      }
    } else {
      try {
        this.store.updateLeasedStatus(job.id, job.leaseToken, stage, "failed", message(processingError));
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
    if (!["review", "fix", "explain"].includes(job.type)) {
      throw new Error(`unsupported task type "${job.type}"`);
    }
    if (job.type === "fix" && (!this.config.fix.enabled || !this.config.fix.allowedUserIds.includes(job.actorId))) {
      throw new Error("fix task cannot run because fix mode is disabled or the user is not authorized");
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(job.headSha)) {
      transition("stale");
      throw new Error("The review task did not include a full MR Head SHA.");
    }
    const mergeRequest = await this.gitlab.getMergeRequest(job.projectId, job.mrIid, signal);
    if (mergeRequest.state !== "opened") {
      transition("stale");
      return;
    }
    if (!sameSha(headSha(mergeRequest), job.headSha)) {
      transition("stale");
      return;
    }
    const baseSha = mergeRequest.diff_refs.base_sha;
    if (!baseSha || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseSha)) {
      throw new Error("GitLab did not provide the MR base SHA");
    }
    const project = await this.gitlab.getProject(job.projectId, signal);
    const workspace = await this.repo.prepareWorkspace(
      job.projectId,
      job.id,
      project.http_url_to_repo,
      job.headSha,
      signal,
    );
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      await this.repo.cleanupWorkspace(workspace);
      cleaned = true;
    };
    try {
      const context = createReviewContext(job, mergeRequest, baseSha);
      if (job.type === "explain") {
        const content = await this.repo.readFile(
          workspace,
          job.request,
          this.config.review.maxContextBytes,
          signal,
        );
        transition("analyzing");
        const started = Date.now();
        let explanation;
        try {
          explanation = await this.reviewer.explain(
            context,
            job.request,
            content,
            workspace.path,
            signal,
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
        await this.gitlab.postNote(
          job.projectId,
          job.mrIid,
          `## Corvex explanation for \`${escapeMarkdown(job.request)}\`\n\n${escapeMarkdown(explanation.text)}`,
          signal,
        );
        transition("completed");
        return;
      }

      const diff = await this.repo.diff(
        workspace,
        baseSha,
        this.config.review.maxFiles,
        this.config.review.maxContextBytes,
        signal,
      );
      if (job.type === "fix") {
        await this.executeFix(job, mergeRequest, workspace, diff, context, signal, transition, cleanup);
        return;
      }
      transition("analyzing");
      const started = Date.now();
      let outcome;
      try {
        outcome = await this.reviewer.review(context, diff, workspace.path, signal);
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
      if (!(await this.verifySnapshot(job, mergeRequest, signal, transition))) return;
      transition("publishing");
      const fallback: Finding[] = [];
      let inlinePosted = 0;
      for (const finding of outcome.result.findings) {
        try {
          await this.gitlab.postDiscussion(
            job.projectId,
            job.mrIid,
            formatFinding(finding),
            {
              baseSha: mergeRequest.diff_refs.base_sha,
              startSha: mergeRequest.diff_refs.start_sha,
              headSha: job.headSha,
              oldPath: finding.filePath,
              newPath: finding.filePath,
              newLine: finding.line,
            },
            signal,
          );
          inlinePosted++;
        } catch (error) {
          console.warn("inline review comment failed; using summary fallback", {
            jobId: job.id,
            path: finding.filePath,
            line: finding.line,
            error: message(error),
          });
          fallback.push(finding);
        }
      }
      await this.gitlab.postNote(
        job.projectId,
        job.mrIid,
        formatReview(job, outcome.result.summary, outcome.result.findings, inlinePosted, fallback),
        signal,
      );
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
    const started = Date.now();
    let outcome;
    try {
      outcome = await this.fixer.fix(context, job.request, diff, workspace.path, signal);
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
      ? await this.repo.applyPatch(
          workspace,
          outcome.patch,
          allowedPaths,
          this.config.fix.maxPatchBytes,
          signal,
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
    await this.gitlab.postNote(job.projectId, job.mrIid, note, signal);
    transition("completed");
  }

  private async verifySnapshot(
    job: Job,
    original: MergeRequest,
    signal: AbortSignal,
    transition: (status: JobStatus) => void,
  ): Promise<boolean> {
    const latest = await this.gitlab.getMergeRequest(job.projectId, job.mrIid, signal);
    if (!sameSnapshot(original, latest, job.headSha)) {
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
  fallback: Finding[],
): string {
  const lines = [
    `## Corvex review for \`${job.headSha.slice(0, 12)}\``,
    "",
    escapeMarkdown(summary),
    "",
    `${findings.length} validated finding(s); ${inlinePosted} posted inline.`,
  ];
  for (const finding of fallback) {
    lines.push("", `### ${finding.severity.toUpperCase()}: ${escapeMarkdown(finding.title)}`);
    lines.push(`\`${finding.filePath}:${finding.line}\` — ${escapeMarkdown(finding.explanation)}`);
    lines.push(`Evidence: \`${finding.evidence.replace(/`/g, "\\`")}\``);
  }
  return lines.join("\n");
}

function patchFence(patch: string): string {
  const ticks = [...patch.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 2) + 1;
  return "`".repeat(ticks);
}
