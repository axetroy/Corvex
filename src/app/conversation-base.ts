/**
 * 轮次开始时计算会话的同步基线。
 *
 * 基线是「本地未发布改动的父提交」，与只用于过期检测的轮次快照分开：
 * - 还有未发布改动：保留原基线，否则改动会变成基于新远点的游离提交；
 * - 基线在功能分支上：保留原基线，否则下一轮退回目标分支会丢掉发布进度；
 * - 基线就在目标分支且没有未发布改动：跟随本轮确认过的远端快照。
 */
export function resolveTurnBaseSha(
  conversationBaseSha: string,
  conversationBaseBranch: string,
  turnHeadSha: string,
  targetBranch: string,
  hasUnpublishedChanges: boolean,
): string {
  if (hasUnpublishedChanges) return conversationBaseSha || turnHeadSha;
  if (conversationBaseBranch && conversationBaseBranch !== targetBranch) {
    return conversationBaseSha || turnHeadSha;
  }
  return turnHeadSha;
}
