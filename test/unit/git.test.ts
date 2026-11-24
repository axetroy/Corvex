import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitManager, buildGitEnvironment, conversationWorkspaceName, gitConfigEntries } from "../../src/git/manager.js";
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

  it("uses the explicitly supplied token in the git auth header", () => {
    const env = buildGitEnvironment("/tmp/corvex", new URL("https://gitlab.example.com"), "user-oauth-token");
    const headerKey = Object.keys(env).find((key) => key.startsWith("GIT_CONFIG_KEY_") && env[key] === "http.https://gitlab.example.com/.extraHeader");
    expect(headerKey).toBeDefined();
    const index = headerKey!.slice("GIT_CONFIG_KEY_".length);
    expect(env[`GIT_CONFIG_VALUE_${index}`]).toBe(
      `Authorization: Basic ${Buffer.from("oauth2:user-oauth-token").toString("base64")}`,
    );
  });

  it("strips inherited askpass helpers so missing credentials fail fast instead of blocking", () => {
    const previous = process.env.GIT_ASKPASS;
    process.env.GIT_ASKPASS = "/path/to/askpass.sh";
    process.env.VSCODE_GIT_ASKPASS_MAIN = "/path/to/askpass-main.js";
    try {
      const env = buildGitEnvironment("/tmp/corvex", new URL("https://gitlab.example.com"), "");
      expect(env.GIT_ASKPASS).toBeUndefined();
      expect(env.VSCODE_GIT_ASKPASS_MAIN).toBeUndefined();
      expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      expect(env.GIT_CONFIG_GLOBAL).toBe("/tmp/corvex/.corvex-no-global-git-config");
    } finally {
      if (previous === undefined) delete process.env.GIT_ASKPASS;
      else process.env.GIT_ASKPASS = previous;
      delete process.env.VSCODE_GIT_ASKPASS_MAIN;
    }
  });
});

