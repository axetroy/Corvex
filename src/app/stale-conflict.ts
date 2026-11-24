/**
 * 轮次过期时生成可诊断的信息：既写进 Trace 的 context 轨迹，也进入轮次的失败原因。
 * 只使用 GitLab 分支/提交接口返回的 bounded 文本，不把请求头或令牌带进去。
 */
export interface StaleConflictDetail {
  authorName?: string;
  title?: string;
  committedDate?: string;
  /** 提交详情查询失败时的说明；分支接口自带的标题仍会保留。 */
  lookupError?: string;
}

export interface StaleConflictNote {
  traceName: string;
  input: string;
  output: string;
  message: string;
}

export function buildStaleConflictNote(
  expectedSha: string,
  actualSha: string,
  branch: string,
  detail: StaleConflictDetail = {},
): StaleConflictNote {
  const by = detail.authorName ? ` by ${detail.authorName}` : "";
  const subject = detail.title ? `: ${detail.title}` : "";
  const extra = detail.lookupError ? ` (commit lookup failed: ${detail.lookupError})` : "";
  return {
    traceName: "stale.branch_conflict",
    input: JSON.stringify({ expectedSha, actualSha, branch }),
    output: JSON.stringify({
      actualSha,
      ...(detail.authorName ? { authorName: detail.authorName } : {}),
      ...(detail.title ? { title: detail.title } : {}),
      ...(detail.committedDate ? { committedDate: detail.committedDate } : {}),
      ...(detail.lookupError ? { lookupError: detail.lookupError } : {}),
    }),
    message:
      `The branch ${branch} moved from ${expectedSha.slice(0, 12)} to ${actualSha.slice(0, 12)}${by}${subject}${extra}. ` +
      "Another conversation or user pushed this commit; send a new message to use the current snapshot.",
  };
}
