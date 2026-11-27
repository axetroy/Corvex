/**
 * 会话提交的署名约定：author 一律是发起会话的用户，Agent 只出现在 trailer 里。
 * 这条规则由 GitManager 在构造 commit-tree 参数时强制执行，不依赖提示词。
 */

export interface CommitAuthor {
  name: string;
  email: string;
}

/** 运行时可配置的提交署名策略；由管理中心设置提供。 */
export interface CommitPolicy {
  /** 追加到提交信息末尾的 trailer；空字符串表示不追加。 */
  trailer: string;
  /** 找不到会话拥有者时使用的作者身份；绝不写成 Agent。 */
  fallback: CommitAuthor;
}

function withoutTrailer(message: string): string {
  return message.trim().split(/\r?\n/)
    .filter((line) => !line.toLowerCase().startsWith("assisted-by:"))
    .join("\n")
    .trim();
}

/** 保证提交信息末尾恰好有一条配置的署名 trailer；留空时不追加。 */
export function withCommitTrailer(message: string, trailer: string): string {
  const body = withoutTrailer(message);
  const configured = trailer.trim();
  if (!configured) return body;
  return body ? `${body}\n\n${configured}` : configured;
}

/** 比较用户给出的提交信息时忽略 trailer，避免自身被当成差异。 */
export function userCommitMessage(message: string): string {
  return withoutTrailer(message);
}

/** 用服务端已知的用户信息构造作者身份；邮箱用 GitLab noreply 形式，不暴露真实邮箱。 */
export function authorFromUser(
  user: { name?: string; username?: string } | undefined,
  gitlabHost: string,
  fallback: CommitAuthor = { name: "Corvex", email: "no.reply@corvex-agent.com" },
): CommitAuthor {
  const username = user?.username?.trim() || "";
  const name = user?.name?.trim() || username || fallback.name;
  const host = gitlabHost.trim() || "localhost";
  const email = username ? `${username}@users.noreply.${host}` : fallback.email;
  return { name: name.replace(/[\r\n]/g, " "), email };
}

/** commit-tree 的统一参数：-c 覆盖作者并关闭签名，避免依赖镜像里的 git 配置。 */
export function commitTreeArgs(author: CommitAuthor, args: readonly string[]): string[] {
  return [
    "-c", `user.name=${author.name}`,
    "-c", `user.email=${author.email}`,
    "-c", "commit.gpgsign=false",
    "commit-tree", ...args,
  ];
}
