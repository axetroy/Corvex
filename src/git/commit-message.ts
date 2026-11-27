import { userCommitMessage } from "./commit-identity.js";

/** 会话 ref 自动保存改动时使用的占位信息。 */
export const conversationCommitPrefix = "Corvex conversation changes ";

/** 判断一条提交是否只是 Runner 轮末自动保存生成的占位提交。 */
export function isAutoConversationCommit(subject: string): boolean {
  return subject.startsWith(conversationCommitPrefix);
}

/**
 * 只有「显式给了信息」且「当前仍是占位提交」时才允许重写，避免改写用户提供或 GitLab 已有的提交。
 */
export function needsCommitMessageRewrite(currentMessage: string, requested: string | undefined): boolean {
  const requestedText = userCommitMessage(requested ?? "");
  if (!requestedText) return false;
  if (userCommitMessage(currentMessage) === requestedText) return false;
  return isAutoConversationCommit(currentMessage.split("\n", 1)[0].trim());
}
