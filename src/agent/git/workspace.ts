import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { branchNameParam, gitResult, iidSha, text, type GitToolAdapter } from "./common.js";

/** worktree 级操作：clone/refresh、分支、抓取与合并，全部限定在当前项目与本地镜像。 */
export function createGitWorkspaceExtension(git: GitToolAdapter): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "git_clone",
      label: "Prepare worktree",
      executionMode: "sequential",
      description: "Ensure the bound conversation worktree exists at its pinned snapshot. Takes no repository URL and never clones arbitrary remotes; it only rebuilds the current project's worktree if it was evicted.",
      promptSnippet: "git_clone: Rebuild the current bound worktree when it is missing; no URL arguments.",
      parameters: Type.Object({}),
      execute: async () => gitResult(git.clone()),
    });
    pi.registerTool({
      name: "git_branch",
      label: "Create or switch branch",
      executionMode: "sequential",
      description: "Create a local branch at the current HEAD or switch to an existing local branch in the bound worktree. Names are validated; no remote branches, arbitrary refs or force operations are accepted.",
      promptSnippet: "git_branch: Create or switch local branches in the bound worktree only.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("create"), Type.Literal("switch")]),
        name: branchNameParam,
      }),
      execute: async (_id, params) => text(params.action === "create"
        ? await git.createBranch(params.name)
        : await git.switchBranch(params.name)),
    });
    pi.registerTool({
      name: "git_checkout",
      label: "Checkout branch",
      executionMode: "sequential",
      description: "Check out a branch in the bound worktree. Switches to an existing local branch, or creates and tracks a local branch from origin/<name> when it does not exist locally. No arbitrary remote URLs and no force operations. Use this to prepare a branch before creating a merge request.",
      promptSnippet: "git_checkout: Switch to a local branch or track origin/<name> to prepare for a merge request.",
      parameters: Type.Object({ name: branchNameParam }),
      execute: async (_id, params) => gitResult(git.checkout(params.name)),
    });
    pi.registerTool({
      name: "git_pull",
      label: "Fetch from mirror",
      executionMode: "sequential",
      description: "Fetch objects from the configured local project mirror. The worktree stays on its pinned revision; this tool never changes HEAD or pulls from an arbitrary remote.",
      promptSnippet: "git_pull: Fetch from the configured local mirror; the pinned revision is unchanged.",
      parameters: Type.Object({}),
      execute: async () => gitResult(git.pull()),
    });
    pi.registerTool({
      name: "git_sync",
      label: "Sync remote branches",
      executionMode: "sequential",
      description: "Refresh the bound project's mirror from GitLab so remote branch tips become available as origin/<branch> in the worktree. Use this when a push was rejected as non-fast-forward or before rebasing onto an updated branch. Uses the signed-in user's GitLab token; no arbitrary remote or force option.",
      promptSnippet: "git_sync: Refresh GitLab branch tips in the mirror (origin/<branch>) before rebasing or after a non-fast-forward push.",
      parameters: Type.Object({}),
      execute: async () => gitResult(git.sync()),
    });
    pi.registerTool({
      name: "git_merge",
      label: "Merge local ref",
      executionMode: "sequential",
      description: "Merge a local branch or full commit SHA into the bound worktree. Only refs already present in this repository are accepted; conflicts abort the merge. No remote merge or force option is available.",
      promptSnippet: "git_merge: Merge a local branch or full SHA into the current worktree; conflicts abort.",
      parameters: Type.Object({ ref: Type.Union([branchNameParam, iidSha]) }),
      execute: async (_id, params) => gitResult(git.merge(params.ref)),
    });
  };
}
