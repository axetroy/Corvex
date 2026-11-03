import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitCommitLogResult } from "../git/manager.js";

export type GitCommitLogReader = (limit: number, path?: string) => Promise<GitCommitLogResult>;
export type GitCommitReader = (
  sha: string,
  path?: string,
) => Promise<{ sha: string; output: string; truncated: boolean }>;

export function createGitHistoryExtension(
  getCommitLog: GitCommitLogReader,
  showCommit: GitCommitReader,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "git_log",
      label: "Git commit history",
      executionMode: "parallel",
      description: "Read recent commits reachable from the current merge request's pinned HEAD. Returns full SHA, author, authored time, and subject. Limit is 1-50 (default 10); optional path is a literal repository-relative path.",
      promptSnippet: "git_log: Inspect recent commits in the current MR history; use git_show with a returned full SHA to inspect a commit.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await getCommitLog(params.limit ?? 10, params.path)) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "git_show",
      label: "Show Git commit",
      executionMode: "parallel",
      description: "Read metadata and patch for a commit reachable from the current merge request's pinned HEAD. Requires a full 40- or 64-character commit SHA from git_log. Output is capped at 256 KiB; optional path is a literal repository-relative path.",
      promptSnippet: "git_show: Inspect one commit from this MR history by its full SHA, optionally narrowed to a literal file path.",
      parameters: Type.Object({
        sha: Type.String({
          minLength: 40,
          maxLength: 64,
          pattern: "^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
        }),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await showCommit(params.sha, params.path)) }],
        details: {},
      }),
    });
  };
}
