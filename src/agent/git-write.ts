import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitWorkspaceStatus } from "../git/manager.js";

export interface GitWorkspaceWriter {
  status(): Promise<GitWorkspaceStatus>;
  applyPatch(patch: string): Promise<{ patch: string; changedFiles: string[] }>;
  commit(message: string): Promise<{ sha: string; message: string; changedFiles: string[] }>;
  push(): Promise<{ sha: string; branch: string }>;
  revert(sha: string): Promise<{ sha: string; revertedSha: string }>;
}

export function createGitWriteExtension(
  writer: GitWorkspaceWriter,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "git_status",
      label: "Git worktree status",
      executionMode: "sequential",
      description: "Show the current task's isolated Git worktree status. The repository and branch are fixed to the current same-project merge request.",
      promptSnippet: "git_status: Inspect the isolated current MR worktree before or after edits.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify(await writer.status()) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "git_apply_patch",
      label: "Apply repository patch",
      executionMode: "sequential",
      description: "Apply a unified diff to existing regular tracked files in the current merge request worktree. Additions, deletions, renames, mode changes, and untracked files are rejected.",
      promptSnippet: "git_apply_patch: Apply a focused unified diff to existing tracked files in the current MR worktree.",
      parameters: Type.Object({ patch: Type.String({ minLength: 1, maxLength: 262_144 }) }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await writer.applyPatch(params.patch)) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "git_commit",
      label: "Commit repository changes",
      executionMode: "sequential",
      description: "Commit unstaged modifications to tracked files in the current isolated MR worktree using the fixed Corvex Agent identity. Untracked, deleted, or staged files are rejected.",
      promptSnippet: "git_commit: Commit the current tracked-file changes after inspecting status; no confirmation is required after the user requested the change.",
      parameters: Type.Object({ message: Type.String({ minLength: 1, maxLength: 2000 }) }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await writer.commit(params.message)) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "git_push",
      label: "Push current MR branch",
      executionMode: "sequential",
      description: "Push the current commit to the source branch of the current same-project MR. The remote URL, project, branch, and expected pinned MR head are fixed. Only normal fast-forward updates are possible; force-push is never available.",
      promptSnippet: "git_push: Push committed changes to this MR's source branch. This performs only a normal fast-forward push; never force-push.",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify(await writer.push()) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "git_revert",
      label: "Revert latest Corvex commit",
      executionMode: "sequential",
      description: "Undo the latest Corvex Agent commit by adding a new revert commit. Rewriting history and reverting other commits are not allowed.",
      promptSnippet: "git_revert: Undo the latest Corvex-created commit by adding a normal revert commit; never rewrite history.",
      parameters: Type.Object({
        sha: Type.String({
          minLength: 40,
          maxLength: 64,
          pattern: "^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
        }),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await writer.revert(params.sha)) }],
        details: {},
      }),
    });
  };
}