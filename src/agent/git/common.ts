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
  /** 把镜像中已有的提交快进推到 GitLab 具名分支；需要用户明确要求与写令牌。 */
  pushBranch(sha: string, branch: string): Promise<{ branch: string; sha: string }>;
  /** 一步保存当前改动并快进推送到 GitLab 分支，不需要在工具之间传递 SHA。 */
  publish(branch: string, message?: string): Promise<{ branch: string; sha: string; committed: boolean }>;
  revert(sha: string): Promise<{ sha: string; revertedSha: string }>;
  /** 变基到指定本地分支/完整提交；只接受已存在的目标，冲突时自动中止。 */
  rebase(onto: string): Promise<{ sha: string; onto: string }>;
  /** 把镜像中的提交摘到当前 worktree；冲突时自动中止。 */
  cherryPick(sha: string): Promise<{ sha: string; pickedSha: string }>;
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
/** 变基目标：完整提交 SHA 或本地/远端跟踪分支名。 */
export const rebaseTargetParam = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[A-Za-z0-9][A-Za-z0-9._/-]*)$",
});

export function text(value: unknown): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  // JSON.stringify(undefined) 返回 undefined，会让工具结果里出现没有 text 的 content 项，
  // Pi SDK 在拼装下一条请求时读取 text.length 就会崩溃；这里统一落到 "null"。
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], details: {} };
}
