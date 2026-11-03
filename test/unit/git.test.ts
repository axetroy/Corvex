import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiffEngine } from "../../src/git/diff.js";
import { GitManager } from "../../src/git/manager.js";
import type { Workspace } from "../../src/git/types.js";

const execFile = promisify(execFileCallback);

describe("Git workflows", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("builds a bounded diff from validated Git output", async () => {
    const workspace: Workspace = {
      projectId: 1,
      jobId: "job-1",
      path: "unused",
      headSha: "b".repeat(40),
    };
    const calls: string[][] = [];
    const engine = new DiffEngine(async (_workspace, args) => {
      calls.push(args);
      if (args.includes("--name-status")) {
        return { stdout: Buffer.from("M\0src/app.ts\0"), truncated: false };
      }
      if (args.includes("--numstat")) {
        return { stdout: Buffer.from("1\t0\tsrc/app.ts\0"), truncated: false };
      }
      return {
        stdout: Buffer.from("diff --git a/src/app.ts b/src/app.ts\n@@ -0,0 +1 @@\n+value\n"),
        truncated: false,
      };
    });
    const result = await engine.diff(workspace, "a".repeat(40), 10, 1024);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.path).toBe("src/app.ts");
    expect(result.changes[0]?.patch).toContain("+value");
    expect(calls).toHaveLength(3);
  });

  it("applies a fix patch only to an authorized tracked file", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await execFile("git", ["-C", workspacePath, "config", "core.autocrlf", "false"]);
    await writeFile(join(workspacePath, "a.txt"), "old\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const { stdout } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-1",
      path: workspacePath,
      headSha: stdout.trim(),
    };
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    await expect(manager.applyPatch(workspace, patch, ["other.txt"], 1024)).rejects.toThrow(
      "unauthorized or unsupported path",
    );
    const mismatchedHeaderPatch = patch.replace("--- a/a.txt", "--- a/other.txt").replace("+++ b/a.txt", "+++ b/other.txt");
    await expect(manager.applyWorkspacePatch(workspace, mismatchedHeaderPatch)).rejects.toThrow(
      "fix patch must modify existing files",
    );
    await expect(manager.applyWorkspacePatch(workspace, patch)).resolves.toMatchObject({
      changedFiles: ["a.txt"],
      patch: expect.stringContaining("+new"),
    });
    const newFilePatch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "",
    ].join("\n");
    await expect(manager.applyWorkspacePatch(workspace, newFilePatch)).rejects.toThrow("unauthorized or unsupported path");
  });

  it("applies and commits bounded Issue patches including new and deleted text files", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-issue-patch-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-issue");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await writeFile(join(workspacePath, "remove.txt"), "remove me\n");
    await execFile("git", ["-C", workspacePath, "add", "remove.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const { stdout } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-issue",
      path: workspacePath,
      headSha: stdout.trim(),
    };
    const patch = [
      "diff --git a/add.txt b/add.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/add.txt",
      "@@ -0,0 +1 @@",
      "+added",
      "diff --git a/remove.txt b/remove.txt",
      "deleted file mode 100644",
      "--- a/remove.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-remove me",
      "",
    ].join("\n");
    const applied = await manager.applyIssuePatch(workspace, patch, 4096);
    expect(applied.changedFiles).toEqual(["add.txt", "remove.txt"]);
    const committed = await manager.commitIssueWorkspace(workspace, "Implement issue #9", applied.changedFiles);
    expect(committed.changedFiles).toEqual(["add.txt", "remove.txt"]);
    await expect(execFile("git", ["-C", workspacePath, "show", `${committed.sha}:add.txt`])).resolves.toMatchObject({ stdout: "added\n" });
    await expect(execFile("git", ["-C", workspacePath, "cat-file", "-e", `${committed.sha}:remove.txt`])).rejects.toBeDefined();
    expect(await manager.getWorkspaceStatus(workspace)).toMatchObject({ clean: true });
  });

  it("pushes only a new Issue branch and refuses to overwrite an existing remote branch", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-issue-push-"));
    const root = join(directory, "storage");
    const barePath = join(directory, "remote.git");
    const seedPath = join(directory, "seed");
    const workspacePath = join(root, "workspaces", "7", "job-push");
    await mkdir(join(root, "workspaces", "7"), { recursive: true });
    await execFile("git", ["init", "--bare", "-q", barePath]);
    await execFile("git", ["init", "--quiet", "--initial-branch=main", seedPath]);
    await execFile("git", ["-C", seedPath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", seedPath, "config", "user.name", "Corvex test"]);
    await writeFile(join(seedPath, "base.txt"), "base\n");
    await execFile("git", ["-C", seedPath, "add", "base.txt"]);
    await execFile("git", ["-C", seedPath, "commit", "-q", "-m", "base"]);
    await execFile("git", ["-C", seedPath, "remote", "add", "origin", barePath]);
    await execFile("git", ["-C", seedPath, "push", "-q", "origin", "main"]);
    await execFile("git", ["clone", "-q", "--branch", "main", barePath, workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    const { stdout: baseOutput } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const { stdout: remoteOutput } = await execFile("git", ["-C", workspacePath, "remote", "get-url", "origin"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token", "write-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-push",
      path: workspacePath,
      headSha: baseOutput.trim(),
    };
    await execFile("git", ["-C", workspacePath, "switch", "-c", "corvex/issue-9-job1"]);
    await writeFile(join(workspacePath, "result.txt"), "implemented\n");
    await expect(manager.getWorkspaceStatus(workspace)).resolves.toMatchObject({
      clean: false,
      files: [{ status: "??", path: "result.txt" }],
    });
    const committed = await manager.commitIssueWorkspace(workspace, "Implement issue #9", ["result.txt"]);
    await expect(manager.pushIssueWorkspace(
      workspace,
      "corvex/issue-9-job1",
      "main",
      remoteOutput.trim(),
      baseOutput.trim(),
    )).resolves.toMatchObject({ sha: committed.sha, branch: "corvex/issue-9-job1" });
    await expect(manager.pushIssueWorkspace(
      workspace,
      "corvex/issue-9-job1",
      "main",
      remoteOutput.trim(),
      baseOutput.trim(),
    )).rejects.toThrow("already exists");
    const { stdout: remoteSha } = await execFile("git", ["--git-dir", barePath, "rev-parse", "refs/heads/corvex/issue-9-job1"]);
    expect(remoteSha.trim()).toBe(committed.sha);
  });

  it("returns a bounded worktree diff and supports literal path narrowing", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-worktree-diff-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await writeFile(join(workspacePath, "a.txt"), "old\n");
    await writeFile(join(workspacePath, "b.txt"), "untouched\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt", "b.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const { stdout } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-1",
      path: workspacePath,
      headSha: stdout.trim(),
    };
    await writeFile(join(workspacePath, "a.txt"), "updated\n");

    await expect(manager.getWorkspaceDiff(workspace)).resolves.toMatchObject({
      diff: expect.stringContaining("+updated"),
      truncated: false,
    });
    await expect(manager.getWorkspaceDiff(workspace, "a.txt")).resolves.toMatchObject({
      diff: expect.stringContaining("+updated"),
      truncated: false,
    });
    await expect(manager.getWorkspaceDiff(workspace, "../b.txt")).rejects.toThrow(
      "file path must be relative to the workspace",
    );
    await writeFile(join(workspacePath, "a.txt"), "z".repeat(40 << 10));
    const bounded = await manager.getWorkspaceDiff(workspace);
    expect(Buffer.byteLength(bounded.diff)).toBeLessThanOrEqual(32 << 10);
    expect(bounded.truncated).toBe(true);
  });

  it("commits tracked worktree changes with the Corvex identity", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-commit-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Local User"]);
    await writeFile(join(workspacePath, "a.txt"), "old\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const { stdout: baseSha } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token", "write-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-1",
      path: workspacePath,
      headSha: baseSha.trim(),
    };

    await writeFile(join(workspacePath, "a.txt"), "updated\n");
  await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
  await expect(manager.commitWorkspace(workspace, "Fix the regression")).rejects.toThrow("staged files are not allowed");
  await execFile("git", ["-C", workspacePath, "reset", "-q", "--", "a.txt"]);
    await expect(manager.commitWorkspace(workspace, "Fix the regression")).resolves.toMatchObject({
      message: "Fix the regression",
      changedFiles: ["a.txt"],
    });
    const { stdout: author } = await execFile("git", ["-C", workspacePath, "log", "-1", "--format=%an <%ae>"]);
    expect(author.trim()).toBe("Corvex Agent <corvex-agent@localhost>");
    await expect(manager.getWorkspaceStatus(workspace)).resolves.toMatchObject({ clean: true });
  });

  it("pushes the current commit with a normal fast-forward ref update", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-push-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    const remotePath = join(directory, "remote.git");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "--bare", "-q", remotePath]);
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Local User"]);
    await writeFile(join(workspacePath, "a.txt"), "old\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    await execFile("git", ["-C", workspacePath, "remote", "add", "origin", remotePath]);
    await execFile("git", ["-C", workspacePath, "push", "-q", "origin", "HEAD:refs/heads/feature/bug-fix"]);
    const { stdout: baseSha } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token", "write-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-1",
      path: workspacePath,
      headSha: baseSha.trim(),
    };

    await writeFile(join(workspacePath, "a.txt"), "updated\n");
    const commit = await manager.commitWorkspace(workspace, "Fix the regression");
    await expect(manager.pushWorkspace(workspace, "feature/bug-fix", remotePath)).resolves.toMatchObject({
      sha: commit.sha,
      branch: "feature/bug-fix",
    });
    const { stdout: remoteSha } = await execFile("git", ["--git-dir", remotePath, "rev-parse", "refs/heads/feature/bug-fix"]);
    expect(remoteSha.trim()).toBe(commit.sha);
    await expect(manager.pushWorkspace(workspace, "feature/bug-fix", remotePath)).rejects.toThrow(
      "remote MR source branch no longer matches",
    );
  });

  it("reverts only the latest Corvex commit without rewriting history", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-revert-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Local User"]);
    await writeFile(join(workspacePath, "a.txt"), "old\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const { stdout: baseSha } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-1",
      path: workspacePath,
      headSha: baseSha.trim(),
    };

    await writeFile(join(workspacePath, "a.txt"), "updated\n");
    const commit = await manager.commitWorkspace(workspace, "Fix the regression");
    const rollback = await manager.revertWorkspaceCommit(workspace, commit.sha);
    expect(rollback.sha).not.toBe(commit.sha);
    expect(rollback.revertedSha).toBe(commit.sha);
    await expect(manager.getWorkspaceStatus(workspace)).resolves.toMatchObject({ clean: true });
    const { stdout: content } = await execFile("git", ["-C", workspacePath, "show", "HEAD:a.txt"]);
    expect(content).toBe("old\n");
    await expect(manager.revertWorkspaceCommit(workspace, baseSha.trim())).rejects.toThrow("latest Corvex commit");
  });

  it("searches only the pinned Git tree with bounded literal path input", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-grep-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await writeFile(join(workspacePath, "src", "app.ts"), 'const targetValue = "colon:20:content";\n');
    await execFile("git", ["-C", workspacePath, "add", "src/app.ts"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const { stdout } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    await writeFile(join(workspacePath, "untracked.ts"), "targetValue\n");
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-1",
      path: workspacePath,
      headSha: stdout.trim(),
    };

    await expect(manager.grep(workspace, "targetValue", "src")).resolves.toEqual({
      matches: [{ path: "src/app.ts", line: 1, text: 'const targetValue = "colon:20:content";' }],
      truncated: false,
    });
    await expect(manager.grep(workspace, "missing", "src")).resolves.toEqual({ matches: [], truncated: false });
    await expect(manager.grep(workspace, "targetValue", "../outside")).rejects.toThrow(
      "literal workspace-relative path",
    );
  });

  it("reads commit history from the pinned Git HEAD", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-log-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await writeFile(join(workspacePath, "src", "app.ts"), "first\n");
    await execFile("git", ["-C", workspacePath, "add", "src/app.ts"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "initial implementation"]);
    await writeFile(join(workspacePath, "src", "app.ts"), "second\n");
    await execFile("git", ["-C", workspacePath, "commit", "-qam", "tighten validation"]);
    const { stdout } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const headSha = stdout.trim();
    const manager = new GitManager(root, "https://gitlab.example.com", "");
    const workspace: Workspace = { projectId: 7, jobId: "job-1", path: workspacePath, headSha };

    await expect(manager.getCommitLog(workspace, 2, "src/app.ts")).resolves.toMatchObject({
      commits: [
        { sha: headSha, subject: "tighten validation" },
        { subject: "initial implementation" },
      ],
      truncated: false,
    });
    await expect(manager.showCommit(workspace, headSha, "src/app.ts")).resolves.toMatchObject({
      sha: headSha,
      truncated: false,
      output: expect.stringContaining("+second"),
    });
    await expect(manager.showCommit(workspace, "HEAD")).rejects.toThrow("full commit SHA");
  });

  it("dry-runs and removes only old unprotected Git storage", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-cleanup-"));
    const root = join(directory, "storage");
    const manager = new GitManager(root, "https://gitlab.example.com", "");
    await manager.initialize();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const oldWorkspace = join(root, "workspaces", "7", "orphan-job");
    const activeWorkspace = join(root, "workspaces", "7", "active-job");
    const oldMirror = join(root, "mirrors", "8.git");
    const protectedMirror = join(root, "mirrors", "9.git");
    await Promise.all([
      mkdir(oldWorkspace, { recursive: true }),
      mkdir(activeWorkspace, { recursive: true }),
      mkdir(oldMirror, { recursive: true }),
      mkdir(protectedMirror, { recursive: true }),
    ]);
    await Promise.all([oldWorkspace, oldMirror].map((path) => utimes(path, old, old)));

    const candidates = await manager.cleanupStorage(
      new Set(["active-job"]),
      new Set([9]),
      new Date(Date.now() - 24 * 60 * 60_000),
    );
    expect(candidates.workspaces).toEqual([oldWorkspace]);
    expect(candidates.mirrors).toEqual([oldMirror]);
    await expect(lstat(oldWorkspace)).resolves.toBeDefined();

    await manager.cleanupStorage(
      new Set(["active-job"]),
      new Set([9]),
      new Date(Date.now() - 24 * 60 * 60_000),
      true,
    );
    await expect(lstat(oldWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(oldMirror)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(activeWorkspace)).resolves.toBeDefined();
    await expect(lstat(protectedMirror)).resolves.toBeDefined();
  });
});
