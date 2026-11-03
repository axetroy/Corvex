import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DiffEngine } from "./diff.js";
import type { DiffResult, Workspace } from "./types.js";

/** 单条 Git 命令允许捕获的标准输出上限。 */
const maxOutput = 16 << 20;
/** 单条 Git 命令保留的标准错误输出上限。 */
const maxErrorOutput = 4 << 10;
/** 安全读取 Git 工作区文件时允许的最大文件大小。 */
const maxReadFileBytes = 16 << 20;
/** 单次工作区 diff 返回的最大字节数。 */
const maxWorkspaceDiffBytes = 32 << 10;
/** 补丁解析和应用流程允许处理的最大字节数。 */
const maxPatchBytes = 256 << 10;
/** Git commit 对象的完整 SHA-1 或 SHA-256 十六进制格式。 */
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** 可安全用作工作区目录名的任务 ID 格式，并限制其最大长度。 */
const jobIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

interface GitResult {
  stdout: Buffer;
  truncated: boolean;
  exitCode: number;
}

interface GitRunOptions {
  authToken?: string;
  timeoutMs?: number;
  terminateOnOutputLimit?: boolean;
  allowExitCodes?: number[];
}

export interface GitGrepResult {
  matches: { path: string; line: number; text: string }[];
  truncated: boolean;
}

export interface GitCommit {
  sha: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface GitCommitLogResult {
  commits: GitCommit[];
  truncated: boolean;
}

export interface GitWorkspaceStatus {
  headSha: string;
  clean: boolean;
  files: { path: string; status: string }[];
}

export class GitPushError extends Error {
  readonly outcomeUnknown = true;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "GitPushError";
  }
}

export interface GitStorageCleanupPlan {
  workspaces: string[];
  mirrors: string[];
  applied: boolean;
}

export class GitManager {
  private readonly root: string;
  private readonly mirrorRoot: string;
  private readonly workspaceRoot: string;
  private readonly gitlabUrl: URL;
  private readonly projectLocks = new Map<number, Promise<void>>();
  private readonly diffEngine: DiffEngine;

