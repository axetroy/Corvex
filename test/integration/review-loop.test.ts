import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorvexServer } from "../../src/app/server.js";
import { Worker } from "../../src/app/worker.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { JobStore } from "../../src/jobs/store.js";
import { GitLabClient } from "../../src/gitlab/client.js";

const execFileAsync = promisify(execFile);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function waitFor(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("timed out waiting for the review job to complete");
}

describe("review task loop", () => {
  let temporaryDirectory = "";
  let apiServer: Server | undefined;
  let modelServer: Server | undefined;
  let application: CorvexServer | undefined;
  let applicationRun: Promise<void> | undefined;
  let workerRun: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let serverStore: JobStore | undefined;
  let workerStore: JobStore | undefined;

  afterEach(async () => {
    controller?.abort();
    await Promise.allSettled([applicationRun, workerRun].filter((value): value is Promise<void> => value !== undefined));
    if (apiServer) await close(apiServer);
    if (modelServer) await close(modelServer);
    serverStore?.close();
    workerStore?.close();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("retries a transient GitLab failure and publishes a complete review", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-review-loop-"));
    const repositoryRoot = join(temporaryDirectory, "source");
    const bareRepository = join(temporaryDirectory, "project.git");
    await mkdir(repositoryRoot);
    await git(temporaryDirectory, "init", "--bare", bareRepository);
    await git(repositoryRoot, "init", "--initial-branch=main");
    await git(repositoryRoot, "config", "user.name", "Corvex Test");
    await git(repositoryRoot, "config", "user.email", "corvex@example.test");
    await writeFile(join(repositoryRoot, "input.ts"), "const value = 0;\n");
    await git(repositoryRoot, "add", "input.ts");
    await git(repositoryRoot, "commit", "-m", "base");
    const baseSha = await git(repositoryRoot, "rev-parse", "HEAD");
    await git(repositoryRoot, "checkout", "-b", "feature");
    await writeFile(join(repositoryRoot, "input.ts"), "const value = unsafe;\n");
    await git(repositoryRoot, "commit", "-am", "introduce unchecked input");
    const headSha = await git(repositoryRoot, "rev-parse", "HEAD");
    await git(repositoryRoot, "remote", "add", "origin", bareRepository);
    await git(repositoryRoot, "push", "--all", "origin");
    await git(temporaryDirectory, "--git-dir", bareRepository, "update-server-info");

    let apiPort = 0;
    const mergeRequestReads = new Map<number, number>();
    const currentHeads = new Map<number, string>();
    const postedNotes: string[] = [];
    const postedDiscussions: URLSearchParams[] = [];
    let discussionAttempts = 0;
    let rejectDiscussionFor: number | undefined;
    apiServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${apiPort || 1}`);
      const mergeRequestMatch = /^\/api\/v4\/projects\/1\/merge_requests\/(\d+)$/.exec(url.pathname);
      if (mergeRequestMatch && request.method === "GET") {
        const mrIid = Number(mergeRequestMatch[1]);
        const reads = (mergeRequestReads.get(mrIid) ?? 0) + 1;
        mergeRequestReads.set(mrIid, reads);
        if (mrIid === 3 && reads <= 3) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "temporary GitLab outage" }));
          return;
        }
        const visibleHead = currentHeads.get(mrIid) ?? headSha;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          iid: mrIid,
          state: "opened",
          title: "Review this change",
          description: "",
          source_branch: "feature",
          target_branch: "main",
          sha: visibleHead,
          diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: visibleHead },
        }));
        return;
      }
      if (url.pathname === "/api/v4/projects/1" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 1, http_url_to_repo: `http://127.0.0.1:${apiPort}/project.git` }));
        return;
      }
      if (url.pathname.endsWith("/notes") && request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          postedNotes.push(new URLSearchParams(body).get("body") ?? "");
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: postedNotes.length }));
        });
        return;
      }
      if (url.pathname.endsWith("/discussions") && request.method === "POST") {
        discussionAttempts++;
        const discussionMrIid = Number(/\/merge_requests\/(\d+)\/discussions$/.exec(url.pathname)?.[1]);
        if (discussionMrIid === rejectDiscussionFor) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: "position is invalid" }));
          rejectDiscussionFor = undefined;
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          postedDiscussions.push(new URLSearchParams(body));
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: postedDiscussions.length }));
        });
        return;
      }
      if (url.pathname.startsWith("/project.git/")) {
        const relative = url.pathname.slice("/project.git".length);
        const filePath = resolve(bareRepository, `.${relative}`);
        if (!filePath.startsWith(`${resolve(bareRepository)}\\`) && !filePath.startsWith(`${resolve(bareRepository)}/`)) {
          response.writeHead(400).end();
          return;
        }
        void readFile(filePath).then((content) => {
          response.writeHead(200, {
            "content-type": relative === "/info/refs" ? "text/plain" : "application/octet-stream",
            "cache-control": "no-cache",
          });
          response.end(content);
        }).catch(() => response.writeHead(404).end());
        return;
      }
      response.writeHead(404).end();
    });
    apiPort = await listen(apiServer);

    type ModelAction = {
      content: string;
      delayMs?: number;
      onStarted?: () => void;
      beforeResponse?: () => void;
    };
    const reviewContent = JSON.stringify({
      summary: "Unchecked input is used without validation.",
      findings: [{
        severity: "high",
        title: "Validate the input before use",
        file_path: "input.ts",
        line: 1,
        evidence: "unsafe",
        explanation: "The new value is used without validation.",
      }],
    });
    const modelActions: ModelAction[] = [];
    modelServer = createServer((request, response) => {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { requestBody += chunk; });
      request.on("end", () => {
        expect(request.url).toBe("/v1/chat/completions");
        expect(requestBody).toContain('"model":"test-model"');
        const action = modelActions.shift() ?? { content: reviewContent };
        action.onStarted?.();
        const sendResponse = () => {
          action.beforeResponse?.();
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.write(`data: ${JSON.stringify({
            id: "chatcmpl-review",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta: { role: "assistant", content: action.content }, finish_reason: null }],
          })}\n\n`);
          response.write(`data: ${JSON.stringify({
            id: "chatcmpl-review",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
          })}\n\n`);
          response.end("data: [DONE]\n\n");
        };
        const timer = action.delayMs ? setTimeout(sendResponse, action.delayMs) : undefined;
        response.once("close", () => {
          if (timer) clearTimeout(timer);
        });
        if (!action.delayMs) sendResponse();
      });
    });
    const modelPort = await listen(modelServer);

    const config: CorvexConfig = {
      server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
      operations: { username: "", password: "" },
      gitlab: {
        baseUrl: `http://127.0.0.1:${apiPort}`,
        readToken: "read-token",
        writeToken: "write-token",
        webhookSecret: "webhook-secret",
        allowedProjectIds: [1],
        blockedUserIds: [],
        botUsername: "corvex-bot",
      },
      storage: {
        root: join(temporaryDirectory, "corvex-data"),
        database: join(temporaryDirectory, "state.db"),
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en",
        enabled: true,
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        model: "test-model",
        apiKey: "test-api-key",
        requestTimeout: 5000,
        sessionTimeout: 15_000,
        maxOutputTokens: 1024,
        dailyTokenBudget: 0,
        mcpEnabled: false,
        webEnabled: false,
        webBlockedHosts: [],
        skillPaths: [],
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      worker: { pollInterval: 20, jobTimeout: 15_000 },
      fix: { enabled: true, maxPatchBytes: 128 << 10 },
    };
    serverStore = await JobStore.open(config.storage.database);
    workerStore = await JobStore.open(config.storage.database);
    application = new CorvexServer(config, serverStore, new GitLabClient(config.gitlab.baseUrl, "read-token", "write-token"));
    controller = new AbortController();
    applicationRun = application.run(controller.signal);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        application.getListeningAddress();
        break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    }
    const applicationAddress = application.getListeningAddress();
    const sendNote = (noteId: number, mrIid: number, note: string) => fetch(
      `http://127.0.0.1:${applicationAddress.port}/webhooks/gitlab`,
      {
        method: "POST",
        headers: {
          "x-gitlab-token": "webhook-secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          object_kind: "note",
          user: { id: 2, username: "developer" },
          project: { id: 1 },
          object_attributes: {
            id: noteId,
            note,
            noteable_type: "MergeRequest",
            system: false,
          },
          merge_request: { iid: mrIid, last_commit: { id: headSha } },
        }),
      },
    );
    const webhookResponse = await sendNote(99, 3, "@corvex-bot /review");
    expect(webhookResponse.status).toBe(202);
    const queued = serverStore.listJobs("queued", 10)[0];
    if (!queued) throw new Error("webhook did not enqueue a review job");

    const worker = new Worker(config, workerStore, new GitLabClient(config.gitlab.baseUrl, "read-token", "write-token"));
    workerRun = worker.run(controller.signal);
    await waitFor(() => serverStore!.listJobs("completed", 10).some((job) => job.id === queued.id));

    const details = serverStore.getJobDetails(queued.id);
    expect(mergeRequestReads.get(3)).toBe(5);
    expect(details?.attempts).toMatchObject([
      { attempt: 1, error: expect.stringContaining("GitLab API returned 503") },
      { attempt: 2, error: "" },
    ]);
    expect(details?.timeline.map(({ from, to }) => [from, to])).toContainEqual(["preparing", "queued"]);
    expect(details?.timeline.map(({ from, to }) => [from, to])).toContainEqual(["publishing", "completed"]);
    expect(postedDiscussions).toHaveLength(1);
    expect(postedDiscussions[0]?.get("position[new_path]")).toBe("input.ts");
    expect(postedDiscussions[0]?.get("position[new_line]")).toBe("1");
    expect(postedDiscussions[0]?.get("body")).toContain("Validate the input before use");
    expect(postedNotes.some((body) => body.includes("Unchecked input is used without validation"))).toBe(true);
    const inlineSummary = postedNotes.find((body) => body.includes("1 validated finding(s); 1 posted inline."));
    expect(inlineSummary).toContain("<details>");
    expect(inlineSummary).toContain("<summary>Finding 1: HIGH - Validate the input before use</summary>");
    expect(details?.events.map(({ step }) => step)).toContain("gitlab.post_review_summary");
    expect(details?.trajectory.some((entry) => entry.kind === "llm" && entry.status === "succeeded")).toBe(true);

    const enqueue = async (noteId: number, mrIid: number, note: string) => {
      const existingIds = new Set(serverStore!.listJobs(undefined, 200).map((job) => job.id));
      const response = await sendNote(noteId, mrIid, note);
      expect(response.status).toBe(202);
      await waitFor(() => serverStore!.listJobs(undefined, 200).some((job) => !existingIds.has(job.id)));
      const job = serverStore.listJobs(undefined, 200).find((candidate) => !existingIds.has(candidate.id));
      if (!job) throw new Error("webhook did not create a task");
      return job;
    };
    const waitForStatus = (jobId: string, status: string) => waitFor(() =>
      serverStore!.listJobs(undefined, 200).some((job) => job.id === jobId && job.status === status),
    );

    modelActions.push({ content: "The file assigns an unchecked value to `value`." });
    const explainJob = await enqueue(100, 4, "@corvex-bot /explain input.ts");
    await waitForStatus(explainJob.id, "completed");
    expect(postedNotes.some((body) => body.includes("The file assigns an unchecked value"))).toBe(true);
    expect(serverStore.getJobDetails(explainJob.id)?.events.map(({ step }) => step)).toContain("gitlab.post_note");

    const chatRequest = "Summarize this PR\n\nSuggest a concise title";
    modelActions.push({ content: "This PR introduces an unchecked value.\n\nSuggested title: Validate input values" });
    const chatJob = await enqueue(106, 7, `@corvex-bot ${chatRequest}`);
    expect(chatJob.type).toBe("chat");
    expect(chatJob.request).toBe(chatRequest);
    await waitForStatus(chatJob.id, "completed");
    expect(postedNotes.some((body) => body.includes("Suggested title: Validate input values"))).toBe(true);
    expect(serverStore.getJobDetails(chatJob.id)?.events.map(({ step }) => step)).toEqual(
      expect.arrayContaining(["git.create_diff", "workflow.chat", "worker.verify_snapshot", "gitlab.post_note"]),
    );

    const fixPatch = [
      "diff --git a/input.ts b/input.ts",
      "--- a/input.ts",
      "+++ b/input.ts",
      "@@ -1 +1 @@",
      "-const value = unsafe;",
      "+const value = safe;",
      "",
    ].join("\n");
    modelActions.push({ content: JSON.stringify({ summary: "Replace the unsafe value.", patch: fixPatch }) });
    const fixJob = await enqueue(101, 5, "@corvex-bot /fix Validate this value");
    await waitForStatus(fixJob.id, "completed");
    const fixDetails = serverStore.getJobDetails(fixJob.id);
    expect(fixDetails?.timeline.map(({ to }) => to)).toEqual(expect.arrayContaining(["fixing", "verifying", "publishing", "completed"]));
    expect(fixDetails?.events.map(({ step }) => step)).toContain("gitlab.post_fix_proposal");
    expect(postedNotes.some((body) => body.includes("Replace the unsafe value"))).toBe(true);

    rejectDiscussionFor = 6;
    modelActions.push({ content: reviewContent });
    const fallbackJob = await enqueue(102, 6, "@corvex-bot /review");
    await waitForStatus(fallbackJob.id, "completed");
    const fallbackNote = postedNotes.find((body) => body.includes("1 validated finding(s); 0 posted inline."));
    expect(fallbackNote).toContain("<details>");
    expect(fallbackNote).toContain("<summary>Finding 1: HIGH - Validate the input before use</summary>");
    expect(fallbackNote).toContain("- **Location:** `input.ts:1`");
    expect(fallbackNote).toContain("- **Title:** Validate the input before use");
    expect(fallbackNote).toContain("- **Explanation:** The new value is used without validation\\.");
    expect(fallbackNote).toContain("- **Evidence:** `unsafe`");
    expect(fallbackNote).toContain("</details>");

    const staleSha = "c".repeat(40);
    modelActions.push({ content: reviewContent, beforeResponse: () => currentHeads.set(7, staleSha) });
    const staleJob = await enqueue(103, 7, "@corvex-bot /review");
    const discussionsBeforeStale = discussionAttempts;
    await waitForStatus(staleJob.id, "stale");
    expect(discussionAttempts).toBe(discussionsBeforeStale);
    expect(serverStore.getJobDetails(staleJob.id)?.events.map(({ step }) => step)).toContain("worker.verify_snapshot");

    let cancelModelStarted!: () => void;
    const cancelModelStartedPromise = new Promise<void>((resolvePromise) => {
      cancelModelStarted = resolvePromise;
    });
    modelActions.push({ content: reviewContent, delayMs: 15_000, onStarted: cancelModelStarted });
    const cancelJob = await enqueue(104, 8, "@corvex-bot /review");
    await cancelModelStartedPromise;
    const cancelResponse = await sendNote(105, 8, "@corvex-bot /cancel");
    expect(cancelResponse.status).toBe(202);
    await waitForStatus(cancelJob.id, "cancelled");
    expect(serverStore.getJobDetails(cancelJob.id)?.timeline.map(({ to }) => to)).toContain("cancelled");
  }, 35_000);
});