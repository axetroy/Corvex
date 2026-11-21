import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitChangesExtension } from "./changes.js";
import { createGitInspectExtension } from "./inspect.js";
import { createGitWorkspaceExtension } from "./workspace.js";
import type { GitToolAdapter } from "./common.js";

export type { GitToolAdapter } from "./common.js";

/** 把 Git 工具集一次性注册到 Pi 会话：检查、worktree 操作与变更写入。 */
export function createGitExtension(git: GitToolAdapter): (pi: ExtensionAPI) => void {
  return (pi) => {
    createGitInspectExtension(git)(pi);
    createGitWorkspaceExtension(git)(pi);
    createGitChangesExtension(git)(pi);
  };
}
