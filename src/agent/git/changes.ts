import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { iidSha, text, type GitToolAdapter } from "./common.js";

/** 变更写入：提交、写入会话 ref（push）与回滚，全部限定在当前对话。 */
export function createGitChangesExtension(git: GitToolAdapter): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "git_commit",
      label: "Commit worktree changes",
      executionMode: "sequential",
      description: "Commit the current worktree changes with a message. Only call this when the user explicitly asks; inspect git_status and git_diff first.",
      promptSnippet: "git_commit: Commit current worktree changes only on explicit user request.",
      parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 2_000 }) }),
      execute: async (_id, params) => text(await git.commit(params.message)),
    });
    pi.registerTool({
      name: "git_push",
      label: "Save changes to conversation ref",
      executionMode: "sequential",
      description: "Write the current worktree changes to this conversation's ref in the project mirror so they survive worktree cleanup. There is no remote push, force update or arbitrary branch target.",
      promptSnippet: "git_push: Persist worktree changes to the conversation ref; no remote push.",
      parameters: Type.Object({}),
      execute: async () => text(await git.push()),
    });
    pi.registerTool({
      name: "git_revert",
      label: "Revert a commit",
      executionMode: "sequential",
      description: "Undo one commit by adding a new revert commit in the bound worktree. Requires a full SHA from git_log; history is never rewritten.",
      promptSnippet: "git_revert: Revert one full SHA with a new commit; never rewrite history.",
      parameters: Type.Object({ sha: iidSha }),
      execute: async (_id, params) => text(await git.revert(params.sha)),
    });
  };
}
