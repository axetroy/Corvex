import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorvexServer } from "../../src/app/server.js";
import { AppStore } from "../../src/store.js";
import { createTokenCipher } from "../../src/tokens.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { ConversationRunner } from "../../src/app/conversation-runner.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

describe("GitLab token refresh failure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("invalidates the session and returns 401 when refresh fails", async () => {
    // 模拟 OAuth token 端点返回 400：refresh token 已失效。
    const fakeGitLab = createServer((request, response) => {
      if (request.method === "POST" && request.url?.includes("/oauth/token")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const gitlabPort = await listen(fakeGitLab);
    const store = await AppStore.open(":memory:");
    const cipher = createTokenCipher(store.getOrCreateSessionSecret());
    const user = store.upsertUser({
      gitlabUserId: 1,
      username: "operator",
      name: "Operator",
      avatarUrl: "",
      accessToken: "expired-token",
      refreshToken: "expired-refresh-token",
      expiresAt: Date.now() - 60_000, // 已过期，触发 refresh
    }, cipher);
    const sessionId = store.createUserSession(user.id, Date.now() + 3_600_000);

    const config: CorvexConfig = {
      server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
      operations: { username: "", password: "" },
      gitlab: {
        baseUrl: `http://127.0.0.1:${gitlabPort}`,
        blockedUserIds: [],
        botUsername: "corvex-bot",
        oauthClientId: "test-client",
        oauthClientSecret: "test-secret",
        oauthRedirectUri: "http://127.0.0.1/auth/gitlab/callback",
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

    vi.spyOn(ConversationRunner.prototype, "runTurn").mockResolvedValue(false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const application = new CorvexServer(config, store);
    const running = application.run(controller.signal);
    try {
      for (let i = 0; i < 20; i++) {
        try { application.getListeningAddress(); break; } catch { await new Promise((r) => setTimeout(r, 10)); }
      }
      const base = `http://127.0.0.1:${application.getListeningAddress().port}`;
      const headers = { cookie: `corvex_session=${sessionId}` };
      const first = await fetch(`${base}/api/ops/conversations?limit=1`, { headers, cache: "no-store" });
      expect(first.status).toBe(401);
      expect(await first.json()).toMatchObject({ error: "authentication required" });
      // 会话应已被删除，后续请求依然 401。
      expect(store.readUserSession(sessionId)).toBeUndefined();
      const second = await fetch(`${base}/api/ops/conversations?limit=1`, { headers, cache: "no-store" });
      expect(second.status).toBe(401);
    } finally {
      controller.abort();
      await running;
      store.close();
      await new Promise<void>((resolve) => fakeGitLab.close(() => resolve()));
    }
  });
});
