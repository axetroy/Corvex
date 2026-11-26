import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { AppStore } from "../../src/store.js";
import { createTokenCipher } from "../../src/tokens.js";
import { GitLabOAuthService, UserDisabledError } from "../../src/app/auth/service.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

describe("disabled users cannot sign in", () => {
  let gitlab: ReturnType<typeof createServer> | undefined;
  let store: AppStore | undefined;

  afterEach(async () => {
    store?.close();
    store = undefined;
    if (gitlab?.listening) await new Promise<void>((resolve) => gitlab!.close(() => resolve()));
    gitlab = undefined;
  });

  it("rejects OAuth completion for a disabled user without creating a session", async () => {
    gitlab = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("/oauth/token")) {
        response.end(JSON.stringify({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600 }));
        return;
      }
      response.end(JSON.stringify({ id: 77, username: "disabled", name: "Disabled User", avatar_url: "" }));
    });
    const port = await listen(gitlab);
    store = await AppStore.open(":memory:");
    const cipher = createTokenCipher(store.getOrCreateSessionSecret());
    const user = store.upsertUser({
      gitlabUserId: 77, username: "disabled", name: "Disabled User", avatarUrl: "",
      accessToken: "revoked-token", refreshToken: "revoked-refresh", expiresAt: Date.now() + 3_600_000,
    }, cipher);
    // 先降权（至少一名管理员），再禁用。
    const second = store.upsertUser({
      gitlabUserId: 78, username: "admin", name: "Admin", avatarUrl: "",
      accessToken: "admin-token", refreshToken: "", expiresAt: Date.now() + 3_600_000,
    }, cipher);
    expect(store.setUserAdmin(second.id, true)).toBe(true);
    expect(store.setUserAdmin(user.id, false)).toBe(true);
    expect(store.setUserDisabled(user.id, true)).toBe(true);

    const config = {
      gitlab: {
        baseUrl: `http://127.0.0.1:${port}`,
        oauthClientId: "client", oauthClientSecret: "secret",
        oauthRedirectUri: "http://127.0.0.1/auth/gitlab/callback",
      },
    } as unknown as CorvexConfig;
    const oauth = new GitLabOAuthService(config, store, cipher);

    await expect(oauth.complete("auth-code")).rejects.toBeInstanceOf(UserDisabledError);
    // 没有新会话，令牌也没有被 OAuth 复活。
    expect(store.listUsers().find((item) => item.id === user.id)?.disabled).toBe(true);
    expect(store.readUser(user.id, cipher)?.accessToken).toBe("");
  });
});
