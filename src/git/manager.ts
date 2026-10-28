import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DiffEngine } from "./diff.js";
import type { DiffResult, Workspace } from "./types.js";

const maxOutput = 16 << 20;
const maxErrorOutput = 4 << 10;
const maxReadFileBytes = 16 << 20;
const maxPatchBytes = 256 << 10;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const jobIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

interface GitResult {
  stdout: Buffer;
  truncated: boolean;
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

  constructor(root: string, gitlabBaseUrl: string, private readonly token: string) {
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

  async cleanupWorkspace(workspace: Workspace, signal?: AbortSignal): Promise<void> {
    if (workspace.projectId <= 0 || !jobIdPattern.test(workspace.jobId)) {
      throw new Error("invalid workspace identity");
    }
    const expectedPath = join(this.workspaceRoot, String(workspace.projectId), workspace.jobId);
    if (resolve(workspace.path) !== resolve(expectedPath)) {
      throw new Error("workspace path does not match its managed location");
    }
    await this.withProjectLock(workspace.projectId, async () => {
      await this.removeWorktree(join(this.mirrorRoot, `${workspace.projectId}.git`), expectedPath, signal);
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

  private validateFixPatch(patch: string, allowedPaths: string[]): string[] {
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
        !this.validPatchPath(oldPath) ||
        !allowed.has(oldPath) ||
        section.some((line) => /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to)\b/.test(line)) ||
        !section.some((line) => line.startsWith("@@ "))
      ) {
        throw new Error(`fix patch modifies an unauthorized or unsupported path "${oldPath}"`);
      }
      if (!section.some((line) => line.startsWith("--- a/")) || !section.some((line) => line.startsWith("+++ b/"))) {
        throw new Error("fix patch must modify existing files");
      }
      if (!paths.includes(oldPath)) paths.push(oldPath);
    }
    if (paths.length === 0) throw new Error("fix patch contains no file changes");
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
  ): Promise<GitResult> {
    const env = this.gitEnvironment();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("git command timed out")), 10 * 60_000);
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
        if (receivedOutBytes > outputLimit) truncated = true;
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
        if (code !== 0) {
          const details = Buffer.concat(stderr).toString().trim();
          rejectPromise(new Error(`git command failed: ${details || `exit code ${code}`}`));
          return;
        }
        resolvePromise({ stdout: output, truncated });
      });
      if (input) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  private gitEnvironment(): NodeJS.ProcessEnv {
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
    env.GIT_CONFIG_COUNT = this.token ? "3" : "2";
    env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    env.GIT_CONFIG_VALUE_0 = process.platform === "win32" ? "NUL" : "/dev/null";
    env.GIT_CONFIG_KEY_1 = "credential.helper";
    env.GIT_CONFIG_VALUE_1 = "";
    if (this.token) {
      env.GIT_CONFIG_KEY_2 = `http.${this.gitlabUrl.protocol}//${this.gitlabUrl.host}/.extraHeader`;
      env.GIT_CONFIG_VALUE_2 = `Authorization: Basic ${Buffer.from(`oauth2:${this.token}`).toString("base64")}`;
    }
    return env;
  }

  private async withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
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
