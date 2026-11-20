import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorvexServer } from "../../src/app/server.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { GitManager, conversationWorkspaceName } from "../../src/git/manager.js";
import { EventStore } from "../../src/events/store.js";
import { GitLabClient } from "../../src/gitlab/client.js";
import { createTokenCipher } from "../../src/tokens.js";

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
  throw new Error("timed out waiting for the review event to complete");
}

describe("review task loop", () => {
  let temporaryDirectory = "";
  let apiServer: Server | undefined;
  let modelServer: Server | undefined;
  let application: CorvexServer | undefined;
  let applicationRun: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let serverStore: EventStore | undefined;

  afterEach(async () => {
    controller?.abort();
    await Promise.allSettled([applicationRun].filter((value): value is Promise<void> => value !== undefined));
    if (apiServer) await close(apiServer);
    if (modelServer) await close(modelServer);
    serverStore?.close();
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
    const createdMergeRequests: URLSearchParams[] = [];
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
      if (request.method === "GET" && url.pathname === "/api/v4/projects/1/issues/9") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ iid: 9, title: "Add generated file", description: "Create a small source file.", state: "opened" }));
        return;
      }
      if (url.pathname === "/api/v4/projects/1" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: 1,
          path_with_namespace: "project",
          http_url_to_repo: `http://127.0.0.1:${apiPort}/project.git`,
          default_branch: "main",
        }));
        return;
      }
      const branchMatch = /^\/api\/v4\/projects\/1\/repository\/branches\/(.+)$/.exec(url.pathname);
      if (branchMatch && request.method === "GET") {
        const name = decodeURIComponent(branchMatch[1]!);
        const branchHead = name === "feature" ? headSha : baseSha;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name, commit: { id: branchHead } }));
        return;
      }
      if (url.pathname === "/api/v4/projects/1/merge_requests" && request.method === "POST") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => { body += chunk; });
        request.on("end", () => {
          const fields = new URLSearchParams(body);
          createdMergeRequests.push(fields);
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({
            iid: 12,
            web_url: "https://gitlab.example.test/project/-/merge_requests/12",
            source_branch: fields.get("source_branch"),
            target_branch: fields.get("target_branch"),
          }));
        });
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
      if (url.pathname.endsWith("/notes") && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([{
          id: 501,
          system: false,
          body: "Please validate the new input.",
          created_at: "2026-11-03T10:00:00Z",
          author: { username: "reviewer" },
        }]));
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
      /** 提供后先返回一次工具调用，由模型循环执行工具再发起下一轮请求。 */
      toolCall?: { name: string; args: string };
      /** 提供后把正文拆成多个 SSE 内容块，模拟逐字输出；省略时一次给出全文。 */
      chunks?: string[];
      /** 与 `chunks` 对齐的思考内容块，模拟模型的 reasoning 输出。 */
      reasoningChunks?: string[];
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
    const modelRequests: string[] = [];
    modelServer = createServer((request, response) => {
      let requestBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { requestBody += chunk; });
      request.on("end", () => {
        expect(request.url).toBe("/v1/chat/completions");
        expect(requestBody).toContain('"model":"test-model"');
        modelRequests.push(requestBody);
        const action = modelActions.shift() ?? { content: reviewContent };
        action.onStarted?.();
        const sendResponse = () => {
          action.beforeResponse?.();
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          const writeDelta = (delta: Record<string, unknown>) => {
            if (response.destroyed) return;
            response.write(`data: ${JSON.stringify({
              id: "chatcmpl-review",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`);
          };
          const finish = () => {
            if (response.destroyed) return;
            response.write(`data: ${JSON.stringify({
              id: "chatcmpl-review",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta: {}, finish_reason: action.toolCall ? "tool_calls" : "stop" }],
              usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
            })}\n\n`);
            response.end("data: [DONE]\n\n");
          };
          if (action.toolCall) {
            writeDelta({
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "call-conversation",
                type: "function",
                function: { name: action.toolCall.name, arguments: action.toolCall.args },
              }],
            });
            finish();
            return;
          }
          const chunks = action.chunks?.length ? action.chunks : [action.content];
          for (const [index, content] of chunks.entries()) {
            const delta: Record<string, unknown> = { content };
            if (action.reasoningChunks?.[index]) delta.reasoning_content = action.reasoningChunks[index];
            if (index === 0) {
              writeDelta({ role: "assistant", ...delta });
            } else {
              setTimeout(() => writeDelta(delta), index * 40);
            }
          }
          setTimeout(finish, chunks.length * 40);
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
      operations: { username: "operator", password: "a secure password with 16 chars" },
      gitlab: {
        baseUrl: `http://127.0.0.1:${apiPort}`,
        readToken: "read-token",
        writeToken: "write-token",
        webhookSecret: "webhook-secret",
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
        contextWindow: 131_072,
        maxInputTokens: 0,
        historyTokenBudget: 24_000,
        turnToolResultBytes: 256 << 10,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 20_000,
        summaryEnabled: true,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      chat: { historyComments: 20 },
      events: { pollInterval: 20, eventTimeout: 15_000 },
      fix: { enabled: true, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    };
    serverStore = await EventStore.open(config.storage.database);
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
    // 事件由 Server 内联执行，可能在响应返回前就已被领取，因此不限定 queued 状态。
    const queued = serverStore.listEvents(undefined, 10)[0];
    if (!queued) throw new Error("webhook did not enqueue a review event");

    await waitFor(() => serverStore!.listEvents("completed", 10).some((event) => event.id === queued.id));

    const details = serverStore.getEventDetails(queued.id);
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
      const existingIds = new Set(serverStore!.listEvents(undefined, 200).map((event) => event.id));
      const response = await sendNote(noteId, mrIid, note);
      expect(response.status).toBe(202);
      await waitFor(() => serverStore!.listEvents(undefined, 200).some((event) => !existingIds.has(event.id)));
      const event = serverStore.listEvents(undefined, 200).find((candidate) => !existingIds.has(candidate.id));
      if (!event) throw new Error("webhook did not create a task");
      return event;
    };
    const waitForStatus = (eventId: string, status: string) => waitFor(() =>
      serverStore!.listEvents(undefined, 200).some((event) => event.id === eventId && event.status === status),
    );

    modelActions.push({ content: "The file assigns an unchecked value to `value`." });
    const explainEvent = await enqueue(100, 4, "@corvex-bot /explain input.ts");
    await waitForStatus(explainEvent.id, "completed");
    expect(postedNotes.some((body) => body.includes("The file assigns an unchecked value"))).toBe(true);
    expect(serverStore.getEventDetails(explainEvent.id)?.events.map(({ step }) => step)).toContain("gitlab.post_note");

    const chatRequest = "Summarize this PR\n\nSuggest a concise title";
    modelActions.push({ content: "This PR introduces an unchecked value.\n\nSuggested title: Validate input values" });
    const chatEvent = await enqueue(106, 7, `@corvex-bot ${chatRequest}`);
    expect(chatEvent.type).toBe("chat");
    expect(chatEvent.request).toBe(chatRequest);
    await waitForStatus(chatEvent.id, "completed");
    expect(postedNotes.some((body) => body.includes("Suggested title: Validate input values"))).toBe(true);
    expect(modelRequests.some((body) => body.includes("Please validate the new input."))).toBe(true);
    expect(serverStore.getEventDetails(chatEvent.id)?.events.map(({ step }) => step)).toEqual(
      expect.arrayContaining([
        "git.create_diff",
        "gitlab.get_merge_request_comments",
        "workflow.chat",
        "event.verify_snapshot",
        "gitlab.post_note",
      ]),
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
    const fixEvent = await enqueue(101, 5, "@corvex-bot /fix Validate this value");
    await waitForStatus(fixEvent.id, "completed");
    const fixDetails = serverStore.getEventDetails(fixEvent.id);
    expect(fixDetails?.timeline.map(({ to }) => to)).toEqual(expect.arrayContaining(["fixing", "verifying", "publishing", "completed"]));
    expect(fixDetails?.events.map(({ step }) => step)).toContain("gitlab.post_fix_proposal");
    expect(postedNotes.some((body) => body.includes("Replace the unsafe value"))).toBe(true);

    const issuePatch = [
      "diff --git a/generated.ts b/generated.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/generated.ts",
      "@@ -0,0 +1 @@",
      "+export const generated = true;",
      "",
    ].join("\n");
    modelActions.push({ content: JSON.stringify({
      action: "implement",
      summary: "Add the requested generated source file.",
      patch: issuePatch,
    }) });
    config.issue.implementEnabled = true;
    const pushIssueBranch = vi.spyOn(GitManager.prototype, "pushIssueWorkspace").mockImplementation(async (workspace, sourceBranch) => ({
      sha: await git(workspace.path, "rev-parse", "HEAD"),
      branch: sourceBranch,
    }));
    const enabledIssueResponse = await fetch(`http://127.0.0.1:${applicationAddress.port}/webhooks/gitlab`, {
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
        object_attributes: { id: 107, note: "@corvex-bot /implement Add the requested file", noteable_type: "Issue", system: false },
        issue: { iid: 9 },
      }),
    });
    expect(enabledIssueResponse.status).toBe(202);
    const issueEvent = serverStore.listEvents(undefined, 50).find((candidate) => candidate.type === "implement");
    if (!issueEvent) throw new Error("Issue webhook did not enqueue an implementation event");
    await waitForStatus(issueEvent.id, "completed");
    const issueDetails = serverStore.getEventDetails(issueEvent.id);
    expect(issueDetails?.timeline.map(({ to }) => to)).toEqual(expect.arrayContaining(["analyzing", "fixing", "verifying", "publishing", "completed"]));
    expect(issueDetails?.events.map(({ step }) => step)).toEqual(expect.arrayContaining([
      "gitlab.get_issue",
      "git.prepare_issue_workspace",
      "workflow.issue_decision",
      "git.apply_issue_patch",
      "git.commit_issue",
      "git.push_issue_branch",
      "gitlab.create_draft_merge_request",
      "gitlab.post_issue_result",
    ]));
    expect(pushIssueBranch).toHaveBeenCalledOnce();
    expect(createdMergeRequests).toHaveLength(1);
    expect(createdMergeRequests[0]?.get("title")).toMatch(/^Draft: Implement issue #9:/);
    expect(createdMergeRequests[0]?.get("target_branch")).toBe("main");
    expect(createdMergeRequests[0]?.get("source_branch")).toMatch(/^corvex\/issue-9-/);
    expect(postedNotes.some((body) => body.includes("Draft merge request created: https://gitlab.example.test/project/-/merge_requests/12"))).toBe(true);

    rejectDiscussionFor = 6;
    modelActions.push({ content: reviewContent });
    const fallbackEvent = await enqueue(102, 6, "@corvex-bot /review");
    await waitForStatus(fallbackEvent.id, "completed");
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
    const staleEvent = await enqueue(103, 7, "@corvex-bot /review");
    const discussionsBeforeStale = discussionAttempts;
    await waitForStatus(staleEvent.id, "stale");
    expect(discussionAttempts).toBe(discussionsBeforeStale);
    expect(serverStore.getEventDetails(staleEvent.id)?.events.map(({ step }) => step)).toContain("event.verify_snapshot");

    // 对话轮次由 Server 内联执行：不进入事件队列，并逐条暴露工具调用。
    modelActions.push({ content: "", toolCall: { name: "read_file", args: JSON.stringify({ path: "input.ts" }) } });
    const streamedAnswer = "`input.ts` assigns a value without validating it.";
    const streamedThinking = "先读取文件，再确认赋值附近没有校验。";
    modelActions.push({
      content: streamedAnswer,
      chunks: ["`input.ts` assigns ", "a value without ", "validating it."],
      reasoningChunks: ["先读取文件，", "再确认赋值附近", "没有校验。"],
      // 稍作延迟，确保 SSE 已建连后再开始输出正文，断言才不依赖调度顺序。
      delayMs: 100,
    });
    // 首轮完成后触发一次标题生成调用，使用模型的独立动作。
    modelActions.push({ content: "Value assignment in input.ts" });
    const cipher = createTokenCipher(serverStore.getOrCreateSessionSecret());
    const user = serverStore.upsertUser({
      gitlabUserId: 2,
      username: "developer",
      name: "Developer",
      avatarUrl: "",
      accessToken: "read-token",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    }, cipher);
    const session = serverStore.createUserSession(user.id, Date.now() + 3_600_000);
    const authHeaders = { cookie: `corvex_session=${session}` };
    const conversationResponse = await fetch(`http://127.0.0.1:${applicationAddress.port}/api/ops/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ projectId: 1, targetBranch: "main", message: "Where is the value assigned?" }),
    });
    expect(conversationResponse.status).toBe(202);
    const createdConversation = await conversationResponse.json() as { conversationId: string; turnId: string };
    expect(serverStore.listEvents(undefined, 200).some((event) => event.type === "conversation")).toBe(false);
    // 控制台在轮次执行期间订阅 SSE：正文应分多次到达，最后以 done 收尾。
    const streamResponse = await fetch(
      `http://127.0.0.1:${applicationAddress.port}/api/ops/conversations/${createdConversation.conversationId}/turns/${createdConversation.turnId}/stream`,
      { headers: authHeaders },
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    let streamBody = "";
    const streamReader = streamResponse.body!.getReader();
    const streamDecoder = new TextDecoder();
    for (;;) {
      const { value, done } = await streamReader.read();
      if (done) break;
      streamBody += streamDecoder.decode(value, { stream: true });
    }
    const streamEvents = [...streamBody.matchAll(/^data: (.+)$/gm)]
      .map((match) => JSON.parse(match[1]!) as {
        type: string;
        text?: string;
        reset?: boolean;
        status?: string;
        tool?: { id: string; name: string; status: string; durationMs?: number | null };
      });
    const streamedTexts = streamEvents
      .filter((event) => event.type === "text" && event.reset === false && event.text)
      .map((event) => event.text);
    expect(streamedTexts.length).toBeGreaterThan(1);
    expect(streamedTexts[0]).toBe("`input.ts` assigns ");
    expect(streamedTexts.at(-1)).toBe(streamedAnswer);
    // 思考过程与正文分别推送，按累计值逐段增长，且不混入落库的回答正文。
    const streamedThinkingTexts = streamEvents
      .filter((event) => event.type === "thinking" && event.reset === false && event.text)
      .map((event) => event.text);
    expect(streamedThinkingTexts.length).toBeGreaterThan(1);
    expect(streamedThinkingTexts.at(-1)).toBe(streamedThinking);
    expect(streamEvents.findIndex((event) => event.type === "thinking" && event.text))
      .toBeLessThan(streamEvents.findIndex((event) => event.type === "text" && event.text));
    // 工具调用在两次思考之间单独推送，先 running 后 succeeded，不混进回答正文。
    const streamedTools = streamEvents.filter((event) => event.type === "tool").map((event) => event.tool!);
    expect(streamedTools.map((tool) => tool.status)).toEqual(["running", "succeeded"]);
    expect(streamedTools[0]?.name).toBe("read_file");
    expect(streamedTools[0]?.id).toBeTruthy();
    expect(streamEvents.findIndex((event) => event.type === "tool" && event.tool?.status === "succeeded"))
      .toBeLessThan(streamEvents.findIndex((event) => event.type === "thinking" && event.text));
    expect(streamEvents.at(-1)).toMatchObject({ type: "done", status: "completed" });
    await waitFor(() => serverStore.getConversationTurn(createdConversation.conversationId, createdConversation.turnId)?.status === "completed");
    const conversationDetail = serverStore.getConversation(createdConversation.conversationId);
    expect(conversationDetail?.mode).toBe("read_only");
    // 首轮完成后由模型总结标题；失败不影响轮次，因此这里等待列表标题出现。
    await waitFor(() => Boolean(serverStore.getConversation(createdConversation.conversationId)?.title));
    expect(serverStore.getConversation(createdConversation.conversationId)?.title).toBe("Value assignment in input.ts");
    expect(conversationDetail?.messages[1]).toMatchObject({
      role: "assistant",
      status: "completed",
      content: "`input.ts` assigns a value without validating it.",
      toolCalls: [{ name: "read_file", status: "succeeded" }],
    });
    const conversationTurn = serverStore.getConversationTurn(createdConversation.conversationId, createdConversation.turnId);
    // 思考与工具调用落库后仍可从对话详情读取：刷新页面也能还原过程块。
    const process = conversationTurn?.process ?? [];
    expect(process.map((entry) => entry.kind)).toEqual(["tool", "thinking"]);
    expect(process[0]).toMatchObject({ kind: "tool", name: "read_file", status: "succeeded" });
    expect(process[1]).toMatchObject({ kind: "thinking", text: streamedThinking });
    expect(process.some((entry) => entry.kind === "text" && entry.text === streamedAnswer)).toBe(false);
    expect(conversationDetail?.messages[1]?.process).toEqual(process);
    expect(conversationTurn?.trajectory.some((entry) => entry.kind === "tool" && entry.name === "read_file")).toBe(true);
    expect(conversationTurn?.events.map(({ step }) => step)).toEqual(expect.arrayContaining([
      "workflow.read_only_conversation",
      "git.prepare_conversation_workspace",
    ]));
    // 对话工作区跨轮次复用：第二轮不应再重建目录，也不应再出现清理步骤。
    const conversationWorkspace = join(
      config.storage.root,
      "workspaces",
      "1",
      conversationWorkspaceName(createdConversation.conversationId),
    );
    await writeFile(join(conversationWorkspace, "reuse-marker.txt"), "keep\n");
    modelActions.push({ content: "The value is assigned at the top of `input.ts`." });
    const followUp = await fetch(`http://127.0.0.1:${applicationAddress.port}/api/ops/conversations/${createdConversation.conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ message: "Where exactly is it assigned?" }),
    });
    expect(followUp.status).toBe(202);
    const followUpTurn = await followUp.json() as { conversationId: string; turnId: string };
    await waitFor(() => serverStore.getConversationTurn(followUpTurn.conversationId, followUpTurn.turnId)?.status === "completed");
    await expect(readFile(join(conversationWorkspace, "reuse-marker.txt"), "utf8")).resolves.toBe("keep\n");
    const followUpDetail = serverStore.getConversationTurn(followUpTurn.conversationId, followUpTurn.turnId);
    expect(followUpDetail?.events.map(({ step }) => step)).toContain("git.prepare_conversation_workspace");
    expect(followUpDetail?.events.map(({ step }) => step)).not.toContain("git.cleanup_conversation_workspace");

    let cancelModelStarted!: () => void;
    const cancelModelStartedPromise = new Promise<void>((resolvePromise) => {
      cancelModelStarted = resolvePromise;
    });
    modelActions.push({ content: reviewContent, delayMs: 15_000, onStarted: cancelModelStarted });
    const cancelEvent = await enqueue(104, 8, "@corvex-bot /review");
    await cancelModelStartedPromise;
    const cancelResponse = await sendNote(105, 8, "@corvex-bot /cancel");
    expect(cancelResponse.status).toBe(202);
    await waitForStatus(cancelEvent.id, "cancelled");
    expect(serverStore.getEventDetails(cancelEvent.id)?.timeline.map(({ to }) => to)).toContain("cancelled");
  }, 35_000);
});
