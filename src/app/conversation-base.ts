/**
 * 轮次开始时计算会话的同步基线。
 *
 * 基线是本地未发布改动的父提交，与只用于过期检测的轮次快照分开：
 * 没有未发布改动时，远端快照就是新基线（外部 push 也能同步）；
 * 有未发布改动时必须保留原基线，否则改动会变成基于新远点的「游离提交」而被忽略。
 */
export function resolveTurnBaseSha(
  conversationBaseSha: string,
  turnHeadSha: string,
  hasUnpublishedChanges: boolean,
): string {
  return hasUnpublishedChanges ? conversationBaseSha || turnHeadSha : turnHeadSha;
}
