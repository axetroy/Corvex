import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CorvexServer } from "../../src/app/server.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { EventStore } from "../../src/events/store.js";
import { GitLabClient } from "../../src/gitlab/client.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

describe("CorvexServer", () => {
  it("authenticates and queues a GitLab command idempotently", async () => {
    let postedNotes = 0;
    let pausePostNotes = false;
    let notifyPostStarted!: () => void;
    let releasePostNote!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      notifyPostStarted = resolve;
    });
    const postGate = new Promise<void>((resolve) => {
      releasePostNote = resolve;
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fakeGitLab = createServer(async (request, response) => {
      if (request.method === "GET") {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const replies: Record<string, unknown> = {
          "/api/v4/projects": [{
            id: 2,
            name: "Project",
            path_with_namespace: "group/project",
            http_url_to_repo: "https://gitlab.example.com/group/project.git",
            default_branch: "main",
          }],
          "/api/v4/projects/2": {
            id: 2,
            name: "Project",
            path_with_namespace: "group/project",
            description: "Test project",
            web_url: "https://gitlab.example.com/group/project",
            http_url_to_repo: "https://gitlab.example.com/group/project.git",
            default_branch: "main",
          },
          "/api/v4/projects/2/repository/branches": [{ name: "main", commit: { id: "b".repeat(40) } }],
          "/api/v4/projects/2/repository/branches/main": { name: "main", commit: { id: "b".repeat(40) } },
          "/api/v4/projects/2/issues": [{ iid: 4, title: "Issue", description: "", state: "opened" }],
          "/api/v4/projects/2/merge_requests": [{
            iid: 5,
            title: "Merge request",
            description: "",
            state: "opened",
            source_branch: "feature/session",
            target_branch: "main",
          }],
          "/api/v4/projects/2/merge_requests/5": {
            iid: 5,
            state: "opened",
            title: "Merge request",
            description: "",
            source_branch: "feature/session",
            target_branch: "main",
            sha: "c".repeat(40),
            diff_refs: { base_sha: "a".repeat(40), start_sha: "a".repeat(40), head_sha: "c".repeat(40) },
          },
          "/api/v4/projects/2/issues/4": { iid: 4, title: "Issue", description: "", state: "opened" },
        };
        const value = replies[path];
        response.writeHead(value === undefined ? 404 : 200, { "content-type": "application/json" });
        response.end(JSON.stringify(value ?? { message: "not found" }));
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/notes")) {
        postedNotes++;
        if (pausePostNotes) {
          notifyPostStarted();
          await postGate;
        }
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 1 }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const gitlabPort = await listen(fakeGitLab);
    const store = await EventStore.open(":memory:");
    const config: CorvexConfig = {
      server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
      operations: { username: "operator", password: "a secure password with 16 chars" },
      gitlab: {
        baseUrl: `http://127.0.0.1:${gitlabPort}`,
        readToken: "read",
        writeToken: "write",
        webhookSecret: "secret",
        blockedUserIds: [3],
        botUsername: "corvex-bot",
      },
      storage: {
        root: ".",
        database: ":memory:",
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en",
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
        model: "",
        apiKey: "",
        requestTimeout: 120000,
        sessionTimeout: 30 * 60_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        mcpEnabled: false,
        webEnabled: true,
        webBlockedHosts: [],
        skillPaths: [],
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      chat: { historyComments: 20 },
      worker: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    };
    const controller = new AbortController();
    const application = new CorvexServer(
      config,
      store,
      new GitLabClient(config.gitlab.baseUrl, "read", "write"),
    );
    const running = application.run(controller.signal);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          application.getListeningAddress();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const address = application.getListeningAddress();
      const base = `http://127.0.0.1:${address.port}`;
      const authorization = `Basic ${Buffer.from(
        `${config.operations.username}:${config.operations.password}`,
      ).toString("base64")}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      config.operations.username = "";
      config.operations.password = "";
      expect((await fetch(`${base}/ops`)).status).toBe(404);
      config.operations.username = "operator";
      config.operations.password = "a secure password with 16 chars";
      expect((await fetch(`${base}/api/ops/overview`)).status).toBe(401);
      const rejected = await fetch(`${base}/api/ops/overview`, {
        headers: { authorization: `Basic ${Buffer.from("operator:wrong").toString("base64")}` },
      });
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get("www-authenticate")).toContain("Basic");
      expect((await fetch(`${base}/api/ops/overview`, { headers: { authorization } })).status).toBe(200);
      expect(
        (await fetch(`${base}/api/ops/overview`, { method: "POST", headers: { authorization } })).status,
      ).toBe(405);
      const dashboard = await fetch(`${base}/ops`, { headers: { authorization } });
      expect(dashboard.status).toBe(200);
      const markup = await dashboard.text();
      expect(markup).toContain('id="root"');
      const nonce = /property="csp-nonce" nonce="([A-Za-z0-9_-]+)"/.exec(markup)?.[1];
      const policy = dashboard.headers.get("content-security-policy") ?? "";
      expect(nonce).toBeTruthy();
      expect(policy).toContain(`style-src 'self' 'nonce-${nonce}'`);
      expect(policy).toContain(`style-src-elem 'self' 'nonce-${nonce}'`);
      expect(policy).toContain("style-src-attr 'unsafe-inline'");
      expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
      const refreshedDashboard = await fetch(`${base}/ops`, { headers: { authorization } });
      const refreshedMarkup = await refreshedDashboard.text();
      expect(/property="csp-nonce" nonce="([A-Za-z0-9_-]+)"/.exec(refreshedMarkup)?.[1]).not.toBe(nonce);
      // 控制台脚本带内容哈希，测试从页面标记中取出真实地址再校验可访问性。
      const scriptPath = /src="([^"]+\.js)"/.exec(markup)?.[1];
      expect(scriptPath).toBeTruthy();
      const script = await fetch(`${base}${scriptPath}`, { headers: { authorization } });
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("javascript");
      expect(markup).toContain('name="robots"');
      expect(dashboard.headers.get("x-robots-tag")).toContain("noindex");
      expect((await fetch(`${base}/ops`, { method: "HEAD", headers: { authorization } })).status).toBe(200);
      expect((await fetch(`${base}/ops`, { method: "POST", headers: { authorization } })).status).toBe(405);
      const overview = await fetch(`${base}/api/ops/overview`, { headers: { authorization } });
      expect(overview.status).toBe(200);
      expect(overview.headers.get("x-content-type-options")).toBe("nosniff");
      const projectsResponse = await fetch(`${base}/api/ops/projects?search=project`, { headers: { authorization } });
      expect(projectsResponse.status).toBe(200);
      expect(await projectsResponse.json()).toMatchObject([{ id: 2, path_with_namespace: "group/project" }]);
      const projectResponse = await fetch(`${base}/api/ops/projects/2`, { headers: { authorization } });
      expect(projectResponse.status).toBe(200);
      expect(await projectResponse.json()).toMatchObject({
        id: 2,
        path_with_namespace: "group/project",
        description: "Test project",
        web_url: `http://127.0.0.1:${gitlabPort}/group/project`,
        http_url_to_repo: `http://127.0.0.1:${gitlabPort}/group/project.git`,
        default_branch: "main",
      });
      expect((await fetch(`${base}/api/ops/projects/0`, { headers: { authorization } })).status).toBe(400);
      const branchesResponse = await fetch(`${base}/api/ops/projects/2/branches`, { headers: { authorization } });
      expect(await branchesResponse.json()).toMatchObject([{ name: "main" }]);
      const createdConversationResponse = await fetch(`${base}/api/ops/conversations`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: 2,
          targetBranch: "main",
          message: "Explain this repository",
        }),
      });
      expect(createdConversationResponse.status).toBe(202);
      const createdConversation = await createdConversationResponse.json() as { conversationId: string; turnId: string };
      // 对话轮次不再进入事件队列；agent.enabled=false 时只排队、不执行。
      expect(store.eventCounts().queued ?? 0).toBe(0);
      const conversationDetailResponse = await fetch(`${base}/api/ops/conversations/${createdConversation.conversationId}`, { headers: { authorization } });
      const conversationDetail = await conversationDetailResponse.json() as { systemPrompt: string };
      expect(conversationDetail).toMatchObject({
        id: createdConversation.conversationId,
        projectName: "group/project",
        targetBranch: "main",
        turnCount: 1,
        lastTurnStatus: "queued",
        messages: [
          { role: "user", content: "Explain this repository" },
          { role: "assistant", status: "queued", turnId: createdConversation.turnId, turnStatus: "queued" },
        ],
      });
      // 详情附带与执行器一致的系统提示词；未执行过轮次的新对话也能查看。
      expect(conversationDetail.systemPrompt).toContain("read-only code assistant");
      // 单轮对话记录端点返回该轮的轨迹与执行步骤，并拒绝跨对话或未知轮次。
      const conversationTurnResponse = await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/turns/${createdConversation.turnId}`,
        { headers: { authorization } },
      );
      expect(conversationTurnResponse.status).toBe(200);
      expect(await conversationTurnResponse.json()).toMatchObject({
        conversationId: createdConversation.conversationId,
        turnId: createdConversation.turnId,
        status: "queued",
        request: "Explain this repository",
        headSha: "b".repeat(40),
        trajectory: [],
        events: [],
      });
      expect((await fetch(
        `${base}/api/ops/conversations/other-conversation/turns/${createdConversation.turnId}`,
        { headers: { authorization } },
      )).status).toBe(404);
      expect((await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/turns/missing-turn`,
        { headers: { authorization } },
      )).status).toBe(404);
      // 整段对话轨迹端点把全部轮次合并成一条时间线，未知对话返回 404。
      const conversationTurnsResponse = await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/turns`,
        { headers: { authorization } },
      );
      expect(conversationTurnsResponse.status).toBe(200);
      expect(await conversationTurnsResponse.json()).toMatchObject({
        conversationId: createdConversation.conversationId,
        turns: [{ turnId: createdConversation.turnId, status: "queued", request: "Explain this repository" }],
        trajectory: [],
        events: [],
      });
      expect((await fetch(
        `${base}/api/ops/conversations/missing-conversation/turns`,
        { headers: { authorization } },
      )).status).toBe(404);
      // 统计端点汇总整段对话的用量与逐轮明细，未知对话返回 404。
      const conversationStatsResponse = await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/stats`,
        { headers: { authorization } },
      );
      expect(conversationStatsResponse.status).toBe(200);
      expect(await conversationStatsResponse.json()).toMatchObject({
        conversationId: createdConversation.conversationId,
        turnCount: 1,
        completedTurns: 0,
        failedTurns: 0,
        activeTurns: 1,
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        turns: [{ turnId: createdConversation.turnId, status: "queued", durationMs: null, request: "Explain this repository" }],
      });
      expect((await fetch(
        `${base}/api/ops/conversations/missing-conversation/stats`,
        { headers: { authorization } },
      )).status).toBe(404);
      const concurrentReplyResponse = await fetch(`${base}/api/ops/conversations/${createdConversation.conversationId}/messages`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ message: "A concurrent follow-up" }),
      });
      expect(concurrentReplyResponse.status).toBe(409);
      const secondConversationResponse = await fetch(`${base}/api/ops/conversations`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: 2,
          targetBranch: "main",
          message: "Summarize the request flow",
        }),
      });
      expect(secondConversationResponse.status).toBe(202);
      const secondConversation = await secondConversationResponse.json() as { conversationId: string; turnId: string };
      expect(secondConversation.turnId).toBeTruthy();
      expect(store.eventCounts().queued ?? 0).toBe(0);
      // 流式正文端点与其它轨迹端点一样先校验轮次归属，未知轮次返回 404。
      expect((await fetch(
        `${base}/api/ops/conversations/${secondConversation.conversationId}/turns/missing-turn/stream`,
        { headers: { authorization } },
      )).status).toBe(404);
      // 已结束的轮次不需要保持连接：端点立即以 done 收尾，界面随即刷新详情。
      expect(store.claimConversationTurn(secondConversation.turnId)).toBeTruthy();
      store.finishConversationTurn(secondConversation.turnId, "Streamed answer");
      const streamResponse = await fetch(
        `${base}/api/ops/conversations/${secondConversation.conversationId}/turns/${secondConversation.turnId}/stream`,
        { headers: { authorization } },
      );
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      expect(streamResponse.headers.get("cache-control")).toBe("no-store");
      const streamBody = await streamResponse.text();
      expect(streamBody).toContain('"type":"done"');
      expect(streamBody).toContain('"status":"completed"');
      // 归档：列表按归档状态过滤，详情仍可读；删除后对话详情返回 404。
      const archiveResponse = await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}/archive`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      expect(archiveResponse.status).toBe(200);
      expect(await archiveResponse.json()).toMatchObject({ archived: true });
      const archivedList = await fetch(`${base}/api/ops/conversations?archived=true`, { headers: { authorization } });
      expect(await archivedList.json()).toMatchObject({
        items: [{ id: secondConversation.conversationId, archived: true }],
      });
      const activeList = await fetch(`${base}/api/ops/conversations?archived=false`, { headers: { authorization } });
      expect((await activeList.json() as { items: { id: string }[] }).items.map((item) => item.id))
        .not.toContain(secondConversation.conversationId);
      expect((await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}`, { headers: { authorization } })).status).toBe(200);
      expect((await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}/archive`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({}),
      })).status).toBe(400);
      const archiveOffResponse = await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}/archive`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      expect(archiveOffResponse.status).toBe(200);
      const deleteResponse = await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}`, {
        method: "DELETE",
        headers: { authorization },
      });
      expect(deleteResponse.status).toBe(200);
      expect((await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}`, { headers: { authorization } })).status).toBe(404);
      const queuedConversations = store.eventCounts().queued ?? 0;
      // 存储清理：预览不删文件，但会留下一条可查询的记录。
      const cleanupPreview = await fetch(`${base}/api/ops/storage/cleanup`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ olderThanDays: 1, apply: false }),
      });
      expect(cleanupPreview.status).toBe(200);
      expect(await cleanupPreview.json()).toMatchObject({ applied: false, olderThanDays: 1 });
      expect((await fetch(`${base}/api/ops/storage/cleanup`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ olderThanDays: 0, apply: false }),
      })).status).toBe(400);
      const cleanupRecords = await fetch(`${base}/api/ops/storage/cleanups`, { headers: { authorization } });
      expect((await cleanupRecords.json() as { items: { source: string; applied: boolean; olderThanDays: number }[] }).items)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ source: "ops-console", applied: false, olderThanDays: 1 }),
        ]));
      expect((await fetch(`${base}/ops/app.js`, { headers: { authorization } })).status).toBe(404);
      expect((await fetch(`${base}/ops/assets/../index.html`, { headers: { authorization } })).status).toBe(404);
      expect((await fetch(`${base}/webhooks/gitlab`, { method: "POST" })).status).toBe(401);

      const payload = {
        object_kind: "note",
        user: { id: 99, username: "developer" },
        project: { id: 1 },
        object_attributes: {
          id: 99,
          note: "@corvex-bot /review\n重点检查安全与代码质量\n\n请按示例核对：\n  输入：  user input\n  输出：validated value",
          noteable_type: "MergeRequest",
          system: false,
        },
        merge_request: { iid: 10, last_commit: { id: "a".repeat(40) } },
      };
      const send = () =>
        fetch(`${base}/webhooks/gitlab`, {
          method: "POST",
          headers: {
            "x-gitlab-token": "secret",
            "x-gitlab-event": "Note Hook",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      pausePostNotes = true;
      const activeDelivery = send();
      await postStarted;
      expect((await send()).status).toBe(503);
      releasePostNote();
      expect((await activeDelivery).status).toBe(202);
      pausePostNotes = false;
      expect((await send()).status).toBe(202);
      expect(store.eventCounts().queued).toBe(queuedConversations + 1);
      expect(postedNotes).toBe(1);
      expect(info).toHaveBeenCalledWith(
        "GitLab webhook received",
        expect.objectContaining({ eventType: "Note Hook" }),
      );
      expect(info).not.toHaveBeenCalledWith("GitLab webhook body", expect.anything());
      expect(JSON.stringify(info.mock.calls)).not.toContain("x-gitlab-token");
      expect(JSON.stringify(info.mock.calls)).not.toContain("@corvex-bot /review");
      expect(info).toHaveBeenCalledWith(
        "GitLab Note Hook validated",
        expect.objectContaining({
          actorUsername: "developer",
          system: false,
        }),
      );
      expect(info).toHaveBeenCalledWith(
        "GitLab task enqueued",
        expect.objectContaining({
          webhookEventId: "1:99",
          projectId: 1,
          targetType: "merge_request",
          targetIid: 10,
          type: "review",
        }),
      );
      const reviewEvent = store.listEvents("queued", 10).find((event) => event.type === "review");
      if (!reviewEvent) throw new Error("expected a review event");
      expect(reviewEvent.request).toBe("重点检查安全与代码质量\n\n请按示例核对：\n  输入：  user input\n  输出：validated value");
      const reviewDetails = store.getEventDetails(reviewEvent.id);
      expect(reviewDetails?.actorUsername).toBe("developer");
      expect(reviewDetails?.triggerComment).toContain("@corvex-bot /review");
      expect(reviewDetails?.triggerComment).not.toBe(reviewEvent.request);
      const webhookSteps = reviewDetails?.events ?? [];
      expect(webhookSteps.map((step) => step.step)).toEqual(expect.arrayContaining([
        "webhook.read_body",
        "webhook.decode",
        "webhook.parse_command",
        "webhook.validate_command",
        "webhook.process_command",
        "gitlab.post_note",
        "webhook.mark_delivered",
        "webhook.http_response",
      ]));
      expect(new Set(webhookSteps.map((step) => step.deliveryId)).size).toBe(3);
      expect(JSON.stringify(webhookSteps)).not.toContain("secret");

      const ignoredResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          object_attributes: {
            ...payload.object_attributes,
            id: 101,
            note: "ordinary comment",
          },
        }),
      });
      expect(ignoredResponse.status).toBe(202);
      expect(store.eventCounts().queued).toBe(queuedConversations + 1);
      expect(info).toHaveBeenCalledWith(
        "GitLab webhook ignored",
        expect.objectContaining({ webhookEventId: "1:101", reason: "not_corvex_command" }),
      );

      const unauthorizedBotResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          user: { id: 3, username: "corvex-bot" },
          object_attributes: {
            ...payload.object_attributes,
            id: 102,
            note: "@corvex-bot /review",
          },
        }),
      });
      expect(unauthorizedBotResponse.status).toBe(403);
      expect(store.eventCounts().queued).toBe(queuedConversations + 1);

      config.fix.enabled = true;
      const fixPayload = {
        ...payload,
        user: { id: 99, username: "developer" },
        object_attributes: {
          ...payload.object_attributes,
          id: 100,
          note: "@corvex-bot /fix handle this error more gracefully",
        },
      };
      const fixResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify(fixPayload),
      });
      expect(fixResponse.status).toBe(202);
      expect(store.eventCounts().queued).toBe(queuedConversations + 2);
      expect(postedNotes).toBe(2);

      const chatRequest = "总结这个 PR\n\n再建议一个标题";
      const chatResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          object_attributes: {
            ...payload.object_attributes,
            id: 103,
            note: `@corvex-bot ${chatRequest}`,
          },
        }),
      });
      expect(chatResponse.status).toBe(202);
      expect(store.eventCounts().queued).toBe(queuedConversations + 3);
      expect(postedNotes).toBe(3);
      expect(store.listEvents("queued", 10).find((event) => event.type === "chat")?.request).toBe(chatRequest);

      const issuePayload = {
        object_kind: "note",
        user: { id: 99, username: "developer" },
        project: { id: 1 },
        object_attributes: {
          id: 104,
          note: "@corvex-bot Is implementing the requested labels feasible?",
          noteable_type: "Issue",
          system: false,
        },
        issue: { iid: 17 },
      };
      const sendIssue = (noteId: number) => fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...issuePayload,
          object_attributes: {
            ...issuePayload.object_attributes,
            id: noteId,
            note: noteId === 104
              ? issuePayload.object_attributes.note
              : "@corvex-bot /implement Add issue labels",
          },
        }),
      });
      expect((await sendIssue(104)).status).toBe(202);
      const assistantEvent = store.listEvents("queued", 10).find((event) => event.type === "implement");
      expect(assistantEvent?.request).toBe("Is implementing the requested labels feasible?");
      config.issue.implementEnabled = true;
      const enabledIssueResponse = await sendIssue(105);
      expect(enabledIssueResponse.status).toBe(202);
      const implementationEvent = store.listEvents("queued", 10).find((event) => event.request === "Add issue labels");
      expect(implementationEvent).toMatchObject({
        targetType: "issue",
        targetIid: 17,
        mrIid: 0,
        request: "Add issue labels",
      });
      expect(postedNotes).toBe(5);

      const eventsResponse = await fetch(`${base}/api/ops/events?status=queued&limit=1`, {
        headers: { authorization },
      });
      expect(eventsResponse.status).toBe(200);
      const events = (await eventsResponse.json()) as { items: Array<{ id: string }>; total: number };
      expect(events.total).toBe(queuedConversations + 5);
      expect(events.items).toHaveLength(1);
      store.startEventTrace({ kind: "event", eventId: events.items[0]!.id }, 1, "llm", "review", "test/model", "review prompt");
      const failedTrace = store.startEventTrace(
        { kind: "event", eventId: events.items[0]!.id },
        1,
        "tool",
        "read_file",
        "",
        '{"path":"missing.vue"}',
      );
      store.finishEventTrace(failedTrace, "failed", 5, undefined, undefined, "ENOENT: file not found");
      const detailResponse = await fetch(`${base}/api/ops/events/${events.items[0]!.id}`, {
        headers: { authorization },
      });
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        status: "queued",
        attempts: [],
        events: expect.arrayContaining([
          expect.objectContaining({ step: "webhook.decode", deliveryId: expect.any(String), eventId: events.items[0]!.id }),
          expect.objectContaining({ step: "webhook.http_response", status: "succeeded", eventId: events.items[0]!.id }),
        ]),
        trajectory: [
          expect.objectContaining({ kind: "tool", errorDetail: "ENOENT: file not found" }),
          expect.objectContaining({ kind: "llm", rawContent: "review prompt" }),
        ],
      });
      expect(
        (await fetch(`${base}/api/ops/events?status=invalid`, { headers: { authorization } })).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${base}/api/ops/events?search=${"x".repeat(101)}`, {
            headers: { authorization },
          })
        ).status,
      ).toBe(400);
    } finally {
      controller.abort();
      await running;
      store.close();
      await new Promise<void>((resolve, reject) =>
        fakeGitLab.close((error) => (error ? reject(error) : resolve())),
      );
      info.mockRestore();
    }
  });

  it("exposes and updates runtime context settings over the operations API", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 凭据与令牌只从环境变量读取，测试用 stubEnv 注入并在结束时还原。
    vi.stubEnv("CORVEX_OPS_USERNAME", "operator");
    vi.stubEnv("CORVEX_OPS_PASSWORD", "a secure password with 16 chars");
    vi.stubEnv("CORVEX_GITLAB_READ_TOKEN", "read");
    vi.stubEnv("CORVEX_GITLAB_TOKEN", "write");
    vi.stubEnv("CORVEX_WEBHOOK_SECRET", "secret");
    const root = await mkdtemp(join(tmpdir(), "corvex-settings-"));
    const configPath = join(root, "config.yaml");
    // agent.enabled=true 且模型密钥来自环境变量：Server 角色下合法，
    // 保存设置时的校验必须按 Server 角色进行，否则会被误判为缺少密钥。
    await writeFile(configPath, JSON.stringify({
      server: { listen: "127.0.0.1:0" },
      gitlab: { base_url: "https://gitlab.example.com" },
      storage: { root, database: join(root, "state.db") },
      agent: { enabled: true },
    }), "utf8");
    const { loadConfig } = await import("../../src/config/config.js");
    const config = await loadConfig(configPath, "server");
    const store = await EventStore.open(":memory:");
    const controller = new AbortController();
    const application = new CorvexServer(
      config,
      store,
      new GitLabClient(config.gitlab.baseUrl, "read", "write"),
      configPath,
    );
    const running = application.run(controller.signal);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          application.getListeningAddress();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const address = application.getListeningAddress();
      const base = `http://127.0.0.1:${address.port}`;
      const authorization = `Basic ${Buffer.from(
        `${config.operations.username}:${config.operations.password}`,
      ).toString("base64")}`;

      const initial = await fetch(`${base}/api/ops/settings`, { headers: { authorization } });
      expect(initial.status).toBe(200);
      const initialBody = await initial.json() as {
        settings: Record<string, number | boolean | string | string[]>;
        effective: Record<string, number | boolean | string | string[]>;
        adjusted: string[];
        overrides: Record<string, string>;
        overrideMeta: Record<string, { updatedAt: string; updatedBy: string }>;
        editable: boolean;
        configPath: string | null;
      };
      expect(initialBody.editable).toBe(true);
      expect(initialBody.configPath).toBe(configPath);
      expect(initialBody.settings).toMatchObject({ context_window: 131_072, summary_enabled: true, response_language: "en" });
      expect(initialBody.overrides).toEqual({});
      // 0 表示自动推导，界面必须拿到生效值，否则看起来像没保存。
      expect(initialBody.effective.max_input_tokens).toBe(131_072 - 4_096 - 2_000);
      expect(initialBody.adjusted).toContain("max_input_tokens");

      // 控制台保存时会提交全部可编辑键；接口也接受部分键，未提交的键保持原值。
      const saved = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ settings: { context_window: 200_000, summary_enabled: false, model: "gpt-4o", response_language: "zh-CN" } }),
      });
      expect(saved.status).toBe(200);
      const savedBody = await saved.json() as typeof initialBody;
      expect(savedBody.settings).toMatchObject({ context_window: 200_000, summary_enabled: false, model: "gpt-4o", response_language: "zh-CN" });
      expect(savedBody.effective).toMatchObject({ context_window: 200_000 });
      expect(savedBody.overrides).toMatchObject({ context_window: "200000", summary_enabled: "false", model: "gpt-4o", response_language: "zh-CN" });
      expect(savedBody.overrideMeta.context_window?.updatedBy).toBe("operator");
      expect(config.agent.contextWindow).toBe(200_000);
      expect(config.agent.summaryEnabled).toBe(false);
      expect(config.agent.model).toBe("gpt-4o");
      expect(config.agent.responseLanguage).toBe("zh-CN");

      // 模型地址和密钥可在 Web 配置；密钥不回显、不进审计，留空表示沿用。
      const secretWrite = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          settings: { model_base_url: "https://api.example.com/v1", model_api_key: "super-secret-key" },
        }),
      });
      expect(secretWrite.status).toBe(200);
      const secretBody = await secretWrite.json() as typeof initialBody;
      expect(secretBody.settings.model_api_key).toBe("");
      expect(secretBody.effective.model_api_key).toBe("");
      expect(secretBody.overrides.model_api_key).toBe("••••••");
      expect(config.agent.apiKey).toBe("super-secret-key");

      const keepSecret = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ settings: { context_window: 200_000 } }),
      });
      expect(keepSecret.status).toBe(200);
      expect(config.agent.apiKey).toBe("super-secret-key");

      // 覆盖项是整份替换：显式提交空对象时，未提交的键回退到配置文件的初始值。
      const reset = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });
      expect(reset.status).toBe(200);
      const resetBody = await reset.json() as typeof initialBody;
      // 密钥留空始终沿用已保存值，其它覆盖项被清空。
      expect(resetBody.overrides).toMatchObject({ model_api_key: "••••••" });
      expect(Object.keys(resetBody.overrides).filter((key) => key !== "model_api_key")).toEqual([]);
      expect(resetBody.settings).toMatchObject({ context_window: 131_072, summary_enabled: true });
      expect(config.agent.contextWindow).toBe(131_072);

      // 非法取值被拒绝，且不改变当前生效值。
      const rejected = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ settings: { context_window: 10 } }),
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json() as { error: string }).error).toContain("context_window");
      expect(config.agent.contextWindow).toBe(131_072);

      const unknown = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ settings: { nope: 1 } }),
      });
      expect(unknown.status).toBe(400);

      expect((await fetch(`${base}/api/ops/settings`, { method: "POST", headers: { authorization } })).status).toBe(405);
      expect((await fetch(`${base}/api/ops/settings`)).status).toBe(401);

      // 每次写入都留下审计：操作者来自控制台凭据，结果记录旧值->新值。
      const audit = store.listAuditEvents().filter((entry) => entry.action === "update_settings");
      expect(audit.length).toBeGreaterThanOrEqual(3);
      expect(audit[0]).toMatchObject({ actorId: 0, resource: "settings:operator" });
      expect(audit.some((entry) => entry.result?.includes("context_window: (initial) -> 200000"))).toBe(true);
      expect(audit.some((entry) => entry.result?.includes("context_window: 200000 -> (initial)"))).toBe(true);
      expect(audit.some((entry) => entry.result?.includes("model_api_key:"))).toBe(true);
      expect(audit.every((entry) => !entry.result?.includes("super-secret-key"))).toBe(true);

      // 模型目录：供应商保存连接参数，其下挂模型；密钥不回显，留空更新不会清掉原密钥。
      expect((await (await fetch(`${base}/api/ops/model-providers`, { headers: { authorization } })).json() as { items: unknown[] }).items).toEqual([]);
      const createProvider = await fetch(`${base}/api/ops/model-providers`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "example", baseUrl: "https://api.example.com/v1", apiKey: "profile-secret" }),
      });
      expect(createProvider.status).toBe(201);
      const createdProvider = await createProvider.json() as { id: string; apiKey: string };
      expect(createdProvider.apiKey).toBe("••••••");

      // 第一个模型自动激活，并立即覆盖内存配置里的模型连接参数。
      const createModel = await fetch(`${base}/api/ops/model-providers/${createdProvider.id}/models`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "gpt-test", contextWindow: 131_072, maxOutputTokens: 8_192 }),
      });
      expect(createModel.status).toBe(201);
      const createdModel = await createModel.json() as { id: string; active: boolean };
      expect(createdModel.active).toBe(true);
      expect(config.agent.model).toBe("gpt-test");
      expect(config.agent.apiKey).toBe("profile-secret");

      const listedProviders = await (await fetch(`${base}/api/ops/model-providers`, { headers: { authorization } })).json() as {
        items: { apiKey: string; models: { name: string }[] }[];
      };
      expect(listedProviders.items[0]?.apiKey).toBe("••••••");
      expect(listedProviders.items[0]?.models.map((model) => model.name)).toEqual(["gpt-test"]);

      // 编辑模型只改模型自己的窗口；密钥留在供应商上，不因留空被清掉。
      const editModel = await fetch(`${base}/api/ops/model-providers/${createdProvider.id}/models/${createdModel.id}`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "gpt-test-2", contextWindow: 200_000, maxOutputTokens: 8_192 }),
      });
      expect(editModel.status).toBe(200);
      expect(config.agent.model).toBe("gpt-test-2");
      expect(config.agent.contextWindow).toBe(200_000);
      expect(config.agent.apiKey).toBe("profile-secret");
      const editProvider = await fetch(`${base}/api/ops/model-providers/${createdProvider.id}`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "example-2", baseUrl: "https://api.example.com/v1", apiKey: "" }),
      });
      expect(editProvider.status).toBe(200);
      expect((await editProvider.json() as { apiKey: string }).apiKey).toBe("••••••");
      expect(config.agent.apiKey).toBe("profile-secret");

      // 保存其它设置时不能把模型连接参数退回配置文件值。
      const languageWrite = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ settings: { response_language: "en" } }),
      });
      expect(languageWrite.status).toBe(200);
      expect(config.agent.model).toBe("gpt-test-2");
      expect(config.agent.contextWindow).toBe(200_000);
      expect(config.agent.apiKey).toBe("profile-secret");

      // 删除模型后自动提升剩余模型；删掉最后一个模型后目录为空。
      expect((await fetch(`${base}/api/ops/model-providers/${createdProvider.id}/models/${createdModel.id}`, {
        method: "DELETE",
        headers: { authorization },
      })).status).toBe(200);
      expect((await fetch(`${base}/api/ops/model-providers/${createdProvider.id}`, {
        method: "DELETE",
        headers: { authorization },
      })).status).toBe(200);
      expect((await (await fetch(`${base}/api/ops/model-providers`, { headers: { authorization } })).json() as { items: unknown[] }).items).toEqual([]);
    } finally {
      controller.abort();
      await running;
      store.close();
      await rm(root, { recursive: true, force: true });
      vi.unstubAllEnvs();
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("stores runtime settings in SQLite even when the server runs without a config file", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const store = await EventStore.open(":memory:");
    const config: CorvexConfig = {
      server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
      operations: { username: "operator", password: "a secure password with 16 chars" },
      gitlab: {
        baseUrl: "https://gitlab.example.com",
        readToken: "read",
        writeToken: "write",
        webhookSecret: "secret",
        blockedUserIds: [],
        botUsername: "corvex",
      },
      storage: { root: ".", database: ":memory:", retentionDays: 90, auditRetentionDays: 365 },
      agent: {
        responseLanguage: "en",
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
        model: "",
        apiKey: "",
        requestTimeout: 120000,
        sessionTimeout: 30 * 60_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        mcpEnabled: false,
        webEnabled: true,
        webBlockedHosts: [],
        skillPaths: [],
        contextWindow: 131_072,
        maxInputTokens: 0,
        historyTokenBudget: 24_000,
        turnToolResultBytes: 512 << 10,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 20_000,
        summaryEnabled: true,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      chat: { historyComments: 20 },
      worker: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    };
    const controller = new AbortController();
    const application = new CorvexServer(config, store, new GitLabClient(config.gitlab.baseUrl, "read", "write"));
    const running = application.run(controller.signal);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          application.getListeningAddress();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const address = application.getListeningAddress();
      const base = `http://127.0.0.1:${address.port}`;
      const authorization = `Basic ${Buffer.from(
        `${config.operations.username}:${config.operations.password}`,
      ).toString("base64")}`;
      const response = await fetch(`${base}/api/ops/settings`, { headers: { authorization } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ editable: true, configPath: null });
      // 没有配置文件时设置仍写进 SQLite，并立即作用于内存配置。
      const write = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          settings: {
            context_window: 200_000,
            agent_request_timeout: 240,
            gitlab_blocked_user_ids: [7, 8],
          },
        }),
      });
      expect(write.status).toBe(200);
      expect(config.agent.contextWindow).toBe(200_000);
      expect(config.agent.requestTimeout).toBe(240_000);
      expect(config.gitlab.blockedUserIds).toEqual([7, 8]);
      expect(store.listRuntimeSettings().find((row) => row.key === "gitlab_blocked_user_ids")?.value)
        .toBe("[7,8]");
    } finally {
      controller.abort();
      await running;
      store.close();
      info.mockRestore();
    }
  });
});
