/** 当前登录用户；令牌字段由存储层按请求解密，不写入日志或轨迹。 */
export interface AuthUser {
  id: string;
  gitlabUserId: number;
  username: string;
  name: string;
  avatarUrl: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  /** 管理员可以打开设置页并管理人员。 */
  isAdmin: boolean;
}

/** 管理员视图中的用户摘要，不含任何令牌。 */
export interface ManagedUser {
  id: string;
  gitlabUserId: number;
  username: string;
  name: string;
  avatarUrl: string;
  isAdmin: boolean;
}

/** GitLab OAuth 回调中取得的身份与令牌。 */
export interface GitLabIdentity {
  gitlabUserId: number;
  username: string;
  name: string;
  avatarUrl: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
