import { Type } from "typebox";
import type { GitCommitLogResult, GitWorkspaceStatus } from "../../git/manager.js";

/**
 * Git 工具适配器：所有实现都绑定当前会话的项目与 worktree，
 * 不接受任意仓库 URL、任意远端、任意分支或强制推送。
 */
export interface GitToolAdapter {
  status(): Promise<GitWorkspaceStatus>;
  log(limit: number, path?: string): Promise<GitCommitLogResult>;
  show(sha: string, path?: string): Promise<{ sha: string; output: string; truncated: boolean }>;
  diff(path?: string): Promise<{ diff: string; truncated: boolean }>;
  /** 准备/重建当前绑定快照的 worktree（对应 clone）。 */
  clone(): Promise<{ path: string; headSha: string }>;
  branches(): Promise<{ branches: string[]; head: string }>;
  createBranch(name: string): Promise<{ name: string; sha: string }>;
  switchBranch(name: string): Promise<{ name: string; sha: string }>;
  checkout(name: string): Promise<{ name: string; sha: string; fromRemote: boolean }>;
  /** 从已配置的本地镜像抓取对象；不自动改变固定快照。 */
  pull(): Promise<{ sha: string; fetched: boolean }>;
  merge(ref: string): Promise<{ sha: string; ref: string }>;
  commit(message: string): Promise<{ sha: string; paths: string[] } | undefined>;
  /** 把当前改动写入项目镜像里的会话 ref；没有远端推送或强制更新。 */
  push(): Promise<{ ref: string; sha: string } | undefined>;
  revert(sha: string): Promise<{ sha: string; revertedSha: string }>;
}

export const iidSha = Type.String({
  minLength: 40,
  maxLength: 64,
  pattern: "^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
});
export const limitParam = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));
export const pathParam = Type.Optional(Type.String({ minLength: 1, maxLength: 4096 }));
export const branchNameParam = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]*$",
});

export function text(value: unknown): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
}
