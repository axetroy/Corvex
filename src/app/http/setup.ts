import type { FastifyInstance } from "fastify";
import { applyRuntimeSettings, validateRuntimeSettings } from "../../config/settings.js";
import type { CorvexConfig } from "../../config/config.js";
import type { GitLabOAuthService } from "../auth/service.js";
import type { AppStore } from "../../store.js";
import { readJsonObject, sendJson } from "./respond.js";

interface SetupContext {
  config: CorvexConfig;
  store: AppStore;
  oauth: GitLabOAuthService;
}

/** 安装向导：仅在 OAuth 未配置时可写，配置存 SQLite，不需要环境变量。 */
export function registerSetupRoutes(app: FastifyInstance, ctx: SetupContext): void {
  app.get("/api/setup/status", async (_request, reply) => {
    sendJson(reply, 200, { configured: ctx.oauth.configured });
  });

  app.post("/api/setup/oauth", async (request, reply) => {
    if (ctx.oauth.configured) {
      sendJson(reply, 409, { error: "GitLab OAuth is already configured" });
      return;
    }
    const body = readJsonObject(request, reply);
    if (!body) return;
    const overrides: Record<string, string> = {};
    const fields: [string, string][] = [
      ["gitlab_base_url", "baseUrl"],
      ["gitlab_oauth_client_id", "clientId"],
      ["gitlab_oauth_client_secret", "clientSecret"],
      ["gitlab_oauth_redirect_uri", "redirectUri"],
    ];
    for (const [key, field] of fields) {
      const value = body[field];
      if (typeof value !== "string") {
        sendJson(reply, 400, { error: `${field} is required` });
        return;
      }
      overrides[key] = value.trim();
    }
    const problems = validateRuntimeSettings(overrides);
    if (
      problems.length > 0 ||
      !overrides.gitlab_base_url ||
      !overrides.gitlab_oauth_client_id ||
      !overrides.gitlab_oauth_client_secret ||
      !overrides.gitlab_oauth_redirect_uri
    ) {
      sendJson(reply, 400, {
        error: problems[0] ?? "GitLab URL and OAuth client ID, secret and redirect URI are all required",
      });
      return;
    }
    for (const [key, value] of Object.entries(overrides)) {
      ctx.store.setRuntimeSetting(key, value, "setup");
    }
    // 内存配置与 SQLite 同步；OAuth 服务读取同一对象，无需重启。
    applyRuntimeSettings(ctx.config, overrides);
    sendJson(reply, 200, { configured: true });
  });
}
