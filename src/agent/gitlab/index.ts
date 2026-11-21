import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createIssueExtension } from "./issue.js";
import { createMergeRequestExtension } from "./merge-request.js";
import type { GitLabAgentTools } from "./common.js";

export type { GitLabAgentTools } from "./common.js";

/** 把 Issue 与 MR 两个子模块的工具一次性注册到 Pi 会话。 */
export function createGitLabExtension(tools: GitLabAgentTools): (pi: ExtensionAPI) => void {
  return (pi) => {
    createIssueExtension(tools)(pi);
    createMergeRequestExtension(tools)(pi);
  };
}
