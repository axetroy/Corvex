import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { branchNameParam, iidSha, text, type GitToolAdapter } from "./common.js";

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
      execute: async () => text(await git.clone()),
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
      name: "git_pull",
      label: "Fetch from mirror",
      executionMode: "sequential",
      description: "Fetch objects from the configured local project mirror. The worktree stays on its pinned revision; this tool never changes HEAD or pulls from an arbitrary remote.",
      promptSnippet: "git_pull: Fetch from the configured local mirror; the pinned revision is unchanged.",
      parameters: Type.Object({}),
      execute: async () => text(await git.pull()),
    });
    pi.registerTool({
      name: "git_merge",
      label: "Merge local ref",
      executionMode: "sequential",
      description: "Merge a local branch or full commit SHA into the bound worktree. Only refs already present in this repository are accepted; conflicts abort the merge. No remote merge or force option is available.",
      promptSnippet: "git_merge: Merge a local branch or full SHA into the current worktree; conflicts abort.",
      parameters: Type.Object({ ref: Type.Union([branchNameParam, iidSha]) }),
      execute: async (_id, params) => text(await git.merge(params.ref)),
    });
  };
}