  constructor(
    root: string,
    gitlabBaseUrl: string,
    private readonly token: string,
    private readonly writeToken = "",
  ) {
    if (!root.trim()) throw new Error("Git storage root is required");
    let url: URL;
    try {
      url = new URL(gitlabBaseUrl);
    } catch (error) {
      throw new Error(`invalid GitLab base URL "${gitlabBaseUrl}"`, { cause: error });
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`invalid GitLab base URL "${gitlabBaseUrl}"`);
    }
    this.root = resolve(root);
    this.mirrorRoot = join(this.root, "mirrors");
    this.workspaceRoot = join(this.root, "workspaces");
    this.gitlabUrl = url;
    this.diffEngine = new DiffEngine((workspace, args, input, limit, signal) =>
      this.run(workspace.path, args, input, limit, signal),
    );
  }

  get writeEnabled(): boolean {
    return this.writeToken.length > 0;
  }

  async initialize(): Promise<void> {
    await mkdir(this.mirrorRoot, { recursive: true, mode: 0o750 });
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o750 });
  }

  async cleanupStorage(
    activeJobIds: ReadonlySet<string>,
    protectedProjectIds: ReadonlySet<number>,
    olderThan: Date,
    apply = false,
  ): Promise<GitStorageCleanupPlan> {
    if (Number.isNaN(olderThan.valueOf())) throw new Error("storage cleanup cutoff is invalid");
    await this.initialize();
    for (const root of [this.workspaceRoot, this.mirrorRoot]) {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`managed Git storage path "${root}" is not a regular directory`);
      }
    }

    const workspaces: string[] = [];
    for (const projectName of await readdir(this.workspaceRoot)) {
      if (!/^[1-9]\d*$/.test(projectName)) continue;
      const projectId = Number(projectName);
      if (!Number.isSafeInteger(projectId)) continue;
      const projectRoot = join(this.workspaceRoot, projectName);
      const projectInfo = await lstat(projectRoot);
      if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
        throw new Error(`project workspace path "${projectRoot}" is not a regular directory`);
      }
      for (const jobId of await readdir(projectRoot)) {
        if (!jobIdPattern.test(jobId) || activeJobIds.has(jobId)) continue;
        const workspacePath = join(projectRoot, jobId);
        const info = await lstat(workspacePath);
        if (info.isSymbolicLink()) {
          throw new Error(`managed workspace "${workspacePath}" must not be a symbolic link`);
        }
        if (info.isDirectory() && info.mtimeMs < olderThan.valueOf()) {
          workspaces.push(workspacePath);
        }
      }
    }

    const mirrors: string[] = [];
    for (const name of await readdir(this.mirrorRoot)) {
      const match = /^([1-9]\d*)\.git$/.exec(name);
      if (!match) continue;
      const projectId = Number(match[1]);
      if (!Number.isSafeInteger(projectId) || protectedProjectIds.has(projectId)) continue;
      const mirrorPath = join(this.mirrorRoot, name);
      const info = await lstat(mirrorPath);
      if (info.isSymbolicLink()) {
        throw new Error(`managed mirror "${mirrorPath}" must not be a symbolic link`);
      }
      if (info.isDirectory() && info.mtimeMs < olderThan.valueOf()) mirrors.push(mirrorPath);
    }

    if (apply) {
      for (const workspacePath of workspaces) {
        const projectId = Number(basename(dirname(workspacePath)));
        const mirror = join(this.mirrorRoot, `${projectId}.git`);
        let mirrorExists = false;
        try {
          const mirrorInfo = await lstat(mirror);
          if (!mirrorInfo.isDirectory() || mirrorInfo.isSymbolicLink()) {
            throw new Error(`managed mirror "${mirror}" is not a regular directory`);
          }
          mirrorExists = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (mirrorExists) await this.removeWorktree(mirror, workspacePath);
        else await rm(workspacePath, { recursive: true });
      }
      for (const mirror of mirrors) {
        const info = await lstat(mirror);
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new Error(`managed mirror "${mirror}" changed before cleanup`);
        }
        await rm(mirror, { recursive: true });
      }
    }
    return { workspaces, mirrors, applied: apply };
  }

  async prepareWorkspace(
    projectId: number,
    jobId: string,
    repositoryUrl: string,
    expectedSha: string,
    signal?: AbortSignal,
  ): Promise<Workspace> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    if (!jobIdPattern.test(jobId)) throw new Error("job ID contains invalid path characters");
    if (!shaPattern.test(expectedSha)) {
      throw new Error("expected commit SHA must be a full 40- or 64-character hexadecimal SHA");
    }
    const canonicalUrl = this.validateRepositoryUrl(repositoryUrl);
    return this.withProjectLock(projectId, async () => {
      const mirror = join(this.mirrorRoot, `${projectId}.git`);
      await this.updateMirror(mirror, canonicalUrl, signal);
      try {
        await this.run(mirror, ["--git-dir", mirror, "cat-file", "-e", `${expectedSha}^{commit}`], undefined, maxErrorOutput, signal);
      } catch {
        await this.runWithRetry(mirror, ["--git-dir", mirror, "fetch", "--no-tags", "origin", expectedSha], signal);
        await this.run(mirror, ["--git-dir", mirror, "cat-file", "-e", `${expectedSha}^{commit}`], undefined, maxErrorOutput, signal);
      }

      const projectRoot = join(this.workspaceRoot, String(projectId));
      await mkdir(projectRoot, { recursive: true, mode: 0o750 });
      const rootInfo = await lstat(projectRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error("project workspace path is not a regular directory");
      }
      const workspacePath = join(projectRoot, jobId);
      try {
        await lstat(workspacePath);
        throw new Error(`workspace "${jobId}" already exists`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await this.run(mirror, ["--git-dir", mirror, "worktree", "add", "--detach", workspacePath, expectedSha], undefined, maxErrorOutput, signal);
      const actual = (await this.run(workspacePath, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
      if (actual.toLowerCase() !== expectedSha.toLowerCase()) {
        await this.removeWorktree(mirror, workspacePath);
        throw new Error(`workspace HEAD mismatch: got ${actual}, expected ${expectedSha}`);
      }
      return { projectId, jobId, path: workspacePath, headSha: expectedSha };
    });
  }

  async prepareIssueWorkspace(
    projectId: number,
    jobId: string,
    repositoryUrl: string,
    targetBranch: string,
    sourceBranch: string,
    signal?: AbortSignal,
  ): Promise<{ workspace: Workspace; baseSha: string }> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    if (!jobIdPattern.test(jobId)) throw new Error("job ID contains invalid path characters");
    const canonicalUrl = this.validateRepositoryUrl(repositoryUrl);
    return this.withProjectLock(projectId, async () => {
      const mirror = join(this.mirrorRoot, `${projectId}.git`);
      await this.updateMirror(mirror, canonicalUrl, signal);
      for (const branch of [targetBranch, sourceBranch]) {
        await this.run(mirror, ["--git-dir", mirror, "check-ref-format", "--branch", branch], undefined, maxErrorOutput, signal);
      }
      if (!sourceBranch.startsWith("corvex/issue-") || sourceBranch === targetBranch) {
        throw new Error("Issue source branches must use the corvex/issue- prefix and differ from the target branch");
      }
      const base = await this.run(
        mirror,
        ["--git-dir", mirror, "rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`],
        undefined,
        maxErrorOutput,
        signal,
      );
      const baseSha = base.stdout.toString().trim();
      if (!shaPattern.test(baseSha)) throw new Error("GitLab target branch did not resolve to a full commit SHA");
      const projectRoot = join(this.workspaceRoot, String(projectId));
      await mkdir(projectRoot, { recursive: true, mode: 0o750 });
      const rootInfo = await lstat(projectRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error("project workspace path is not a regular directory");
      }
      const workspacePath = join(projectRoot, jobId);
      try {
        await lstat(workspacePath);
        throw new Error(`workspace "${jobId}" already exists`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await this.run(mirror, ["--git-dir", mirror, "worktree", "add", "--detach", workspacePath, baseSha], undefined, maxErrorOutput, signal);
      try {
        await this.run(workspacePath, ["switch", "--create", sourceBranch], undefined, maxErrorOutput, signal);
        const actual = (await this.run(workspacePath, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
        if (actual.toLowerCase() !== baseSha.toLowerCase()) {
          throw new Error(`Issue workspace HEAD mismatch: got ${actual}, expected ${baseSha}`);
        }
      } catch (error) {
        await this.removeWorktree(mirror, workspacePath);
        throw error;
      }
      return { workspace: { projectId, jobId, path: workspacePath, headSha: baseSha }, baseSha };
    });
  }

  async cleanupWorkspace(workspace: Workspace, signal?: AbortSignal, issueSourceBranch?: string): Promise<void> {
    if (workspace.projectId <= 0 || !jobIdPattern.test(workspace.jobId)) {
      throw new Error("invalid workspace identity");
    }
    if (issueSourceBranch && !issueSourceBranch.startsWith("corvex/issue-")) {
      throw new Error("invalid Issue source branch");
    }
    const expectedPath = join(this.workspaceRoot, String(workspace.projectId), workspace.jobId);
    if (resolve(workspace.path) !== resolve(expectedPath)) {
      throw new Error("workspace path does not match its managed location");
    }
    await this.withProjectLock(workspace.projectId, async () => {
      const mirror = join(this.mirrorRoot, `${workspace.projectId}.git`);
      await this.removeWorktree(mirror, expectedPath, signal);
      if (issueSourceBranch) {
        await this.run(mirror, ["--git-dir", mirror, "check-ref-format", "--branch", issueSourceBranch], undefined, maxErrorOutput, signal);
        await this.run(mirror, ["--git-dir", mirror, "branch", "-D", issueSourceBranch], undefined, maxErrorOutput, signal);
      }
    });
  }

  async diff(
    workspace: Workspace,
    baseSha: string,
    maxFiles: number,
    maxFileDiffBytes: number,
    signal?: AbortSignal,
  ): Promise<DiffResult> {
    this.validateWorkspace(workspace);
    return this.diffEngine.diff(workspace, baseSha, maxFiles, maxFileDiffBytes, signal);
  }

  async readFile(
    workspace: Workspace,
    name: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.validateWorkspace(workspace);
    if (maxBytes <= 0 || maxBytes > maxReadFileBytes) {
      throw new Error(`maxBytes must be between 1 and ${maxReadFileBytes}`);
    }
    this.validateWorkspaceFilePath(name);
    const result = await this.run(
      workspace.path,
      ["cat-file", "blob", `${workspace.headSha}:${name}`],
      undefined,
      maxBytes,
      signal,
    );
    if (result.truncated) throw new Error(`file exceeds ${maxBytes}-byte read limit`);
    return result.stdout;
  }

  async getWorkspaceDiff(
    workspace: Workspace,
    requestedPath?: string,
    signal?: AbortSignal,
  ): Promise<{ diff: string; truncated: boolean }> {
    this.validateWorkspace(workspace);
    if (requestedPath !== undefined) this.validateWorkspaceFilePath(requestedPath);
    const result = await this.run(
      workspace.path,
      [
        "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "HEAD", "--",
        ...(requestedPath ? [`:(literal)${requestedPath}`] : []),
      ],
      undefined,
      maxWorkspaceDiffBytes,
      signal,
      { timeoutMs: 10_000, terminateOnOutputLimit: true },
    );
    return { diff: result.stdout.toString("utf8"), truncated: result.truncated };
  }

  async grep(
    workspace: Workspace,
    query: string,
    requestedPath = ".",
    signal?: AbortSignal,
  ): Promise<GitGrepResult> {
    this.validateWorkspace(workspace);
    const searchTerm = query.trim();
    if (!searchTerm || searchTerm.length > 256 || /[\0\r\n]/.test(searchTerm)) {
      throw new Error("Git search query must contain 1 to 256 single-line characters");
    }
    if (
      requestedPath !== "." &&
      (!this.validPatchPath(requestedPath) ||
        ["*", "?", "[", "]", ":"].some((character) => requestedPath.includes(character)))
    ) {
      throw new Error("Git search path must be a literal workspace-relative path");
    }
    const result = await this.run(
      workspace.path,
      [
        "grep", "--line-number", "--null", "--full-name", "--fixed-strings", "--ignore-case", "-I",
        "--no-textconv", "--no-color", "--max-count=51", "-e", searchTerm,
        workspace.headSha, "--", requestedPath,
      ],
      undefined,
      256 << 10,
      signal,
      { timeoutMs: 10_000, terminateOnOutputLimit: true, allowExitCodes: [1] },
    );
    const matches: GitGrepResult["matches"] = [];
    let truncated = result.truncated;
    const output = result.stdout.toString();
    let offset = 0;
    while (offset < output.length) {
      const pathEnd = output.indexOf("\0", offset);
      const lineEnd = pathEnd < 0 ? -1 : output.indexOf("\0", pathEnd + 1);
      if (pathEnd < 0 || lineEnd < 0) {
        truncated = true;
        break;
      }
      const contentEndValue = output.indexOf("\n", lineEnd + 1);
      const contentEnd = contentEndValue < 0 ? output.length : contentEndValue;
      const rawPath = output.slice(offset, pathEnd);
      const line = Number(output.slice(pathEnd + 1, lineEnd));
      if (!Number.isSafeInteger(line) || line <= 0) {
        truncated = true;
        break;
      }
      if (matches.length >= 50) {
        truncated = true;
        break;
      }
      const path = rawPath.startsWith(`${workspace.headSha}:`)
        ? rawPath.slice(workspace.headSha.length + 1)
        : rawPath;
      matches.push({
        path,
        line,
        text: output.slice(lineEnd + 1, contentEnd).replace(/\r$/, "").slice(0, 400),
      });
      offset = contentEnd < output.length ? contentEnd + 1 : contentEnd;
    }
    return { matches, truncated };
  }

  async getCommitLog(
    workspace: Workspace,
    limit: number,
    requestedPath?: string,
    signal?: AbortSignal,
  ): Promise<GitCommitLogResult> {
    this.validateWorkspace(workspace);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Git commit log limit must be between 1 and 50");
    }
    if (requestedPath !== undefined) this.validateWorkspaceFilePath(requestedPath);
    const args = [
      "log",
      `--max-count=${limit}`,
      "--format=%H%x00%an%x00%aI%x00%s%x00",
      workspace.headSha,
      ...(requestedPath ? ["--", `:(literal)${requestedPath}`] : []),
    ];
    const result = await this.run(
      workspace.path,
      args,
      undefined,
      128 << 10,
      signal,
      { timeoutMs: 10_000, terminateOnOutputLimit: true },
    );
    const records = result.stdout.toString("utf8").split(/\r?\n/u);
    const commits: GitCommit[] = [];
    for (const record of records) {
      if (!record) continue;
      const [sha, author, authoredAt, subject] = record.split("\0");
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha ?? "")) break;
      commits.push({
        sha: sha!,
        author: author!.slice(0, 256),
        authoredAt: authoredAt!.slice(0, 64),
        subject: subject!.slice(0, 512),
      });
    }
    return { commits, truncated: result.truncated };
  }

  async showCommit(
    workspace: Workspace,
    sha: string,
    requestedPath?: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; output: string; truncated: boolean }> {
    this.validateWorkspace(workspace);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) {
      throw new Error("Git commit lookup requires a full commit SHA");
    }
    if (requestedPath !== undefined) this.validateWorkspaceFilePath(requestedPath);
    const ancestry = await this.run(
      workspace.path,
      ["merge-base", "--is-ancestor", sha, workspace.headSha],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [1] },
    );
    if (ancestry.exitCode !== 0) {
      throw new Error("Git commit is not reachable from the pinned MR HEAD");
    }
    const result = await this.run(
      workspace.path,
      [
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--format=fuller",
        "--unified=3",
        sha,
        ...(requestedPath ? ["--", `:(literal)${requestedPath}`] : []),
      ],
      undefined,
      256 << 10,
      signal,
      { timeoutMs: 10_000, terminateOnOutputLimit: true },
    );
    return { sha, output: result.stdout.toString("utf8"), truncated: result.truncated };
  }

  async applyPatch(
    workspace: Workspace,
    patch: string,
    allowedPaths: string[],
    limit: number,
    signal?: AbortSignal,
  ): Promise<string> {
    this.validateWorkspace(workspace);
    if (limit <= 0 || limit > maxPatchBytes || !patch || Buffer.byteLength(patch) > limit) {
      throw new Error("fix patch is empty or exceeds its configured size limit");
    }
    const paths = this.validateFixPatch(patch, allowedPaths);
    const status = await this.run(
      workspace.path,
      ["status", "--porcelain", "--untracked-files=all"],
      undefined,
      maxErrorOutput,
      signal,
    );
    if (status.stdout.byteLength > 0) throw new Error("patch worktree is not clean");
    for (const name of paths) {
      const entry = await this.run(workspace.path, ["ls-tree", "-z", "HEAD", "--", name], undefined, maxErrorOutput, signal);
      const value = entry.stdout.toString();
      if (!value.startsWith("100644 blob ") && !value.startsWith("100755 blob ")) {
        throw new Error(`patch target "${name}" is not a regular tracked file`);
      }
    }
    await this.run(workspace.path, ["apply", "--check", "--whitespace=error", "-"], Buffer.from(patch), maxErrorOutput, signal);
    await this.run(workspace.path, ["apply", "--whitespace=error", "-"], Buffer.from(patch), maxErrorOutput, signal);
    await this.run(workspace.path, ["diff", "--check", "HEAD", "--"], undefined, maxErrorOutput, signal);
    const changedResult = await this.run(workspace.path, ["diff", "--name-only", "-z", "HEAD", "--"], undefined, maxPatchBytes, signal);
    if (changedResult.truncated) throw new Error("patched file list exceeds output limit");
    const changed = changedResult.stdout.toString().split("\0").filter(Boolean);
    if (changed.some((name) => !paths.includes(name))) {
      throw new Error("applied patch changed an unauthorized path");
    }
    const finalPatch = await this.run(
      workspace.path,
      ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"],
      undefined,
      limit,
      signal,
    );
    if (finalPatch.truncated) throw new Error("validated patch exceeds configured size limit");
    if (finalPatch.stdout.length === 0) throw new Error("generated patch produced no worktree changes");
    return finalPatch.stdout.toString();
  }

  async applyWorkspacePatch(
    workspace: Workspace,
    patch: string,
    signal?: AbortSignal,
  ): Promise<{ patch: string; changedFiles: string[] }> {
    this.validateWorkspace(workspace);
    const tracked = await this.run(workspace.path, ["ls-files", "-z"], undefined, maxOutput, signal);
    if (tracked.truncated) throw new Error("tracked file list exceeds the output limit");
    const allowedPaths = tracked.stdout.toString().split("\0").filter(Boolean);
    const changedFiles = this.validateFixPatch(patch, allowedPaths);
    for (const name of changedFiles) {
      const entry = await this.run(workspace.path, ["ls-tree", "-z", "HEAD", "--", name], undefined, maxErrorOutput, signal);
      if (!entry.stdout.toString().startsWith("100644 blob ") && !entry.stdout.toString().startsWith("100755 blob ")) {
        throw new Error(`patch target "${name}" is not a regular tracked file`);
      }
    }
    const appliedPatch = await this.applyPatch(workspace, patch, allowedPaths, maxPatchBytes, signal);
    return { patch: appliedPatch, changedFiles };
  }

  async applyIssuePatch(
    workspace: Workspace,
    patch: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ patch: string; changedFiles: string[] }> {
    this.validateWorkspace(workspace);
    if (!patch.trim() || Buffer.byteLength(patch) > limit || limit <= 0 || limit > maxPatchBytes) {
      throw new Error("Issue patch is empty or exceeds its configured size limit");
    }
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (!status.clean) throw new Error("Issue patch worktree is not clean");
    const trackedResult = await this.run(workspace.path, ["ls-files", "-z"], undefined, maxOutput, signal);
    if (trackedResult.truncated) throw new Error("tracked file list exceeds the output limit");
    const trackedPaths = new Set(trackedResult.stdout.toString().split("\0").filter(Boolean));
    const paths = this.validateIssuePatch(patch, trackedPaths);
    for (const name of paths) {
      const parts = name.split("/");
      for (let index = 1; index < parts.length; index++) {
        const parentPath = join(workspace.path, ...parts.slice(0, index));
        try {
          const parent = await lstat(parentPath);
          if (!parent.isDirectory() || parent.isSymbolicLink()) {
            throw new Error(`Issue patch path "${name}" has a non-directory or symbolic-link parent`);
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
          throw error;
        }
      }
      if (!trackedPaths.has(name)) {
        try {
          await lstat(join(workspace.path, ...parts));
          throw new Error(`Issue patch new file "${name}" already exists`);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
      }
      const current = await this.run(workspace.path, ["ls-tree", "-z", "HEAD", "--", name], undefined, maxErrorOutput, signal);
      const entry = current.stdout.toString();
      if (trackedPaths.has(name) && !entry.startsWith("100644 blob ") && !entry.startsWith("100755 blob ")) {
        throw new Error(`Issue patch target "${name}" is not a regular tracked file`);
      }
    }
    await this.run(workspace.path, ["apply", "--check", "--whitespace=error", "-"], Buffer.from(patch), maxErrorOutput, signal);
    await this.run(workspace.path, ["apply", "--whitespace=error", "-"], Buffer.from(patch), maxErrorOutput, signal);
    await this.run(workspace.path, ["diff", "--check", "HEAD", "--"], undefined, maxErrorOutput, signal);
    const [modified, untracked] = await Promise.all([
      this.run(workspace.path, ["diff", "--name-only", "-z", "HEAD", "--"], undefined, maxPatchBytes, signal),
      this.run(workspace.path, ["ls-files", "--others", "--exclude-standard", "-z"], undefined, maxPatchBytes, signal),
    ]);
    if (modified.truncated || untracked.truncated) throw new Error("Issue patch changed-file list exceeds output limits");
    const changedFiles = [...new Set([
      ...modified.stdout.toString().split("\0").filter(Boolean),
      ...untracked.stdout.toString().split("\0").filter(Boolean),
    ])].sort();
    if (changedFiles.length !== paths.length || changedFiles.some((name) => !paths.includes(name)) || paths.some((name) => !changedFiles.includes(name))) {
      throw new Error("Issue patch changed no files or modified an unauthorized path");
    }
    return { patch, changedFiles };
  }

  async getWorkspaceStatus(workspace: Workspace, signal?: AbortSignal): Promise<GitWorkspaceStatus> {
    this.validateWorkspace(workspace);
    const [head, status] = await Promise.all([
      this.run(workspace.path, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal),
      this.run(
        workspace.path,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        undefined,
        64 << 10,
        signal,
        { timeoutMs: 10_000, terminateOnOutputLimit: true },
      ),
    ]);
    if (status.truncated) throw new Error("Git status exceeds the 64 KiB output limit");
    const files = status.stdout.toString().split("\0").filter(Boolean).map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3),
    }));
    return { headSha: head.stdout.toString().trim(), clean: files.length === 0, files };
  }

  async commitWorkspace(
    workspace: Workspace,
    message: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; message: string; changedFiles: string[] }> {
    this.validateWorkspace(workspace);
    if (!message.trim() || message.length > 2000 || message.includes("\0")) {
      throw new Error("commit message must contain 1-2000 characters");
    }
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (status.clean) throw new Error("cannot commit a clean worktree");
    if (status.files.some(({ status: fileStatus }) => fileStatus !== " M")) {
      throw new Error("commit only supports unstaged modifications to tracked files; untracked, deleted, or staged files are not allowed");
    }
    const baseAncestor = await this.run(
      workspace.path,
      ["merge-base", "--is-ancestor", workspace.headSha, status.headSha],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [1] },
    );
    if (baseAncestor.exitCode !== 0) throw new Error("workspace HEAD is not descended from the pinned MR HEAD");
    await this.run(workspace.path, ["add", "-u", "--"], undefined, maxErrorOutput, signal);
    await this.run(workspace.path, ["diff", "--cached", "--check"], undefined, maxErrorOutput, signal);
    await this.run(
      workspace.path,
      [
        "-c", "user.name=Corvex Agent",
        "-c", "user.email=corvex-agent@localhost",
        "-c", "commit.gpgsign=false",
        "commit", "--no-verify", "-m", message,
      ],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000 },
    );
    const [head, changed] = await Promise.all([
      this.run(workspace.path, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal),
      this.run(workspace.path, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"], undefined, 64 << 10, signal),
    ]);
    if (changed.truncated) throw new Error("committed file list exceeds the output limit");
    return {
      sha: head.stdout.toString().trim(),
      message: message.trim(),
      changedFiles: changed.stdout.toString().split("\0").filter(Boolean),
    };
  }

  async commitIssueWorkspace(
    workspace: Workspace,
    message: string,
    changedFiles: string[],
    signal?: AbortSignal,
  ): Promise<{ sha: string; message: string; changedFiles: string[] }> {
    this.validateWorkspace(workspace);
    if (!message.trim() || message.length > 2000 || message.includes("\0")) {
      throw new Error("commit message must contain 1-2000 characters");
    }
    if (changedFiles.length === 0 || changedFiles.length > 1000 || changedFiles.some((name) => !this.validPatchPath(name))) {
      throw new Error("Issue commit requires a bounded list of valid patch paths");
    }
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (status.clean || status.files.some(({ status: fileStatus, path }) =>
      !changedFiles.includes(path) || ![" M", " D", "??"].includes(fileStatus),
    )) {
      throw new Error("Issue commit worktree contains changes outside the validated patch");
    }
    await this.run(workspace.path, ["--literal-pathspecs", "add", "-A", "--", ...changedFiles], undefined, maxErrorOutput, signal);
    await this.run(workspace.path, ["diff", "--cached", "--check"], undefined, maxErrorOutput, signal);
    const staged = await this.run(workspace.path, ["diff", "--cached", "--name-only", "-z"], undefined, maxPatchBytes, signal);
    if (staged.truncated) throw new Error("Issue staged file list exceeds output limit");
    const stagedFiles = staged.stdout.toString().split("\0").filter(Boolean).sort();
    const expectedFiles = [...new Set(changedFiles)].sort();
    if (stagedFiles.length !== expectedFiles.length || stagedFiles.some((name, index) => name !== expectedFiles[index])) {
      throw new Error("Issue commit staged paths do not match the validated patch");
    }
    const ancestry = await this.run(
      workspace.path,
      ["merge-base", "--is-ancestor", workspace.headSha, status.headSha],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [1] },
    );
    if (ancestry.exitCode !== 0) throw new Error("Issue workspace HEAD is not descended from its pinned base");
    await this.run(
      workspace.path,
      ["-c", "user.name=Corvex Agent", "-c", "user.email=corvex-agent@localhost", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", message.trim()],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000 },
    );
    const committed = await this.run(workspace.path, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal);
    const committedFiles = await this.run(
      workspace.path,
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "HEAD"],
      undefined,
      maxPatchBytes,
      signal,
    );
    if (committedFiles.truncated) throw new Error("Issue committed file list exceeds output limit");
    return {
      sha: committed.stdout.toString().trim(),
      message: message.trim(),
      changedFiles: committedFiles.stdout.toString().split("\0").filter(Boolean),
    };
  }

  async pushWorkspace(
    workspace: Workspace,
    branch: string,
    expectedRepositoryUrl: string,
    signal?: AbortSignal,
    expectedRemoteSha = workspace.headSha,
  ): Promise<{ sha: string; branch: string }> {
    this.validateWorkspace(workspace);
    if (!this.writeToken) throw new Error("Git write token is required to push changes");
    if (!shaPattern.test(expectedRemoteSha)) throw new Error("expected remote commit SHA must be full-length");
    if (!branch || branch.startsWith("-") || branch.length > 255) {
      throw new Error("target branch is invalid");
    }
    await this.run(workspace.path, ["check-ref-format", "--branch", branch], undefined, maxErrorOutput, signal);
    const [fetchUrl, pushUrl, status] = await Promise.all([
      this.run(workspace.path, ["remote", "get-url", "origin"], undefined, maxErrorOutput, signal),
      this.run(workspace.path, ["remote", "get-url", "--push", "origin"], undefined, maxErrorOutput, signal),
      this.getWorkspaceStatus(workspace, signal),
    ]);
    if (
      fetchUrl.stdout.toString().trim() !== expectedRepositoryUrl ||
      pushUrl.stdout.toString().trim() !== expectedRepositoryUrl
    ) {
      throw new Error("Git origin does not match the authorized merge request repository");
    }
    if (!status.clean) throw new Error("push requires a clean worktree");
    const remote = await this.run(
      workspace.path,
      ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000, authToken: this.writeToken },
    );
    const remoteSha = remote.stdout.toString().trim().split(/\s+/u)[0];
    if (remoteSha?.toLowerCase() !== expectedRemoteSha.toLowerCase()) {
      throw new Error("remote MR source branch no longer matches the pinned MR HEAD");
    }
    const ancestry = await this.run(
      workspace.path,
      ["merge-base", "--is-ancestor", workspace.headSha, status.headSha],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [1] },
    );
    if (ancestry.exitCode !== 0) throw new Error("workspace HEAD is not descended from the pinned MR HEAD");
    const remoteAncestor = await this.run(
      workspace.path,
      ["merge-base", "--is-ancestor", expectedRemoteSha, status.headSha],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [1] },
    );
    if (remoteAncestor.exitCode !== 0) throw new Error("workspace HEAD is not descended from the expected remote commit");
    try {
      await this.run(
        workspace.path,
        ["push", "--porcelain", "origin", `${status.headSha}:refs/heads/${branch}`],
        undefined,
        maxErrorOutput,
        signal,
        { timeoutMs: 60_000, authToken: this.writeToken },
      );
    } catch (error) {
      throw new GitPushError(`Git push outcome is unknown: ${String(error)}`, error);
    }
    return { sha: status.headSha, branch };
  }

  async pushIssueWorkspace(
    workspace: Workspace,
    sourceBranch: string,
    targetBranch: string,
    expectedRepositoryUrl: string,
    expectedTargetSha: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; branch: string }> {
    this.validateWorkspace(workspace);
    if (!this.writeToken) throw new Error("Git write token is required to push changes");
    if (!sourceBranch.startsWith("corvex/issue-") || sourceBranch === targetBranch) {
      throw new Error("Issue pushes are restricted to a new corvex/issue- branch");
    }
    if (!shaPattern.test(expectedTargetSha)) throw new Error("expected target SHA must be full-length");
    for (const branch of [sourceBranch, targetBranch]) {
      if (!branch || branch.startsWith("-")) throw new Error("target branch is invalid");
      await this.run(workspace.path, ["check-ref-format", "--branch", branch], undefined, maxErrorOutput, signal);
    }
    const [fetchUrl, pushUrl, status] = await Promise.all([
      this.run(workspace.path, ["remote", "get-url", "origin"], undefined, maxErrorOutput, signal),
      this.run(workspace.path, ["remote", "get-url", "--push", "origin"], undefined, maxErrorOutput, signal),
      this.getWorkspaceStatus(workspace, signal),
    ]);
    if (
      fetchUrl.stdout.toString().trim() !== expectedRepositoryUrl ||
      pushUrl.stdout.toString().trim() !== expectedRepositoryUrl
    ) {
      throw new Error("Git origin does not match the authorized GitLab project repository");
    }
    if (!status.clean) throw new Error("Issue branch push requires a clean worktree");
    const target = await this.run(
      workspace.path,
      ["ls-remote", "--heads", "origin", `refs/heads/${targetBranch}`],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000, authToken: this.writeToken },
    );
    const targetSha = target.stdout.toString().trim().split(/\s+/u)[0];
    if (targetSha?.toLowerCase() !== expectedTargetSha.toLowerCase()) {
      throw new Error("GitLab target branch changed while the Issue task was running");
    }
    const source = await this.run(
      workspace.path,
      ["ls-remote", "--heads", "origin", `refs/heads/${sourceBranch}`],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000, authToken: this.writeToken },
    );
    if (source.stdout.toString().trim()) throw new Error("Issue source branch already exists; refusing to overwrite it");
    const ancestry = await this.run(
      workspace.path,
      ["merge-base", "--is-ancestor", expectedTargetSha, status.headSha],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [1] },
    );
    if (ancestry.exitCode !== 0) throw new Error("Issue branch is not descended from the pinned target commit");
    try {
      await this.run(
        workspace.path,
        ["push", "--porcelain", "origin", `${status.headSha}:refs/heads/${sourceBranch}`],
        undefined,
        maxErrorOutput,
        signal,
        { timeoutMs: 60_000, authToken: this.writeToken },
      );
    } catch (error) {
      throw new GitPushError(`Git push outcome is unknown: ${String(error)}`, error);
    }
    return { sha: status.headSha, branch: sourceBranch };
  }

  async revertWorkspaceCommit(
    workspace: Workspace,
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; revertedSha: string }> {
    this.validateWorkspace(workspace);
    if (!shaPattern.test(sha)) throw new Error("rollback requires a full commit SHA");
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (!status.clean) throw new Error("rollback requires a clean worktree");
    if (status.headSha.toLowerCase() !== sha.toLowerCase()) {
      throw new Error("rollback is limited to the latest Corvex commit");
    }
    const result = await this.run(
      workspace.path,
      ["show", "-s", "--format=%H%x00%an%x00%ae%x00%P", sha],
      undefined,
      maxErrorOutput,
      signal,
    );
    const [commitSha, author, email, parents] = result.stdout.toString().trimEnd().split("\0");
    if (
      commitSha?.toLowerCase() !== sha.toLowerCase() ||
      author !== "Corvex Agent" ||
      email !== "corvex-agent@localhost" ||
      !parents ||
      parents.split(" ").length !== 1
    ) {
      throw new Error("rollback is limited to the latest Corvex commit");
    }
    await this.run(
      workspace.path,
      [
        "-c", "user.name=Corvex Agent",
        "-c", "user.email=corvex-agent@localhost",
        "-c", "commit.gpgsign=false",
        "revert", "--no-edit", sha,
      ],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000 },
    );
    const reverted = await this.run(workspace.path, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal);
    return { sha: reverted.stdout.toString().trim(), revertedSha: sha };
  }

  private validateFixPatch(patch: string, allowedPaths: string[]): string[] {
    // 修复提案只能修改本次 MR 已变更的现有文件。
    const allowed = new Set(allowedPaths);
    if (allowed.size === 0 || [...allowed].some((name) => !this.validPatchPath(name))) {
      throw new Error("fix patch has no authorized changed files");
    }
    const lines = patch.split("\n");
    const paths: string[] = [];
    for (let index = 0; index < lines.length;) {
      const header = (lines[index] ?? "").replace(/\r$/, "");
      if (!header.startsWith("diff --git ")) {
        if (!header.trim() && paths.length === 0) {
          index++;
          continue;
        }
        throw new Error("fix patch contains data outside a git diff section");
      }
      const sectionStart = index;
      index++;
      while (index < lines.length && !lines[index]!.startsWith("diff --git ")) index++;
      const section = lines.slice(sectionStart, index).map((line) => line.replace(/\r$/, ""));
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(section[0]!);
      if (!match) throw new Error("fix patch contains an invalid git diff header");
      const oldPath = match[1]!;
      const newPath = match[2]!;
      if (
        oldPath !== newPath ||
        !this.validIssuePatchPath(oldPath) ||
        !allowed.has(oldPath) ||
        section.some((line) => /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to)\b/.test(line)) ||
        !section.some((line) => line.startsWith("@@ "))
      ) {
        throw new Error(`fix patch modifies an unauthorized or unsupported path "${oldPath}"`);
      }
      if (!section.includes(`--- a/${oldPath}`) || !section.includes(`+++ b/${newPath}`)) {
        throw new Error("fix patch must modify existing files");
      }
      if (!paths.includes(oldPath)) paths.push(oldPath);
    }
    if (paths.length === 0) throw new Error("fix patch contains no file changes");
    return paths;
  }

  private validateIssuePatch(patch: string, trackedPaths: Set<string>): string[] {
    const lines = patch.split("\n");
    const paths: string[] = [];
    for (let index = 0; index < lines.length;) {
      const header = (lines[index] ?? "").replace(/\r$/, "");
      if (!header.startsWith("diff --git ")) {
        if (!header.trim() && paths.length === 0) {
          index++;
          continue;
        }
        throw new Error("Issue patch contains data outside a git diff section");
      }
      const sectionStart = index++;
      while (index < lines.length && !lines[index]!.startsWith("diff --git ")) index++;
      const section = lines.slice(sectionStart, index).map((line) => line.replace(/\r$/, ""));
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(section[0]!);
      if (!match) throw new Error("Issue patch contains an invalid git diff header");
      const oldPath = match[1]!;
      const newPath = match[2]!;
      const isNew = section.includes("--- /dev/null");
      const isDeleted = section.includes("+++ /dev/null");
      const modeChange = section.some((line) => /^(?:old mode|new mode|rename from|rename to|copy from|copy to|GIT binary patch|Binary files )/.test(line));
      if (
        oldPath !== newPath ||
        !this.validPatchPath(oldPath) ||
        paths.includes(oldPath) ||
        modeChange ||
        !section.some((line) => line.startsWith("@@ ")) ||
        (isNew && (trackedPaths.has(oldPath) || !section.some((line) => line === "new file mode 100644"))) ||
        (isDeleted && (!trackedPaths.has(oldPath) || !section.some((line) => line === "deleted file mode 100644"))) ||
        (!isNew && !isDeleted && !trackedPaths.has(oldPath)) ||
        (isNew ? !section.includes("+++ b/" + oldPath) :
          isDeleted ? !section.includes("--- a/" + oldPath) :
            !section.includes("--- a/" + oldPath) || !section.includes("+++ b/" + oldPath))
      ) {
        throw new Error(`Issue patch modifies an unauthorized or unsupported path "${oldPath}"`);
      }
      if (section.includes("new file mode 100755") || section.includes("deleted file mode 100755")) {
        throw new Error("Issue patch cannot add or delete executable files");
      }
      paths.push(oldPath);
    }
    if (paths.length === 0) throw new Error("Issue patch contains no file changes");
    return paths;
  }

  private validPatchPath(value: string): boolean {
    return (
      value !== "" &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
    );
  }

  private validIssuePatchPath(value: string): boolean {
    return this.validPatchPath(value) && value.split("/").every((part) =>
      part.toLowerCase() !== ".git" &&
      !/[<>:"|?*]/.test(part) &&
      !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    );
  }

  private validateWorkspace(workspace: Workspace): void {
    if (workspace.projectId <= 0 || !jobIdPattern.test(workspace.jobId) || !shaPattern.test(workspace.headSha)) {
      throw new Error("invalid workspace identity");
    }
    const expected = join(this.workspaceRoot, String(workspace.projectId), workspace.jobId);
    if (resolve(workspace.path) !== resolve(expected)) throw new Error("workspace path does not match its managed location");
  }

  private validateWorkspaceFilePath(name: string): void {
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("file path must be relative to the workspace");
    }
  }

  private validateRepositoryUrl(raw: string): string {
    let repository: URL;
    try {
      repository = new URL(raw);
    } catch (error) {
      throw new Error("repository URL must not contain credentials, query parameters, or a fragment", { cause: error });
    }
    if (repository.username || repository.password || repository.search || repository.hash) {
      throw new Error("repository URL must not contain credentials, query parameters, or a fragment");
    }
    if (
      repository.protocol !== this.gitlabUrl.protocol ||
      repository.host.toLowerCase() !== this.gitlabUrl.host.toLowerCase()
    ) {
      throw new Error("repository URL must use the configured GitLab scheme and host");
    }
    if (
      !repository.pathname ||
      repository.pathname.includes("\\") ||
      repository.pathname.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("repository URL contains an invalid path");
    }
    repository.pathname = repository.pathname.replace(/\/+$/, "");
    return repository.toString();
  }

  private async updateMirror(mirror: string, repositoryUrl: string, signal?: AbortSignal): Promise<void> {
    try {
      const info = await lstat(mirror);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("project mirror path is not a regular directory");
      const origin = (
        await this.run(mirror, ["--git-dir", mirror, "config", "--get", "remote.origin.url"], undefined, maxErrorOutput, signal)
      ).stdout.toString().trim();
      if (this.validateRepositoryUrl(origin) !== repositoryUrl) {
        throw new Error("project mirror origin does not match the authorized GitLab repository");
      }
      await this.runWithRetry(mirror, ["--git-dir", mirror, "remote", "update", "--prune"], signal);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const tempRoot = join(this.mirrorRoot, `.clone-${randomBytes(8).toString("hex")}`);
    await mkdir(tempRoot, { recursive: true });
    const tempMirror = join(tempRoot, "repository.git");
    try {
      await this.runWithRetry(this.root, ["clone", "--mirror", "--quiet", repositoryUrl, tempMirror], signal);
      await rename(tempMirror, mirror);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async removeWorktree(mirror: string, workspacePath: string, signal?: AbortSignal): Promise<void> {
    try {
      await lstat(workspacePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new Error(`inspect workspace before cleanup: ${String(error)}`, { cause: error });
    }
    await this.run(mirror, ["--git-dir", mirror, "worktree", "remove", "--force", workspacePath], undefined, maxErrorOutput, signal);
    await this.run(mirror, ["--git-dir", mirror, "worktree", "prune"], undefined, maxErrorOutput, signal);
  }

  private async runWithRetry(cwd: string, args: string[], signal?: AbortSignal): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.run(cwd, args, undefined, maxOutput, signal);
        return;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (attempt < 2) await sleep(200 * 2 ** attempt, undefined, { signal });
      }
    }
    throw lastError;
  }

  private async run(
    cwd: string,
    args: string[],
    input: Buffer | undefined,
    outputLimit: number,
    signal?: AbortSignal,
    options: GitRunOptions = {},
  ): Promise<GitResult> {
    const env = this.gitEnvironment(options.authToken ?? this.token);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("git command timed out")),
      options.timeoutMs ?? 10 * 60_000,
    );
    const commandSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn("git", args, { cwd, env, signal: commandSignal, windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outBytes = 0;
      let receivedOutBytes = 0;
      let errBytes = 0;
      let truncated = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (outBytes < outputLimit) {
          const part = chunk.subarray(0, outputLimit - outBytes);
          stdout.push(part);
          outBytes += part.length;
        }
        receivedOutBytes += chunk.length;
        if (receivedOutBytes > outputLimit) {
          truncated = true;
          if (options.terminateOnOutputLimit && !child.killed) child.kill();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = maxErrorOutput - errBytes;
        if (remaining > 0) {
          const part = chunk.subarray(0, remaining);
          stderr.push(part);
          errBytes += part.length;
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(new Error(`git command failed: ${error.message}`, { cause: error }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(stdout);
        if (
          code !== 0 &&
          !options.allowExitCodes?.includes(code ?? -1) &&
          !(options.terminateOnOutputLimit && truncated)
        ) {
          const details = Buffer.concat(stderr).toString().trim();
          rejectPromise(new Error(`git command failed: ${details || `exit code ${code}`}`));
          return;
        }
        resolvePromise({ stdout: output, truncated, exitCode: code ?? -1 });
      });
      if (input) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  private gitEnvironment(authToken: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("GIT_CONFIG_") ||
        ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CURL_VERBOSE", "GIT_TERMINAL_PROMPT"].includes(key) ||
        key.startsWith("GIT_TRACE")
      ) {
        delete env[key];
      }
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = join(this.root, ".corvex-no-global-git-config");
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_CONFIG_COUNT = authToken ? "3" : "2";
    env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    env.GIT_CONFIG_VALUE_0 = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_CONFIG_KEY_1 = "credential.helper";
    env.GIT_CONFIG_VALUE_1 = "";
    if (authToken) {
      env.GIT_CONFIG_KEY_2 = `http.${this.gitlabUrl.protocol}//${this.gitlabUrl.host}/.extraHeader`;
      env.GIT_CONFIG_VALUE_2 = `Authorization: Basic ${Buffer.from(`oauth2:${authToken}`).toString("base64")}`;
    }
    return env;
  }

  private async withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
    // 同一项目共用 Git 镜像和 worktree 元数据，修改操作必须串行执行。
    const previous = this.projectLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.projectLocks.set(projectId, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.projectLocks.get(projectId) === current) this.projectLocks.delete(projectId);
    }
  }
}
