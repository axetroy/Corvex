import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { branchNameParam, iidSha, rebaseTargetParam, text, type GitToolAdapter } from "./common.js";

/** 变更写入：提交、写入会话 ref（push）与回滚，全部限定在当前对话。 */
export function createGitChangesExtension(git: GitToolAdapter): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "git_commit",
      label: "Commit worktree changes",
      executionMode: "sequential",
      description: "Commit the current worktree changes with a message. Inspect git_status and git_diff first. Commits are saved to this conversation's ref in the local mirror, not to the checked-out GitLab branch; a repeated commit with the same message usually means there is nothing new to save.",
      promptSnippet: "git_commit: Commit worktree changes to the conversation ref; do not repeat a commit with the same message.",
      parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 2_000 }) }),
      execute: async (_id, params) => text(
        (await git.commit(params.message)) ?? {
          committed: false,
          reason: "the worktree is clean, so there are no new changes to commit. Do not call git_commit again with the same message; if git_status still shows differences after switching branches, rebase or merge the conversation ref instead.",
        },
      ),
    });
    pi.registerTool({
      name: "git_push",
      label: "Save changes to conversation ref",
      executionMode: "sequential",
      description: "Write the current worktree changes to this conversation's ref in the project mirror so they survive worktree cleanup. There is no remote push, force update or arbitrary branch target.",
      promptSnippet: "git_push: Persist worktree changes to the conversation ref; no remote push.",
      parameters: Type.Object({}),
      execute: async () => text((await git.push()) ?? { saved: false, reason: "no changes in the worktree" }),
    });
    pi.registerTool({
      name: "git_push_branch",
      label: "Push commit to GitLab branch",
      executionMode: "sequential",
      description: "Fast-forward a commit from this project's local mirror to a named GitLab branch so merge requests can see the changes. Never force-push. Uses the signed-in user's GitLab token. The branch must be a valid name and the push is rejected if it would rewrite the remote branch.",
      promptSnippet: "git_push_branch: Explicitly publish a commit to a GitLab branch (fast-forward only); use git_push first to save the commit in the mirror, then create or update the MR.",
      parameters: Type.Object({ sha: iidSha, branch: branchNameParam }),
      execute: async (_id, params) => text(await git.pushBranch(params.sha, params.branch)),
    });
    pi.registerTool({
      name: "git_publish",
      label: "Publish changes to a GitLab branch",
      executionMode: "sequential",
      description: "Save the current worktree changes and fast-forward them to a GitLab branch in one step, so a merge request can show a real diff. Prefer this over git_commit + git_push_branch: it returns the exact commit SHA and never requires you to remember or guess one. No force push is ever performed.",
      promptSnippet: "git_publish: Commit current changes and push them to a named GitLab branch in one call; use for MR updates.",
      parameters: Type.Object({
        branch: branchNameParam,
        message: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      }),
      execute: async (_id, params) => text(await git.publish(params.branch, params.message)),
    });
    pi.registerTool({
      name: "git_rebase",
      label: "Rebase current commits",
      executionMode: "sequential",
      description: "Rebase the current worktree commits onto a local or origin branch, or onto a full commit SHA. The worktree must be clean; conflicts abort automatically.",
      promptSnippet: "git_rebase: Rebase clean worktree commits onto a named branch or commit; conflicts are aborted.",
      parameters: Type.Object({ onto: rebaseTargetParam }),
      execute: async (_id, params) => text(await git.rebase(params.onto)),
    });
    pi.registerTool({
      name: "git_cherry_pick",
      label: "Cherry-pick a commit",
      executionMode: "sequential",
      description: "Apply one full commit SHA from this project's mirror onto the current worktree as a new commit. The worktree must be clean; conflicts abort automatically.",
      promptSnippet: "git_cherry_pick: Apply one known commit to the current branch; conflicts are aborted.",
      parameters: Type.Object({ sha: iidSha }),
      execute: async (_id, params) => text(await git.cherryPick(params.sha)),
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