describe("Git workflows", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) {
      // Windows 上 git 进程退出后可能短暂持有文件句柄，重试一次再放弃。
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rm(directory, { recursive: true, force: true });
          break;
        } catch (error) {
          const locked = error instanceof Error && /EBUSY|EPERM/.test(error.message);
          if (!locked || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
    directory = "";
  });

  it("reads a bounded commit graph from the project mirror", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const bare = join(directory, "origin.git");
    const source = join(directory, "source");
    await mkdir(root, { recursive: true });
    await execFile("git", ["init", "-q", "--bare", bare]);
    await mkdir(source);
    await execFile("git", ["init", "-q", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Corvex test"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await execFile("git", ["-C", source, "add", "a.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "base"]);
    await execFile("git", ["-C", source, "checkout", "-q", "-b", "feature"]);
    await writeFile(join(source, "b.txt"), "feature\n");
    await execFile("git", ["-C", source, "add", "b.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "feature"]);
    await execFile("git", ["-C", source, "checkout", "-q", "master"]);
    await execFile("git", ["-C", source, "commit", "-q", "--allow-empty", "-m", "main"]);
    await execFile("git", ["-C", source, "merge", "-q", "--no-ff", "-m", "merge", "feature"]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "-q", "origin", "--all"]);
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "-q", "--mirror", bare, join(root, "mirrors", "9.git")]);

    const manager = new GitManager(root, "https://gitlab.example.com");
    const graph = await manager.getCommitGraph(9, { limit: 10 });
    expect(graph.nodes).toHaveLength(4);
    expect(graph.truncated).toBe(false);
    const merge = graph.nodes.find((item) => item.subject === "merge");
    expect(merge?.parents).toHaveLength(2);
    expect(graph.nodes.some((item) => item.refs.some((ref) => ref.includes("feature")))).toBe(true);

    const firstPage = await manager.getCommitGraph(9, { limit: 2 });
    expect(firstPage.nodes).toHaveLength(2);
    expect(firstPage.truncated).toBe(true);
    const secondPage = await manager.getCommitGraph(9, { limit: 2, offset: 2 });
    expect(secondPage.nodes).toHaveLength(2);
    expect(secondPage.offset).toBe(2);
  });

  it("resolves lightweight and annotated tags to their commits in the graph", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const bare = join(directory, "origin.git");
    const source = join(directory, "source");
    await mkdir(root, { recursive: true });
    await execFile("git", ["init", "-q", "--bare", bare]);
    await mkdir(source);
    await execFile("git", ["init", "-q", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Corvex test"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await execFile("git", ["-C", source, "add", "a.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "base"]);
    const first = (await execFile("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    await execFile("git", ["-C", source, "tag", "v-light"]);
    await writeFile(join(source, "b.txt"), "second\n");
    await execFile("git", ["-C", source, "add", "b.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "second"]);
    await execFile("git", ["-C", source, "tag", "-a", "v-annotated", "-m", "release"]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "-q", "origin", "--all"]);
    await execFile("git", ["-C", source, "push", "-q", "origin", "--tags"]);
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "-q", "--mirror", bare, join(root, "mirrors", "5.git")]);

    const manager = new GitManager(root, "https://gitlab.example.com");
    const graph = await manager.getCommitGraph(5, { limit: 10 });
    expect(graph.nodes.find((item) => item.sha === first)?.tags).toEqual(["v-light"]);
    const annotated = graph.nodes.find((item) => item.subject === "second");
    expect(annotated?.tags).toEqual(["v-annotated"]);
  });

  it("exports a patch that git apply can replay onto the parent", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const bare = join(directory, "origin.git");
    const source = join(directory, "source");
    await mkdir(root, { recursive: true });
    await execFile("git", ["init", "-q", "--bare", bare]);
    await mkdir(source);
    await execFile("git", ["init", "-q", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Corvex test"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await execFile("git", ["-C", source, "add", "a.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "base"]);
    await writeFile(join(source, "b.txt"), "added\n");
    await execFile("git", ["-C", source, "add", "b.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "add b"]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "-q", "origin", "--all"]);
    const head = (await execFile("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const parent = (await execFile("git", ["-C", source, "rev-parse", "HEAD~1"], { encoding: "utf8" })).stdout.trim();
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "-q", "--mirror", bare, join(root, "mirrors", "3.git")]);

    const manager = new GitManager(root, "https://gitlab.example.com");
    const { patch, truncated } = await manager.formatPatchFromMirror(3, head);
    expect(truncated).toBe(false);
    expect(patch).toMatch(/^From [0-9a-f]{40} Mon Sep 17 00:00:00 2001/m);

    const target = join(directory, "apply");
    await execFile("git", ["clone", "-q", source, target]);
    await execFile("git", ["-C", target, "checkout", "-q", parent]);
    const patchFile = join(directory, "exported.patch");
    await writeFile(patchFile, patch, "utf8");
    await execFile("git", ["-C", target, "apply", patchFile]);
    // Windows 上 core.autocrlf 可能把补丁中的 LF 检成 CRLF。
    await expect(readFile(join(target, "b.txt"), "utf8").then((text) => text.replace(/\r\n/g, "\n"))).resolves.toBe("added\n");
  });

  it("checks out local branches and tracks origin branches", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const bare = join(directory, "origin.git");
    const source = join(directory, "source");
    await mkdir(root, { recursive: true });
    await execFile("git", ["init", "-q", "--bare", bare]);
    await mkdir(source);
    await execFile("git", ["init", "-q", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Corvex test"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await execFile("git", ["-C", source, "add", "a.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "base"]);
    await execFile("git", ["-C", source, "checkout", "-q", "-b", "feature/mr"]);
    await execFile("git", ["-C", source, "commit", "-q", "--allow-empty", "-m", "feature"]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "-q", "origin", "--all"]);

    const workspacePath = join(root, "workspaces", "7", "event-tools");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["clone", "-q", source, workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    const headSha = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const workspace: Workspace = { projectId: 7, workspaceName: "event-tools", path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com");

    await execFile("git", ["-C", workspacePath, "branch", "local-one", "HEAD"]);
    expect(await manager.checkoutBranch(workspace, "local-one")).toMatchObject({ name: "local-one", fromRemote: false });
    const tracked = await manager.checkoutBranch(workspace, "master");
    expect(tracked.fromRemote).toBe(true);
    expect(await git(workspacePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    expect(await manager.currentBranch(workspace)).toBe("master");
    await execFile("git", ["-C", workspacePath, "checkout", "-q", "--detach", "HEAD"]);
    expect(await manager.currentBranch(workspace)).toBe("");
    await expect(manager.checkoutBranch(workspace, "missing")).rejects.toThrow("does not exist");
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
    const workspace: Workspace = { projectId: 7, workspaceName: "event-tools", path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com");

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

  it("fetches from a mirror worktree without touching a checked-out branch", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-mirror-pull-"));
    const root = join(directory, "storage");
    const source = join(directory, "source");
    await mkdir(source, { recursive: true });
    await execFile("git", ["init", "-q", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Corvex test"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await execFile("git", ["-C", source, "add", "a.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "base"]);
    const mirror = join(root, "mirrors", "7.git");
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "-q", "--mirror", source, mirror]);

    // 与真实对话一致：从镜像建 detached worktree，再显式检出本地分支。
    const workspacePath = join(root, "workspaces", "7", "conversation-1");
    await mkdir(join(root, "workspaces", "7"), { recursive: true });
    const headSha = (await execFile("git", [`--git-dir=${mirror}`, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    await execFile("git", ["--git-dir", mirror, "worktree", "add", "--detach", "-q", workspacePath, headSha]);
    await execFile("git", ["-C", workspacePath, "checkout", "-q", "master"]);
    // 指向镜像自身：旧实现套用镜像的 +refs/*:refs/* 会尝试更新已检出的 master 并失败。
    await execFile("git", ["-C", workspacePath, "remote", "set-url", "origin", mirror]);
    const workspace: Workspace = { projectId: 7, workspaceName: "conversation-1", path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com");

    await expect(manager.fetchFromMirror(workspace)).resolves.toMatchObject({ fetched: true, sha: headSha });
    expect((await execFile("git", ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" })).stdout.trim()).toBe("master");

    // syncMirrorFromGitLab 把远端分支写进 refs/corvex/remote/*；pull 后模型应能用 origin/<branch> 做 rebase。
    await execFile("git", ["--git-dir", mirror, "update-ref", `refs/corvex/remote/fix-asar`, headSha]);
    await manager.fetchFromMirror(workspace);
    expect((await execFile("git", ["-C", workspacePath, "rev-parse", "--verify", "origin/fix-asar"], { encoding: "utf8" })).stdout.trim()).toBe(headSha);
  });

  it("rejects merging into a dirty worktree with an actionable message", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-merge-dirty-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "conversation-1");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await writeFile(join(workspacePath, "a.txt"), "base\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const headSha = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    await writeFile(join(workspacePath, "a.txt"), "dirty\n");
    const workspace: Workspace = { projectId: 7, workspaceName: "conversation-1", path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com");

    await expect(manager.mergeRef(workspace, headSha)).rejects.toThrow("merge requires a clean worktree");
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
    const manager = new GitManager(root, "https://gitlab.example.com");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      workspaceName: "event-1",
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
    const manager = new GitManager(root, "https://gitlab.example.com");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      workspaceName: "event-1",
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
    const manager = new GitManager(root, "https://gitlab.example.com");
    const workspace: Workspace = { projectId: 7, workspaceName: "event-1", path: workspacePath, headSha };

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

    const manager = new GitManager(root, "http://127.0.0.1:1");
    await manager.initialize();
    const repositoryUrl = "http://127.0.0.1:1/project.git";
    const conversationId = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

    const first = await manager.prepareConversationWorkspace(7, conversationId, repositoryUrl, baseSha);
    expect(first.workspaceName).toBe(conversationWorkspaceName(conversationId));
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

    const manager = new GitManager(root, "http://127.0.0.1:1");
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
    // 这条用例包含多次 mirror/worktree 操作；CI 上比本地慢，默认 5s 不够。
  }, 30_000);

  it("keeps the worktree clean after saving so rebase works and its result survives", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-save-align-"));
    const root = join(directory, "storage");
    const bare = join(directory, "remote.git");
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

    const manager = new GitManager(root, "http://127.0.0.1:1");
    await manager.initialize();
    const conversationId = "9f8e7d6c-5b4a-4321-8f0e-1d2c3b4a5f6e";
    const workspace = await manager.prepareConversationWorkspace(7, conversationId, "http://127.0.0.1:1/project.git", baseSha);

    // 本地分支作为变基目标。
    await git(workspace.path, "branch", "fix");
    await writeFile(join(workspace.path, "ours.txt"), "ours\n");
    const saved = await manager.saveConversationChanges(workspace, conversationId, undefined, "add ours");
    expect(saved).toBeDefined();
    // 关键：保存后工作区立即干净，HEAD 指向保存的提交。
    expect(await manager.getWorkspaceStatus(workspace)).toMatchObject({ clean: true, headSha: saved!.sha });
    expect(await git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");

    // 变基目标前进。
    await execFile("git", ["-C", workspace.path, "checkout", "-q", "fix"]);
    await writeFile(join(workspace.path, "theirs.txt"), "theirs\n");
    await execFile("git", ["-C", workspace.path, "add", "theirs.txt"]);
    await execFile("git", [
      "-C", workspace.path,
      "-c", "user.name=Corvex Test", "-c", "user.email=corvex@example.test",
      "commit", "-q", "-m", "theirs",
    ]);
    await execFile("git", ["-C", workspace.path, "checkout", "-q", "--detach", saved!.sha]);

    // 旧实现在这里会因「工作区不干净」失败；现在保存已让工作区干净。
    const rebased = await manager.rebaseWorktree(workspace, "fix");
    expect(rebased.sha).not.toBe(saved!.sha);
    expect(await readFile(join(workspace.path, "theirs.txt"), "utf8")).toBe("theirs\n");

    // 轮末再保存时把会话 ref 同步到变基后的 HEAD，避免下一轮按旧 ref 重建而丢失结果。
    await manager.saveConversationChanges(workspace, conversationId);
    expect(await manager.getConversationChanges(7, conversationId)).toMatchObject({ sha: rebased.sha });
    // 下一轮按同一基线准备时仍保留变基结果。
    const restored = await manager.prepareConversationWorkspace(7, conversationId, "http://127.0.0.1:1/project.git", baseSha);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(rebased.sha);
  }, 30_000);

  it("clears only the conversation ref on publish, keeping turn history and the worktree", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-clear-ref-"));
    const root = join(directory, "storage");
    const source = join(directory, "source");
    await mkdir(source);
    await git(source, "init", "--initial-branch=main");
    await git(source, "config", "user.name", "Corvex Test");
    await git(source, "config", "user.email", "corvex@example.test");
    await writeFile(join(source, "a.txt"), "original\n");
    await git(source, "add", "a.txt");
    await git(source, "commit", "-m", "base");
    const baseSha = await git(source, "rev-parse", "HEAD");
    const mirror = join(root, "mirrors", "7.git");
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "--mirror", source, mirror]);
    await execFile("git", ["--git-dir", mirror, "remote", "set-url", "origin", "https://gitlab.example.com/g/p.git"]);

    const manager = new GitManager(root, "https://gitlab.example.com");
    const conversationId = "3c4d5e6f-7081-492a-b3c4-d5e6f708192a";
    const workspace = await manager.prepareConversationWorkspace(7, conversationId, "https://gitlab.example.com/g/p.git", baseSha);
    await writeFile(join(workspace.path, "a.txt"), "edited\n");
    const saved = await manager.saveConversationChanges(workspace, conversationId, undefined, "edit", "turn-1");
    expect(saved).toBeDefined();

    await manager.clearConversationChangesRef(7, conversationId);
    expect(await manager.getConversationChanges(7, conversationId)).toBeUndefined();
    // 轮次 ref 是历史记录，不能随会话 ref 一起清掉。
    expect((await manager.getConversationTurnChanges(7, conversationId, "turn-1")).files[0]?.patch).toContain("+edited");
    // worktree 仍在保存的提交上，下一轮直接用新基线准备即可。
    expect(await git(workspace.path, "rev-parse", "HEAD")).toBe(saved!.sha);
    const restored = await manager.prepareConversationWorkspace(7, conversationId, "https://gitlab.example.com/g/p.git", saved!.sha);
    expect(await readFile(join(restored.path, "a.txt"), "utf8")).toBe("edited\n");
  });

  it("rebases and cherry-picks commits in a bound worktree", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-history-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "event-tools");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    // Windows 默认的 CRLF 转换会让 git status 误判为脏工作区，rebase/cherry-pick 要求干净。
    await execFile("git", ["-C", workspacePath, "config", "core.autocrlf", "false"]);
    await execFile("git", ["-C", workspacePath, "config", "core.eol", "lf"]);
    await writeFile(join(workspacePath, "a.txt"), "base\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    await execFile("git", ["-C", workspacePath, "branch", "onto"]);
    await writeFile(join(workspacePath, "ours.txt"), "ours\n");
    await execFile("git", ["-C", workspacePath, "add", "ours.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "ours"]);
    const ours = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();

    const headSha = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const workspace: Workspace = { projectId: 7, workspaceName: "event-tools", path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com");

    // 在 onto 分支加一个提交，再把当前分支变基到它之上。
    await execFile("git", ["-C", workspacePath, "checkout", "-q", "onto"]);
    await writeFile(join(workspacePath, "theirs.txt"), "theirs\n");
    await execFile("git", ["-C", workspacePath, "add", "theirs.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "theirs"]);
    await execFile("git", ["-C", workspacePath, "checkout", "-q", "master"]);
    // Windows 的 CRLF 转换可能让刚检出的文件看起来有改动，rebase 要求干净工作区。
    await execFile("git", ["-C", workspacePath, "reset", "--hard", "HEAD"]);

    const rebased = await manager.rebaseWorktree(workspace, "onto");
    expect(rebased.onto).toBe("onto");
    expect(rebased.sha).not.toBe(headSha);
    expect(await readFile(join(workspacePath, "theirs.txt"), "utf8")).toBe("theirs\n");
    expect(await git(workspacePath, "log", "--format=%s")).toContain("ours");

    // cherry-pick 已知提交到当前 HEAD。
    await execFile("git", ["-C", workspacePath, "checkout", "-q", "onto"]);
    const picked = await manager.cherryPickWorktree(workspace, ours);
    expect(picked.pickedSha).toBe(ours);
    expect(await readFile(join(workspacePath, "ours.txt"), "utf8")).toBe("ours\n");

    // 目标不存在与非法输入要在执行前拒绝。
    await expect(manager.rebaseWorktree(workspace, "missing")).rejects.toThrow("does not exist");
    await expect(manager.cherryPickWorktree(workspace, "short")).rejects.toThrow("full commit SHA");
  });

  it("refuses to publish when there are no changes and no saved conversation commit", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-publish-empty-"));
    const root = join(directory, "storage");
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["init", "-q", "--bare", join(root, "mirrors", "7.git")]);
    const workspacePath = join(root, "workspaces", "7", "conversation-00000000-0000-4000-8000-000000000000");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await writeFile(join(workspacePath, "a.txt"), "base\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const headSha = (await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const conversationId = "00000000-0000-4000-8000-000000000000";
    const workspace: Workspace = { projectId: 7, workspaceName: `conversation-${conversationId}`, path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com");
    await expect(manager.publishToGitLabBranch(7, conversationId, workspace, "fix/a", undefined)).rejects.toThrow(
      "no changes to publish and no saved conversation commit",
    );
  });

  it("lists conversation file changes from Git objects rather than tool records", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-changes-"));
    const root = join(directory, "storage");
    const bare = join(directory, "origin.git");
    const source = join(directory, "source");
    await mkdir(root, { recursive: true });
    await execFile("git", ["init", "-q", "--bare", bare]);
    await mkdir(source);
    await execFile("git", ["init", "-q", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Corvex test"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await execFile("git", ["-C", source, "add", "a.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "base"]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "-q", "origin", "--all"]);
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "-q", "--mirror", bare, join(root, "mirrors", "7.git")]);

    const conversationId = "11111111-1111-4111-8111-111111111111";
    const mirrorPath = join(root, "mirrors", "7.git");
    await execFile("git", ["--git-dir", mirrorPath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["--git-dir", mirrorPath, "config", "user.name", "Corvex test"]);
    const headSha = (await execFile("git", ["--git-dir", mirrorPath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const workspacePath = join(root, "workspaces", "7", `conversation-${conversationId}`);
    await mkdir(join(root, "workspaces", "7"), { recursive: true });
    await execFile("git", ["--git-dir", mirrorPath, "worktree", "add", "-q", "--detach", workspacePath, headSha]);
    await writeFile(join(workspacePath, "a.txt"), "changed\n");

    const manager = new GitManager(root, "https://gitlab.example.com");
    const saved = await manager.saveConversationChangesById(7, conversationId, headSha);
    expect(saved).toBeDefined();
    const details = await manager.getConversationChangeDetails(7, conversationId);
    expect(details.sha).toBe(saved?.sha);
    expect(details.files).toHaveLength(1);
    expect(details.files[0]).toMatchObject({ path: "a.txt", status: "M" });
    expect(details.files[0]?.patch).toContain("+changed");
  });

  it("keeps a separate diff for each saved turn", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-turn-changes-"));
    const root = join(directory, "storage");
    const bare = join(directory, "origin.git");
    const source = join(directory, "source");
    await mkdir(root, { recursive: true });
    await execFile("git", ["init", "-q", "--bare", bare]);
    await mkdir(source);
    await execFile("git", ["init", "-q", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Corvex test"]);
    await writeFile(join(source, "a.txt"), "base\n");
    await execFile("git", ["-C", source, "add", "a.txt"]);
    await execFile("git", ["-C", source, "commit", "-q", "-m", "base"]);
    await execFile("git", ["-C", source, "remote", "add", "origin", bare]);
    await execFile("git", ["-C", source, "push", "-q", "origin", "--all"]);
    const mirrorPath = join(root, "mirrors", "7.git");
    await mkdir(join(root, "mirrors"), { recursive: true });
    await execFile("git", ["clone", "-q", "--mirror", bare, mirrorPath]);
    await execFile("git", ["--git-dir", mirrorPath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["--git-dir", mirrorPath, "config", "user.name", "Corvex test"]);
    const headSha = (await execFile("git", ["--git-dir", mirrorPath, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const workspacePath = join(root, "workspaces", "7", `conversation-${conversationId}`);
    await mkdir(join(root, "workspaces", "7"), { recursive: true });
    await execFile("git", ["--git-dir", mirrorPath, "worktree", "add", "-q", "--detach", workspacePath, headSha]);
    const workspace: Workspace = { projectId: 7, workspaceName: `conversation-${conversationId}`, path: workspacePath, headSha };
    const manager = new GitManager(root, "https://gitlab.example.com");

    await writeFile(join(workspacePath, "a.txt"), "turn one\n");
    const first = await manager.saveConversationChanges(workspace, conversationId, undefined, undefined, "turn-1");
    expect(first).toBeDefined();
    await writeFile(join(workspacePath, "a.txt"), "turn two\n");
    const second = await manager.saveConversationChanges(workspace, conversationId, undefined, undefined, "turn-2");
    expect(second).toBeDefined();

    const firstDiff = await manager.getConversationTurnChanges(7, conversationId, "turn-1");
    const secondDiff = await manager.getConversationTurnChanges(7, conversationId, "turn-2");
    expect(firstDiff.files[0]?.patch).toContain("+turn one");
    expect(secondDiff.files[0]?.patch).toContain("+turn two");
    expect(secondDiff.files[0]?.patch).not.toContain("+turn one");
    expect((await manager.getConversationTurnChanges(7, conversationId, "missing-turn")).files).toEqual([]);

    // 删除对话时必须同时清掉会话 ref 与所有轮次 ref。
    await manager.discardConversationChanges(7, conversationId);
    expect((await manager.getConversationChangeDetails(7, conversationId)).files).toEqual([]);
    expect((await manager.getConversationTurnChanges(7, conversationId, "turn-1")).files).toEqual([]);
    expect((await manager.getConversationTurnChanges(7, conversationId, "turn-2")).files).toEqual([]);
  });

  it("validates GitLab branch pushes before touching the network", async () => {
    const manager = new GitManager(join(tmpdir(), "corvex-push-validation"), "https://gitlab.example.com");
    const sha = "a".repeat(40);
    await expect(manager.pushBranchToGitLab(0, sha, "fix/a")).rejects.toThrow("project ID must be positive");
    await expect(manager.pushBranchToGitLab(1, "short", "fix/a")).rejects.toThrow("full SHA");
    await expect(manager.pushBranchToGitLab(1, sha, "../escape")).rejects.toThrow("invalid GitLab branch name");
    await expect(manager.pushBranchToGitLab(1, sha, "fix/a..b")).rejects.toThrow("invalid GitLab branch name");
    await expect(manager.pushBranchToGitLab(1, sha, "fix/a.lock")).rejects.toThrow("invalid GitLab branch name");
    await expect(manager.pushBranchToGitLab(1, sha, "fix/a")).rejects.toThrow("logged-in user's GitLab token is required");

    const writable = new GitManager(join(tmpdir(), "corvex-push-validation"), "https://gitlab.example.com");
    await expect(writable.pushBranchToGitLab(1, sha, "fix/a", undefined, "user-token")).rejects.toThrow("project mirror is not available");
  });

  it("derives conversation workspace names only from safe identifiers", () => {
    expect(conversationWorkspaceName("abc-123")).toBe("conversation-abc-123");
    expect(() => conversationWorkspaceName("../escape")).toThrow("invalid path characters");
    expect(() => conversationWorkspaceName("")).toThrow("invalid path characters");
    expect(() => conversationWorkspaceName("a/b")).toThrow("invalid path characters");
  });
});

