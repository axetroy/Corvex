import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, afterEach, expect, it, vi } from "vitest";
import { CorvexServer } from "../../src/app/server.js";
import { ConversationRunner } from "../../src/app/conversation-runner.js";

import type { CorvexConfig } from "../../src/config/config.js";
import { AppStore } from "../../src/store.js";
import { GitLabClient } from "../../src/gitlab/client.js";
import { createTokenCipher } from "../../src/tokens.js";
import { createCorvexHooks } from "../../src/app/hooks.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

/** 测试里的已登录用户：创建本地用户与会话，返回可直接用于 fetch 的 Cookie 头。 */
function sessionHeaders(store: AppStore): Record<string, string> {
  const cipher = createTokenCipher(store.getOrCreateSessionSecret());
  const user = store.upsertUser({
    gitlabUserId: 1,
    username: "operator",
    name: "Operator",
    avatarUrl: "",
    accessToken: "user-token",
    refreshToken: "",
    expiresAt: Date.now() + 3_600_000,
  }, cipher);
  const session = store.createUserSession(user.id, Date.now() + 3_600_000);
  return { cookie: `corvex_session=${session}` };
}

describe("CorvexServer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("authenticates ops routes and serves conversations", async () => {
    // 本用例只验证接口行为，不让对话轮次真正调用模型。
    vi.spyOn(ConversationRunner.prototype, "runTurn").mockResolvedValue(false);
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
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 1 }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const gitlabPort = await listen(fakeGitLab);
    const store = await AppStore.open(":memory:");
    const authHeaders = sessionHeaders(store);
    const nonAdminCipher = createTokenCipher(store.getOrCreateSessionSecret());
    const nonAdmin = store.upsertUser({
      gitlabUserId: 99,
      username: "viewer",
      name: "Viewer",
      avatarUrl: "",
      accessToken: "viewer-token",
      refreshToken: "",
      expiresAt: Date.now() + 3_600_000,
    }, nonAdminCipher);
    const viewerSession = store.createUserSession(nonAdmin.id, Date.now() + 3_600_000);
    const viewerHeaders = { cookie: `corvex_session=${viewerSession}` };
    const config: CorvexConfig = {
      server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
      operations: { username: "", password: "" },
      gitlab: {
        baseUrl: `http://127.0.0.1:${gitlabPort}`,
        readToken: "read",
        writeToken: "write",
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
        baseUrl: "https://api.openai.com/v1",
        model: "test-model",
        apiKey: "",
        requestTimeout: 120000,
        sessionTimeout: 30 * 60_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        webEnabled: true,
        webBlockedHosts: [],
        skillPaths: [],
      },
    };
    const controller = new AbortController();
    const hooks = createCorvexHooks();
    const tapped: string[] = [];
    hooks.serverBeforeListen.tap("test", async () => { tapped.push("beforeListen"); });
    hooks.serverAfterListen.tap("test", async () => { tapped.push("afterListen"); });
    hooks.serverBeforeClose.tap("test", async () => { tapped.push("beforeClose"); });
    let notifyCleanup!: () => void;
    // 启动清理在 serverAfterListen 里异步执行，不能用固定延时等待，直接由钩子信号驱动。
    const cleanupCalled = new Promise<void>((resolve) => {
      notifyCleanup = resolve;
    });
    const cleanupHook = vi.fn(() => notifyCleanup());
    hooks.storageCleanup.tap({ name: "test-cleanup", stage: 80 }, cleanupHook);
    const application = new CorvexServer(
      config,
      store,
      new GitLabClient(config.gitlab.baseUrl, "read", "write"),
      undefined,
      hooks,
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
      expect(tapped).toEqual(["beforeListen", "afterListen"]);
      await cleanupCalled;
      expect(cleanupHook).toHaveBeenCalled();
      expect(cleanupHook.mock.calls[0]?.[0]).toMatchObject({ source: "startup", pruneHistory: true });
      const base = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const landing = await fetch(`${base}/`);
      expect(landing.status).toBe(200);
      expect(await landing.text()).toContain("Corvex");
      expect((await fetch(`${base}/api/ops/admin/users`, { headers: viewerHeaders })).status).toBe(403);
      expect((await fetch(`${base}/api/ops/settings`, { headers: viewerHeaders })).status).toBe(403);
      expect((await fetch(`${base}/api/ops/admin/users`, { headers: authHeaders })).status).toBe(200);
      // 未登录且未配置 OAuth 时进入安装向导（跟随重定向后返回页面）。
      expect((await fetch(`${base}/ops`)).status).toBe(200);
      expect((await fetch(`${base}/api/ops/overview`)).status).toBe(401);

      expect((await fetch(`${base}/api/ops/overview`, { headers: { authorization: "Basic wrong" } })).status).toBe(401);
      expect((await fetch(`${base}/api/ops/overview`, { headers: authHeaders })).status).toBe(200);
      expect(
        (await fetch(`${base}/api/ops/overview`, { method: "POST", headers: authHeaders })).status,
      ).toBe(405);
      const dashboard = await fetch(`${base}/ops`, { headers: authHeaders });
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
      const refreshedDashboard = await fetch(`${base}/ops`, { headers: authHeaders });
      const refreshedMarkup = await refreshedDashboard.text();
      expect(/property="csp-nonce" nonce="([A-Za-z0-9_-]+)"/.exec(refreshedMarkup)?.[1]).not.toBe(nonce);
      // 控制台脚本带内容哈希，测试从页面标记中取出真实地址再校验可访问性。
      const scriptPath = /src="([^"]+\.js)"/.exec(markup)?.[1];
      expect(scriptPath).toBeTruthy();
      const script = await fetch(`${base}${scriptPath}`, { headers: authHeaders });
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("javascript");
      expect(markup).toContain('name="robots"');
      expect(dashboard.headers.get("x-robots-tag")).toContain("noindex");
      expect((await fetch(`${base}/ops`, { method: "HEAD", headers: authHeaders })).status).toBe(200);
      expect((await fetch(`${base}/ops`, { method: "POST", headers: authHeaders })).status).toBe(405);
      const overview = await fetch(`${base}/api/ops/overview`, { headers: authHeaders });
      expect(overview.status).toBe(200);
      expect(overview.headers.get("x-content-type-options")).toBe("nosniff");
      const projectsResponse = await fetch(`${base}/api/ops/projects?search=project`, { headers: authHeaders });
      expect(projectsResponse.status).toBe(200);
      expect(await projectsResponse.json()).toMatchObject([{ id: 2, path_with_namespace: "group/project" }]);
      const projectResponse = await fetch(`${base}/api/ops/projects/2`, { headers: authHeaders });
      expect(projectResponse.status).toBe(200);
      expect(await projectResponse.json()).toMatchObject({
        id: 2,
        path_with_namespace: "group/project",
        description: "Test project",
        web_url: `http://127.0.0.1:${gitlabPort}/group/project`,
        http_url_to_repo: `http://127.0.0.1:${gitlabPort}/group/project.git`,
        default_branch: "main",
      });
      expect((await fetch(`${base}/api/ops/projects/0`, { headers: authHeaders })).status).toBe(400);
      const branchesResponse = await fetch(`${base}/api/ops/projects/2/branches`, { headers: authHeaders });
      expect(await branchesResponse.json()).toMatchObject([{ name: "main" }]);
      // 未选择模型时不允许发起会话。
      const selectedModel = config.agent.model;
      config.agent.model = "";
      const noModelResponse = await fetch(`${base}/api/ops/conversations`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ projectId: 2, targetBranch: "main", message: "Explain this repository" }),
      });
      expect(noModelResponse.status).toBe(409);
      expect(store.listConversations(50, 0).total).toBe(0);
      config.agent.model = selectedModel;

      const createdConversationResponse = await fetch(`${base}/api/ops/conversations`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: 2,
          targetBranch: "main",
          message: "Explain this repository",
        }),
      });
      expect(createdConversationResponse.status).toBe(202);
      const createdConversation = await createdConversationResponse.json() as { conversationId: string; turnId: string };
      // 对话轮次不进入事件队列，只排队等待内联执行。
      const conversationDetailResponse = await fetch(`${base}/api/ops/conversations/${createdConversation.conversationId}`, { headers: authHeaders });
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
      expect(conversationDetail.systemPrompt).toContain("general-purpose collaboration assistant");
      // 单轮对话记录端点返回该轮的轨迹与执行步骤，并拒绝跨对话或未知轮次。
      const conversationTurnResponse = await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/turns/${createdConversation.turnId}`,
        { headers: authHeaders },
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
        { headers: authHeaders },
      )).status).toBe(404);
      expect((await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/turns/missing-turn`,
        { headers: authHeaders },
      )).status).toBe(404);
      // 整段对话轨迹端点把全部轮次合并成一条时间线，未知对话返回 404。
      const conversationTurnsResponse = await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/turns`,
        { headers: authHeaders },
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
        { headers: authHeaders },
      )).status).toBe(404);
      // 统计端点汇总整段对话的用量与逐轮明细，未知对话返回 404。
      const conversationStatsResponse = await fetch(
        `${base}/api/ops/conversations/${createdConversation.conversationId}/stats`,
        { headers: authHeaders },
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
        { headers: authHeaders },
      )).status).toBe(404);
      const concurrentReplyResponse = await fetch(`${base}/api/ops/conversations/${createdConversation.conversationId}/messages`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ message: "A concurrent follow-up" }),
      });
      expect(concurrentReplyResponse.status).toBe(409);
      const secondConversationResponse = await fetch(`${base}/api/ops/conversations`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: 2,
          targetBranch: "main",
          message: "Summarize the request flow",
        }),
      });
      expect(secondConversationResponse.status).toBe(202);
      const secondConversation = await secondConversationResponse.json() as { conversationId: string; turnId: string };
      expect(secondConversation.turnId).toBeTruthy();
      // 流式正文端点与其它轨迹端点一样先校验轮次归属，未知轮次返回 404。
      expect((await fetch(
        `${base}/api/ops/conversations/${secondConversation.conversationId}/turns/missing-turn/stream`,
        { headers: authHeaders },
      )).status).toBe(404);
      // 已结束的轮次不需要保持连接：端点立即以 done 收尾，界面随即刷新详情。
      expect(store.claimConversationTurn(secondConversation.turnId)).toBeTruthy();
      store.finishConversationTurn(secondConversation.turnId, "Streamed answer");
      const streamResponse = await fetch(
        `${base}/api/ops/conversations/${secondConversation.conversationId}/turns/${secondConversation.turnId}/stream`,
        { headers: authHeaders },
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
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      expect(archiveResponse.status).toBe(200);
      expect(await archiveResponse.json()).toMatchObject({ archived: true });
      const archivedList = await fetch(`${base}/api/ops/conversations?archived=true`, { headers: authHeaders });
      expect(await archivedList.json()).toMatchObject({
        items: [{ id: secondConversation.conversationId, archived: true }],
      });
      const activeList = await fetch(`${base}/api/ops/conversations?archived=false`, { headers: authHeaders });
      expect((await activeList.json() as { items: { id: string }[] }).items.map((item) => item.id))
        .not.toContain(secondConversation.conversationId);
      expect((await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}`, { headers: authHeaders })).status).toBe(200);
      expect((await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}/archive`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({}),
      })).status).toBe(400);
      const archiveOffResponse = await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}/archive`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      expect(archiveOffResponse.status).toBe(200);
      const deleteResponse = await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      expect(deleteResponse.status).toBe(200);
      expect((await fetch(`${base}/api/ops/conversations/${secondConversation.conversationId}`, { headers: authHeaders })).status).toBe(404);
      // 存储清理：预览不删文件，但会留下一条可查询的记录。
      const cleanupPreview = await fetch(`${base}/api/ops/storage/cleanup`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ olderThanDays: 1, apply: false }),
      });
      expect(cleanupPreview.status).toBe(200);
      expect(await cleanupPreview.json()).toMatchObject({ applied: false, olderThanDays: 1 });
      expect((await fetch(`${base}/api/ops/storage/cleanup`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ olderThanDays: 0, apply: false }),
      })).status).toBe(400);
      const cleanupRecords = await fetch(`${base}/api/ops/storage/cleanups`, { headers: authHeaders });
      expect((await cleanupRecords.json() as { items: { source: string; applied: boolean; olderThanDays: number }[] }).items)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ source: "ops-console", applied: false, olderThanDays: 1 }),
        ]));
      expect((await fetch(`${base}/ops/assets/missing.js`)).status).toBe(503);
      expect((await fetch(`${base}/ops/assets/../index.html`, { headers: authHeaders })).status).toBe(404);
      // 首次安装通过 /api/setup/oauth 写入 OAuth 配置，不需要环境变量。
      expect((await (await fetch(`${base}/api/setup/status`)).json()).configured).toBe(false);
      const setup = await fetch(`${base}/api/setup/oauth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: "https://gitlab.example.com",
          clientId: "client",
          clientSecret: "secret",
          redirectUri: "https://corvex.example.com/auth/gitlab/callback",
        }),
      });
      expect(setup.status).toBe(200);
      expect((await (await fetch(`${base}/api/setup/status`)).json()).configured).toBe(true);
      expect(store.getRuntimeSetting("gitlab_base_url")).toBe("https://gitlab.example.com");
      expect(store.getRuntimeSetting("gitlab_oauth_client_id")).toBe("client");
    } finally {
      controller.abort();
      await running;
      expect(tapped).toContain("beforeClose");
      store.close();
      await new Promise<void>((resolve, reject) =>
        fakeGitLab.close((error) => (error ? reject(error) : resolve())),
      );
      info.mockRestore();
    }
  }, 20_000);

  it("exposes and updates runtime context settings over the operations API", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 令牌可以用环境变量兜底，测试用 stubEnv 注入并在结束时还原。
    vi.stubEnv("CORVEX_GITLAB_READ_TOKEN", "read");
    vi.stubEnv("CORVEX_GITLAB_TOKEN", "write");
    vi.stubEnv("CORVEX_WEBHOOK_SECRET", "secret");
    const root = await mkdtemp(join(tmpdir(), "corvex-settings-"));
    const configPath = join(root, "config.yaml");
    // 模型密钥在控制台保存；保存设置时按 Server 角色校验。
    await writeFile(configPath, JSON.stringify({
      server: { listen: "127.0.0.1:0" },
      gitlab: { base_url: "https://gitlab.example.com" },
      storage: { root, database: join(root, "state.db") },
      agent: {},
    }), "utf8");
    const { loadConfig } = await import("../../src/config/config.js");
    const config = await loadConfig(configPath, "server");
    // 模拟运维台已保存的控制台凭据。
    config.operations.username = "operator";
    config.operations.password = "a secure password with 16 chars";
    const store = await AppStore.open(":memory:");
    const authHeaders = sessionHeaders(store);
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

      const initial = await fetch(`${base}/api/ops/settings`, { headers: authHeaders });
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
        headers: { ...authHeaders, "content-type": "application/json" },
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
        headers: { ...authHeaders, "content-type": "application/json" },
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
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ settings: { context_window: 200_000 } }),
      });
      expect(keepSecret.status).toBe(200);
      expect(config.agent.apiKey).toBe("super-secret-key");

      // GitLab 令牌同样只在 Web 保存；留空表示保留已保存值。
      const credentialsWrite = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          settings: {
            gitlab_read_token: "read-from-console",
            gitlab_token: "write-from-console",
          },
        }),
      });
      expect(credentialsWrite.status).toBe(200);
      const credentialsBody = await credentialsWrite.json() as typeof initialBody;
      expect(credentialsBody.overrides.gitlab_read_token).toBe("••••••");
      expect(config.gitlab.readToken).toBe("read-from-console");
      expect(config.gitlab.writeToken).toBe("write-from-console");

      // 显式留空的敏感字段不会覆盖已保存值。
      const blankCredentials = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          settings: { gitlab_read_token: "", gitlab_token: "" },
        }),
      });
      expect(blankCredentials.status).toBe(200);
      expect(config.gitlab.readToken).toBe("read-from-console");

      const keepCredentials = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ settings: { context_window: 200_000 } }),
      });
      expect(keepCredentials.status).toBe(200);
      expect(config.gitlab.readToken).toBe("read-from-console");

      // 覆盖项是整份替换：显式提交空对象时，未提交的键回退到配置文件的初始值。
      const reset = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });
      expect(reset.status).toBe(200);
      const resetBody = await reset.json() as typeof initialBody;
      // 密钥留空始终沿用已保存值，其它覆盖项被清空。
      expect(resetBody.overrides).toMatchObject({ model_api_key: "••••••" });
      expect(Object.keys(resetBody.overrides).filter((key) => ![
        "model_api_key",
        "gitlab_read_token",
        "gitlab_token",
      ].includes(key))).toEqual([]);
      expect(resetBody.settings).toMatchObject({ context_window: 131_072, summary_enabled: true });
      expect(config.agent.contextWindow).toBe(131_072);

      // 非法取值被拒绝，且不改变当前生效值。
      const rejected = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ settings: { context_window: 10 } }),
      });
      expect(rejected.status).toBe(400);
      expect((await rejected.json() as { error: string }).error).toContain("context_window");
      expect(config.agent.contextWindow).toBe(131_072);

      const unknown = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ settings: { nope: 1 } }),
      });
      expect(unknown.status).toBe(400);

      expect((await fetch(`${base}/api/ops/settings`, { method: "POST", headers: authHeaders })).status).toBe(405);
      expect((await fetch(`${base}/api/ops/settings`)).status).toBe(401);

      // 每次写入都留下审计：结果记录旧值->新值。
      const audit = store.listAuditEvents().filter((entry) => entry.action === "update_settings");
      expect(audit.length).toBeGreaterThanOrEqual(3);
      expect(audit[0]).toMatchObject({ actorId: 0, resource: "settings:operator" });
      expect(audit.some((entry) => entry.result?.includes("context_window: (initial) -> 200000"))).toBe(true);
      expect(audit.some((entry) => entry.result?.includes("context_window: 200000 -> (initial)"))).toBe(true);
      expect(audit.some((entry) => entry.result?.includes("model_api_key:"))).toBe(true);
      expect(audit.every((entry) => !entry.result?.includes("super-secret-key"))).toBe(true);

      // 模型目录：供应商保存连接参数，其下挂模型；密钥不回显，留空更新不会清掉原密钥。
      expect((await (await fetch(`${base}/api/ops/model-providers`, { headers: authHeaders })).json() as { items: unknown[] }).items).toEqual([]);
      const createProvider = await fetch(`${base}/api/ops/model-providers`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "example", baseUrl: "https://api.example.com/v1", apiKey: "profile-secret" }),
      });
      expect(createProvider.status).toBe(201);
      const createdProvider = await createProvider.json() as { id: string; apiKey: string };
      expect(createdProvider.apiKey).toBe("••••••");

      // 第一个模型自动激活，并立即覆盖内存配置里的模型连接参数。
      const createModel = await fetch(`${base}/api/ops/model-providers/${createdProvider.id}/models`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "gpt-test", contextWindow: 131_072, maxOutputTokens: 8_192 }),
      });
      expect(createModel.status).toBe(201);
      const createdModel = await createModel.json() as { id: string; active: boolean };
      expect(createdModel.active).toBe(true);
      expect(config.agent.model).toBe("gpt-test");
      expect(config.agent.apiKey).toBe("profile-secret");

      const listedProviders = await (await fetch(`${base}/api/ops/model-providers`, { headers: authHeaders })).json() as {
        items: { apiKey: string; models: { name: string }[] }[];
      };
      expect(listedProviders.items[0]?.apiKey).toBe("••••••");
      expect(listedProviders.items[0]?.models.map((model) => model.name)).toEqual(["gpt-test"]);

      // 编辑模型只改模型自己的窗口；密钥留在供应商上，不因留空被清掉。
      const editModel = await fetch(`${base}/api/ops/model-providers/${createdProvider.id}/models/${createdModel.id}`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "gpt-test-2", contextWindow: 200_000, maxOutputTokens: 8_192 }),
      });
      expect(editModel.status).toBe(200);
      expect(config.agent.model).toBe("gpt-test-2");
      expect(config.agent.contextWindow).toBe(200_000);
      expect(config.agent.apiKey).toBe("profile-secret");
      const editProvider = await fetch(`${base}/api/ops/model-providers/${createdProvider.id}`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ name: "example-2", baseUrl: "https://api.example.com/v1", apiKey: "" }),
      });
      expect(editProvider.status).toBe(200);
      expect((await editProvider.json() as { apiKey: string }).apiKey).toBe("••••••");
      expect(config.agent.apiKey).toBe("profile-secret");

      // 保存其它设置时不能把模型连接参数退回配置文件值。
      const languageWrite = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ settings: { response_language: "en" } }),
      });
      expect(languageWrite.status).toBe(200);
      expect(config.agent.model).toBe("gpt-test-2");
      expect(config.agent.contextWindow).toBe(200_000);
      expect(config.agent.apiKey).toBe("profile-secret");

      // 删除模型后自动提升剩余模型；删掉最后一个模型后目录为空。
      expect((await fetch(`${base}/api/ops/model-providers/${createdProvider.id}/models/${createdModel.id}`, {
        method: "DELETE",
        headers: authHeaders,
      })).status).toBe(200);
      expect((await fetch(`${base}/api/ops/model-providers/${createdProvider.id}`, {
        method: "DELETE",
        headers: authHeaders,
      })).status).toBe(200);
      expect((await (await fetch(`${base}/api/ops/model-providers`, { headers: authHeaders })).json() as { items: unknown[] }).items).toEqual([]);
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
    const store = await AppStore.open(":memory:");
    const authHeaders = sessionHeaders(store);
    const config: CorvexConfig = {
      server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
      operations: { username: "operator", password: "a secure password with 16 chars" },
      gitlab: {
        baseUrl: "https://gitlab.example.com",
        readToken: "read",
        writeToken: "write",
        blockedUserIds: [],
        botUsername: "corvex",
      },
      storage: { root: ".", database: ":memory:", retentionDays: 90, auditRetentionDays: 365 },
      agent: {
        responseLanguage: "en",
        baseUrl: "https://api.openai.com/v1",
        model: "test-model",
        apiKey: "",
        requestTimeout: 120000,
        sessionTimeout: 30 * 60_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
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
      const response = await fetch(`${base}/api/ops/settings`, { headers: authHeaders });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ editable: true, configPath: null });
      // 没有配置文件时设置仍写进 SQLite，并立即作用于内存配置。
      const write = await fetch(`${base}/api/ops/settings`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          settings: {
            context_window: 200_000,
            agent_request_timeout: 240,
            web_blocked_hosts: ["example.com"],
          },
        }),
      });
      expect(write.status).toBe(200);
      expect(config.agent.contextWindow).toBe(200_000);
      expect(config.agent.requestTimeout).toBe(240_000);
      expect(config.agent.webBlockedHosts).toEqual(["example.com"]);
      expect(store.listRuntimeSettings().find((row) => row.key === "web_blocked_hosts")?.value)
        .toBe('["example.com"]');
    } finally {
      controller.abort();
      await running;
      store.close();
      info.mockRestore();
    }
  });
});
