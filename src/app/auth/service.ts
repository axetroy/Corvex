import type { CorvexConfig } from "../../config/config.js";
import type { EventStore } from "../../events/store.js";
import type { TokenCipher } from "../../tokens.js";
import { gitlabEndpoint } from "../../gitlab/client.js";
import type { AuthUser, GitLabIdentity } from "./model.js";

/** OAuth 回调上携带的授权码交换结果。 */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/** GitLab `/api/v4/user` 的精简身份信息。 */
interface GitLabUserResponse {
  id: number;
  username: string;
  name?: string;
  avatar_url?: string;
}

/** 完成一次 GitLab OAuth 授权码流程，并管理本地会话与令牌刷新。 */
export class GitLabOAuthService {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    private readonly cipher: TokenCipher,
  ) {}

  get configured(): boolean {
    return Boolean(
      this.config.gitlab.baseUrl &&
      this.config.gitlab.oauthClientId &&
      this.config.gitlab.oauthClientSecret &&
      this.config.gitlab.oauthRedirectUri,
    );
  }

  /** 生成跳转到 GitLab 的授权地址；state 由路由写入短时 Cookie 防 CSRF。 */
  authorizationUrl(state: string): string {
    if (!this.configured) throw new Error("GitLab OAuth is not configured");
    const url = new URL(gitlabEndpoint(this.config.gitlab.baseUrl, "oauth/authorize"));
    url.searchParams.set("client_id", this.config.gitlab.oauthClientId);
    url.searchParams.set("redirect_uri", this.config.gitlab.oauthRedirectUri);
    url.searchParams.set("response_type", "code");
    // 会话只需读取用户身份并代表用户调用 GitLab；写操作按用户显式请求进行。
    url.searchParams.set("scope", "api read_user write_repository");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** 用授权码换取令牌、读取用户身份，并创建本地会话。 */
  async complete(code: string): Promise<{ user: AuthUser; sessionId: string }> {
    if (!this.configured) throw new Error("GitLab OAuth is not configured");
    if (!code.trim()) throw new Error("missing authorization code");
    const tokens = await this.requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.gitlab.oauthRedirectUri,
    });
    const identity = await this.readIdentity(tokens);
    const user = this.store.upsertUser(identity, this.cipher);
    const sessionId = this.store.createUserSession(user.id, Date.now() + 7 * 24 * 60 * 60_000);
    return { user, sessionId };
  }

  /** 令牌将过期时用 refresh token 续期；失败时返回原用户，由调用方要求重新登录。 */
  async refresh(user: AuthUser): Promise<AuthUser> {
    if (!user.refreshToken || !this.configured) return user;
    if (user.tokenExpiresAt > Date.now() + 60_000) return user;
    try {
      const tokens = await this.requestToken({
        grant_type: "refresh_token",
        refresh_token: user.refreshToken,
      });
      const identity: GitLabIdentity = {
        gitlabUserId: user.gitlabUserId,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || user.refreshToken,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      };
      this.store.updateUserTokens(user.id, identity, this.cipher);
      return this.store.readUser(user.id, this.cipher) ?? user;
    } catch (error) {
      console.warn("GitLab token refresh failed", { username: user.username, error: String(error) });
      return user;
    }
  }

  private async requestToken(params: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.gitlab.oauthClientId,
      client_secret: this.config.gitlab.oauthClientSecret,
      ...params,
    });
    const response = await fetch(gitlabEndpoint(this.config.gitlab.baseUrl, "oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GitLab OAuth token exchange failed: HTTP ${response.status}`);
    }
    const result = (await response.json()) as TokenResponse;
    if (!result.access_token) throw new Error("GitLab OAuth token response has no access token");
    return result;
  }

  private async readIdentity(tokens: TokenResponse): Promise<GitLabIdentity> {
    const url = gitlabEndpoint(this.config.gitlab.baseUrl, "api/v4/user");
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GitLab user lookup failed: HTTP ${response.status}`);
    }
    const user = (await response.json()) as GitLabUserResponse;
    if (!Number.isSafeInteger(user.id) || !user.username) {
      throw new Error("GitLab user response is invalid");
    }
    return {
      gitlabUserId: user.id,
      username: user.username,
      name: user.name ?? user.username,
      avatarUrl: user.avatar_url ?? "",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? "",
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    };
  }
}
