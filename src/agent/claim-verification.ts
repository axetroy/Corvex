/**
 * 确定性声明校验：模型在最终回答里声称「已发布 / 已评论 / 已合并」时，
 * 用本轮真实工具调用记录核对，防止仅凭对话文本臆测自己做过的事。
 *
 * 只覆盖高风险且能明确映射到工具的动作；不判断观点、计划或推测性表述。
 */

export type ClaimKind = "publish" | "comment" | "merge" | "approve" | "delete" | "fixed" | "done";

interface ClaimRule {
  kind: ClaimKind;
  zh: RegExp[];
  en: RegExp[];
  tools: readonly string[];
}

const rules: readonly ClaimRule[] = [
  {
    kind: "publish",
    zh: [/(?:发布|推送)(?:到|至)\s*(?:GitLab|分支|远端|远程)/i, /已(?:成功)?(?:调用|执行)\s*git_publish/, /git_publish\s*(?:成功|完成)/i],
    en: [/\bI\s+(?:have\s+)?(?:published|pushed)\b/i, /\b(?:published|pushed)\s+(?:to\s+)?(?:GitLab|a branch|the remote)\b/i],
    tools: ["git_publish", "git_push_branch", "publish", "pushBranch", "push"],
  },
  {
    kind: "comment",
    zh: [/已(?:经)?(?:发布|发表|添加|留下)?\s*(?:一条)?评论/, /评论(?:已|已经)(?:发布|发表)/, /已(?:在|给).*(?:发|写)评论/, /已发布.*note/i],
    en: [/\bI\s+(?:have\s+)?(?:commented|left)\b/i, /\bI\s+(?:have\s+)?posted\s+(?:a|the)\s+comment\b/i, /\b(?:comment|note)\s+(?:has been|was)\s+posted\b/i],
    tools: ["post_mr_note", "post_issue_note", "update_mr_note", "delete_mr_note", "postMergeRequestNote", "postIssueNote"],
  },
  {
    kind: "merge",
    zh: [/已(?:经)?合并/, /合并(?:到|至|完成)/, /状态(?:是|为).*merged/i, /已合并到/],
    en: [/\bI\s+(?:have\s+)?merged\b/i, /\b(?:we|the\s+system)\s+merged\b/i, /\bhas been merged\b/i, /\bmerged\s+(?:the\s+)?(?:MR|merge request)\b/i],
    tools: ["merge_merge_request", "git_merge", "mergeMergeRequest", "merge"],
  },
  {
    kind: "approve",
    zh: [/已(?:经)?(?:批准|审批)/, /(?:批准|审批)(?:了|完成)/],
    en: [/\bI\s+(?:have\s+)?approved\b/i, /\bhas been approved\b/i],
    tools: ["approve_merge_request", "approveMergeRequest", "approve"],
  },
  {
    kind: "delete",
    zh: [/已(?:经)?删除/, /删除(?:了|完成)/],
    en: [/\bI\s+(?:have\s+)?(?:deleted|removed)\b/i, /\b(?:deleted|removed)\s+(?:the|an|a|this|that)\s+\w+/i, /\bhas been (?:deleted|removed)\b/i],
    tools: ["delete_merge_request", "delete_issue", "delete_mr_note", "delete_issue_note", "deleteFile", "delete"],
  },
  {
    // 「已修复 / 已完成」需要至少一次回读或 diff 验证，否则只是模型自述。
    kind: "fixed",
    zh: [/已(?:经)?(?:修复|改好|处理完)/, /(?:修复|修改)(?:完成|完毕)/],
    en: [/\bI\s+(?:have\s+)?(?:fixed|patched)\b/i, /\b(?:fix|changes?)\s+(?:is|are)\s+(?:done|complete)\b/i],
    tools: ["read_file", "git_diff", "readAllowedFile", "diff", "getWorkspaceDiff"],
  },
  {
    kind: "done",
    zh: [/已(?:经)?(?:完成|做完|搞定)/, /任务完成/],
    en: [/\bI\s+(?:have\s+)?(?:completed|finished)\b/i, /\b(?:task|work)\s+(?:is|has been)\s+(?:done|complete|finished)\b/i],
    tools: ["read_file", "git_diff", "git_status", "readAllowedFile", "diff", "getWorkspaceDiff", "status"],
  },
];

export interface ClaimVerificationResult {
  /** 本轮被判定为「未验证」的声明类型。 */
  unverified: ClaimKind[];
  /** 用于展示的简短说明。 */
  detail: string;
}

/**
 * 核对最终回答中的高风险声明。只有回答确实包含该动作表述、且本轮没有任何对应工具调用时才计入。
 * `verifiedActions` 允许调用方补充由系统代执行、未走 Pi 工具的动作（如自动创建 MR）。
 */
export function verifyAnswerClaims(
  answer: string,
  toolNames: readonly string[],
  language: "en" | "zh-CN",
  verifiedActions: ReadonlySet<ClaimKind> = new Set(),
): ClaimVerificationResult {
  if (!answer.trim()) return { unverified: [], detail: "" };
  const called = new Set(toolNames);
  const unverified: ClaimKind[] = [];
  for (const rule of rules) {
    if (verifiedActions.has(rule.kind)) continue;
    const patterns = language === "zh-CN" ? rule.zh : rule.en;
    if (!patterns.some((pattern) => pattern.test(answer))) continue;
    if (rule.tools.some((tool) => called.has(tool))) continue;
    unverified.push(rule.kind);
  }
  const labels: Record<ClaimKind, { en: string; zh: string }> = {
    publish: { en: "publish", zh: "发布" },
    comment: { en: "comment", zh: "评论" },
    merge: { en: "merge", zh: "合并" },
    approve: { en: "approve", zh: "审批" },
    delete: { en: "delete", zh: "删除" },
    fixed: { en: "fix", zh: "修复" },
    done: { en: "completion", zh: "完成" },
  };
  const detail = unverified.length === 0
    ? ""
    : language === "zh-CN"
      ? `检测到 ${unverified.map((kind) => labels[kind].zh).join("、")} 的声明，但本轮没有对应的工具调用记录；请以实际操作为准。`
      : `The answer claims ${unverified.map((kind) => labels[kind].en).join(", ")} but this turn has no matching tool call; treat it as unverified.`;
  return { unverified, detail };
}
