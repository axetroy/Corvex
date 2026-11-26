import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gitResult, iidSha, limitParam, optionalWorktreePath, pathParam, type GitToolAdapter } from "./common.js";

/** 只读的 Git 检查工具：状态、历史、提交详情与工作区差异。 */
export function createGitInspectExtension(git: GitToolAdapter): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "git_status",
      label: "Git status",
      executionMode: "parallel",
      description: "Show the status of the worktree bound to this conversation. The repository and pinned revision are fixed; no arguments.",
      promptSnippet: "git_status: Inspect the current bound worktree before or after local edits.",
      parameters: Type.Object({}),
      execute: async () => gitResult(git.status()),
    });
    pi.registerTool({
      name: "git_log",
      label: "Git log",
      executionMode: "parallel",
      description: "Read recent commits reachable from the bound worktree HEAD. Limit is 1-50 (default 10); optional path is a worktree:// URI or worktree-relative path.",
      promptSnippet: "git_log: Inspect recent commits; use git_show with a returned full SHA for details.",
      parameters: Type.Object({ limit: limitParam, path: pathParam }),
      execute: async (_id, params) => gitResult(git.log(params.limit ?? 10, optionalWorktreePath(params.path))),
    });
    pi.registerTool({
      name: "git_show",
      label: "Git show",
      executionMode: "parallel",
      description: "Read metadata and patch of one commit reachable from the bound worktree HEAD. Requires a full 40- or 64-character SHA from git_log; output is capped.",
      promptSnippet: "git_show: Inspect one commit by full SHA, optionally narrowed to a literal path.",
      parameters: Type.Object({ sha: iidSha, path: pathParam }),
      execute: async (_id, params) => gitResult(git.show(params.sha, optionalWorktreePath(params.path))),
    });
    pi.registerTool({
      name: "git_diff",
      label: "Git diff",
      executionMode: "parallel",
      description: "Show the uncommitted diff of the bound worktree against HEAD. Output is capped; optional path is a worktree:// URI or worktree-relative path.",
      promptSnippet: "git_diff: Inspect uncommitted worktree changes, optionally for one path.",
      parameters: Type.Object({ path: pathParam }),
      execute: async (_id, params) => gitResult(git.diff(optionalWorktreePath(params.path))),
    });
    pi.registerTool({
      name: "git_branches",
      label: "List Git branches",
      executionMode: "parallel",
      description: "List local branches in the bound worktree and show the current HEAD. No arguments.",
      promptSnippet: "git_branches: List local branches before creating or switching one.",
      parameters: Type.Object({}),
      execute: async () => gitResult(git.branches()),
    });
  };
}
