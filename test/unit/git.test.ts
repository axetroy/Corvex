import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiffEngine } from "../../src/git/diff.js";
import { GitManager, conversationWorkspaceName, gitConfigEntries } from "../../src/git/manager.js";
import type { Workspace } from "../../src/git/types.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

describe("Git environment", () => {
  it("enables long paths on Windows and keeps auth headers when configured", () => {
    const withoutAuth = new Map(gitConfigEntries("", new URL("https://gitlab.example.com")));
    expect(withoutAuth.get("core.longpaths")).toBe(process.platform === "win32" ? "true" : undefined);
    expect(withoutAuth.has("core.hooksPath")).toBe(true);
    expect(withoutAuth.has("credential.helper")).toBe(true);

    const withAuth = new Map(gitConfigEntries("token", new URL("https://gitlab.example.com")));
    expect(withAuth.get("http.https://gitlab.example.com/.extraHeader"))
      .toBe(`Authorization: Basic ${Buffer.from("oauth2:token").toString("base64")}`);
  });
});

describe("Git workflows", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("builds a bounded diff from validated Git output", async () => {
    const workspace: Workspace = {
      projectId: 1,
      eventId: "event-1",
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

  it("manages local branches, merges and reverts in a bound worktree", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "event-tools");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await writeFile(join(workspacePath, "a.txt"), "base\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    // 本地 origin 指向自身：抓取完全离线，不会尝试联网。
    await execFile("git", ["-C", workspacePath, "remote", "add", "origin", workspacePath]);
    const headSha = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const workspace: Workspace = { projectId: 7, eventId: "event-tools", path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");

    expect(await manager.listBranches(workspace)).toMatchObject({ head: headSha });
    expect(await manager.createBranch(workspace, "corvex/task")).toMatchObject({ name: "corvex/task", sha: headSha });
    expect((await manager.listBranches(workspace)).branches).toContain("corvex/task");
    expect(await manager.switchBranch(workspace, "corvex/task")).toMatchObject({ name: "corvex/task" });
    expect(await manager.fetchFromMirror(workspace)).toMatchObject({ fetched: true, sha: headSha });

    // 回到默认分支提交第二个提交，再切回任务分支合并它。
    await execFile("git", ["-C", workspacePath, "checkout", "-q", "master"]);
    await writeFile(join(workspacePath, "b.txt"), "merge\n");
    await execFile("git", ["-C", workspacePath, "add", "b.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "second"]);
    const secondSha = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    await execFile("git", ["-C", workspacePath, "checkout", "-q", "corvex/task"]);
    await expect(manager.mergeRef(workspace, secondSha)).resolves.toMatchObject({ ref: secondSha });
    const mergedSha = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    expect(mergedSha).not.toBe(secondSha);
    expect(await manager.revertWorktreeCommit(workspace, mergedSha)).toMatchObject({ revertedSha: mergedSha });
    await expect(manager.createBranch(workspace, "bad..name")).rejects.toThrow("invalid branch name");
  });

  it("applies a fix patch only to an authorized tracked file", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "event-1");
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
      eventId: "event-1",
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
    const workspacePath = join(root, "workspaces", "7", "event-issue");
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
      eventId: "event-issue",
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
    const workspacePath = join(root, "workspaces", "7", "event-push");
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
    await execFile("git", ["clone", "-q", "--config", "core.autocrlf=false", "--branch", "main", barePath, workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    const { stdout: baseOutput } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const { stdout: remoteOutput } = await execFile("git", ["-C", workspacePath, "remote", "get-url", "origin"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token", "write-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      eventId: "event-push",
      path: workspacePath,
      headSha: baseOutput.trim(),
    };
    await execFile("git", ["-C", workspacePath, "switch", "-c", "corvex/issue-9-event1"]);
    await writeFile(join(workspacePath, "result.txt"), "implemented\n");
    await expect(manager.getWorkspaceStatus(workspace)).resolves.toMatchObject({
      clean: false,
      files: [{ status: "??", path: "result.txt" }],
    });
    const committed = await manager.commitIssueWorkspace(workspace, "Implement issue #9", ["result.txt"]);
    await expect(manager.pushIssueWorkspace(
      workspace,
      "corvex/issue-9-event1",
      "main",
      remoteOutput.trim(),
      baseOutput.trim(),
    )).resolves.toMatchObject({ sha: committed.sha, branch: "corvex/issue-9-event1" });
    await expect(manager.pushIssueWorkspace(
      workspace,
      "corvex/issue-9-event1",
      "main",
      remoteOutput.trim(),
      baseOutput.trim(),
    )).rejects.toThrow("already exists");
    const { stdout: remoteSha } = await execFile("git", ["--git-dir", barePath, "rev-parse", "refs/heads/corvex/issue-9-event1"]);
    expect(remoteSha.trim()).toBe(committed.sha);
  });

  it("returns a bounded worktree diff and supports literal path narrowing", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-worktree-diff-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "event-1");
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
      eventId: "event-1",
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
    const workspacePath = join(root, "workspaces", "7", "event-1");
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
      eventId: "event-1",
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
    const workspacePath = join(root, "workspaces", "7", "event-1");
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
      eventId: "event-1",
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
    const workspacePath = join(root, "workspaces", "7", "event-1");
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
      eventId: "event-1",
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
    const workspacePath = join(root, "workspaces", "7", "event-1");
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
      eventId: "event-1",
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
    const workspacePath = join(root, "workspaces", "7", "event-1");
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
    const workspace: Workspace = { projectId: 7, eventId: "event-1", path: workspacePath, headSha };

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
    const oldWorkspace = join(root, "workspaces", "7", "orphan-event");
    const activeWorkspace = join(root, "workspaces", "7", "active-event");
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
      new Set(["active-event"]),
      new Set([9]),
      new Date(Date.now() - 24 * 60 * 60_000),
    );
    expect(candidates.workspaces).toEqual([oldWorkspace]);
    expect(candidates.mirrors).toEqual([oldMirror]);
    await expect(lstat(oldWorkspace)).resolves.toBeDefined();

    await manager.cleanupStorage(
      new Set(["active-event"]),
      new Set([9]),
      new Date(Date.now() - 24 * 60 * 60_000),
      true,
    );
    await expect(lstat(oldWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(oldMirror)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(activeWorkspace)).resolves.toBeDefined();
    await expect(lstat(protectedMirror)).resolves.toBeDefined();
  });

  it("reuses one conversation worktree across turns and realigns the snapshot", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-conversation-workspace-"));
    const root = join(directory, "storage");
    const source = join(directory, "source");
    const bare = join(directory, "project.git");
    await mkdir(source);
    await git(source, "init", "--initial-branch=main");
    await git(source, "config", "user.name", "Corvex Test");
    await git(source, "config", "user.email", "corvex@example.test");
    await writeFile(join(source, "a.txt"), "first\n");
    await git(source, "add", "a.txt");
    await git(source, "commit", "-m", "base");
    const baseSha = await git(source, "rev-parse", "HEAD");
    await writeFile(join(source, "a.txt"), "second\n");
    await git(source, "commit", "-am", "advance");
    const headSha = await git(source, "rev-parse", "HEAD");

    await execFile("git", ["init", "--bare", bare]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "origin", "main"]);
    // 预先准备镜像，并把 origin 指向不可达地址：一旦代码尝试联网抓取，测试即失败。
    const mirror = join(root, "mirrors", "7.git");
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "--mirror", bare, mirror]);
    await execFile("git", ["--git-dir", mirror, "remote", "set-url", "origin", "http://127.0.0.1:1/project.git"]);

    const manager = new GitManager(root, "http://127.0.0.1:1", "read-token");
    await manager.initialize();
    const repositoryUrl = "http://127.0.0.1:1/project.git";
    const conversationId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

    const first = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, baseSha);
    expect(first.eventId).toBe(conversationWorkspaceName(conversationId));
    expect(first.path).toBe(join(root, "workspaces", "7", conversationWorkspaceName(conversationId)));
    expect(await git(first.path, "rev-parse", "HEAD")).toBe(baseSha);

    // 未跟踪文件在复用期间必须保留：目录被重建时它会消失。
    await writeFile(join(first.path, "marker.txt"), "keep\n");
    const again = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, baseSha);
    expect(again.path).toBe(first.path);
    await expect(lstat(join(again.path, "marker.txt"))).resolves.toBeDefined();

    // 快照前进时在同一目录内对齐，而不是删除后重建。
    const advanced = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, headSha);
    expect(advanced.path).toBe(first.path);
    expect(await git(advanced.path, "rev-parse", "HEAD")).toBe(headSha);
    expect(await readFile(join(advanced.path, "a.txt"), "utf8")).toBe("second\n");
    await expect(lstat(join(advanced.path, "marker.txt"))).resolves.toBeDefined();

    await manager.removeConversationWorkspace(advanced);
    await expect(lstat(advanced.path)).rejects.toMatchObject({ code: "ENOENT" });
    // 幂等：目录已不存在时再次删除不应报错。
    await manager.removeConversationWorkspace(advanced);

    // 启动时清扫遗留 worktree，但保留镜像，下次提问可按需重建。
    const recreated = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, headSha);
    expect(await manager.removeAllConversationWorkspaces()).toMatchObject({ removed: 1 });
    await expect(lstat(recreated.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(mirror)).resolves.toBeDefined();
    await expect(manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, headSha)).resolves.toMatchObject({
      path: recreated.path,
    });
  });

  it("persists conversation file edits in a mirror ref across worktree deletion", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-conversation-changes-"));
    const root = join(directory, "storage");
    const bare = join(directory, "project.git");
    const source = join(directory, "source");
    await mkdir(source);
    await git(source, "init", "--initial-branch=main");
    await git(source, "config", "user.name", "Corvex Test");
    await git(source, "config", "user.email", "corvex@example.test");
    await writeFile(join(source, "a.txt"), "original\n");
    await git(source, "add", "a.txt");
    await git(source, "commit", "-m", "base");
    const baseSha = await git(source, "rev-parse", "HEAD");
    await execFile("git", ["init", "--bare", bare]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "origin", "main"]);
    const mirror = join(root, "mirrors", "7.git");
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "--mirror", bare, mirror]);
    await execFile("git", ["--git-dir", mirror, "remote", "set-url", "origin", "http://127.0.0.1:1/project.git"]);

    const manager = new GitManager(root, "http://127.0.0.1:1", "read-token");
    await manager.initialize();
    const conversationId = "1f2e3d4c-5b6a-7980-8a9b-0c1d2e3f4a5b";
    const repositoryUrl = "http://127.0.0.1:1/project.git";
    const workspace = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, baseSha);

    await writeFile(join(workspace.path, "a.txt"), "edited\n");
    await writeFile(join(workspace.path, "new.txt"), "new file\n");
    const saved = await manager.saveConversationChanges(workspace, conversationId);
    expect(saved?.paths.sort()).toEqual(["a.txt", "new.txt"]);
    expect(await manager.getConversationChanges(7, conversationId)).toMatchObject({
      paths: expect.arrayContaining(["a.txt", "new.txt"]),
    });

    await manager.removeConversationWorkspace(workspace);
    const restored = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, baseSha);
    expect(await readFile(join(restored.path, "a.txt"), "utf8")).toBe("edited\n");
    expect(await readFile(join(restored.path, "new.txt"), "utf8")).toBe("new file\n");

    await manager.discardConversationChanges(7, conversationId);
    expect(await manager.getConversationChanges(7, conversationId)).toBeUndefined();
    const fresh = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, baseSha);
    expect(await readFile(join(fresh.path, "a.txt"), "utf8")).toBe("original\n");
    await expect(lstat(join(fresh.path, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    // 已被数据库删除的会话 ref 会被清理；镜像 gc 不报错。
    await writeFile(join(fresh.path, "a.txt"), "orphan\n");
    await manager.saveConversationChanges(fresh, conversationId);
    expect(await manager.listConversationChanges()).toMatchObject(new Map([[conversationId, expect.any(String)]]));
    expect(await manager.pruneConversationChanges(new Set())).toBe(1);
    expect(await manager.listConversationChanges()).toMatchObject(new Map());
    expect(await manager.gcMirrors(7)).toBe(1);
  });

  it("skips protected conversation workspaces during storage cleanup", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-cleanup-conversation-"));
    const root = join(directory, "storage");
    const manager = new GitManager(root, "https://gitlab.example.com", "");
    await manager.initialize();
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const conversationId = "11111111-2222-3333-4444-555555555555";
    const conversationWorkspace = join(root, "workspaces", "7", conversationWorkspaceName(conversationId));
    const idleWorkspace = join(root, "workspaces", "7", conversationWorkspaceName("99999999-8888-7777-6666-555555555555"));
    await Promise.all([
      mkdir(conversationWorkspace, { recursive: true }),
      mkdir(idleWorkspace, { recursive: true }),
    ]);
    await Promise.all([conversationWorkspace, idleWorkspace].map((path) => utimes(path, old, old)));

    const cutoff = new Date(Date.now() - 24 * 60 * 60_000);
    const protectedPlan = await manager.cleanupStorage(new Set(), new Set(), cutoff, false, new Set([conversationId]));
    expect(protectedPlan.workspaces).toEqual([idleWorkspace]);
    const unprotectedPlan = await manager.cleanupStorage(new Set(), new Set(), cutoff, false);
    expect(unprotectedPlan.workspaces.sort()).toEqual([conversationWorkspace, idleWorkspace].sort());
  });

  it("derives conversation workspace names only from safe identifiers", () => {
    expect(conversationWorkspaceName("abc-123")).toBe("conversation-abc-123");
    expect(() => conversationWorkspaceName("../escape")).toThrow("invalid path characters");
    expect(() => conversationWorkspaceName("")).toThrow("invalid path characters");
    expect(() => conversationWorkspaceName("a/b")).toThrow("invalid path characters");
  });
});
