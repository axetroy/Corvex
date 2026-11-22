import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
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

    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
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

    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
    const { patch, truncated } = await manager.formatPatchFromMirror(3, head);
    expect(truncated).toBe(false);
    expect(patch).toMatch(/^From [0-9a-f]{40} Mon Sep 17 00:00:00 2001/m);

    const target = join(directory, "apply");
    await execFile("git", ["clone", "-q", source, target]);
    await execFile("git", ["-C", target, "checkout", "-q", parent]);
    const patchFile = join(directory, "exported.patch");
    await writeFile(patchFile, patch, "utf8");
    await execFile("git", ["-C", target, "apply", patchFile]);
    await expect(readFile(join(target, "b.txt"), "utf8")).resolves.toBe("added\n");
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
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");

    await execFile("git", ["-C", workspacePath, "branch", "local-one", "HEAD"]);
    expect(await manager.checkoutBranch(workspace, "local-one")).toMatchObject({ name: "local-one", fromRemote: false });
    const tracked = await manager.checkoutBranch(workspace, "master");
    expect(tracked.fromRemote).toBe(true);
    expect(await git(workspacePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
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
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
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
    const manager = new GitManager(root, "https://gitlab.example.com", "");
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

    const manager = new GitManager(root, "http://127.0.0.1:1", "read-token");
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

  it("derives conversation workspace names only from safe identifiers", () => {
    expect(conversationWorkspaceName("abc-123")).toBe("conversation-abc-123");
    expect(() => conversationWorkspaceName("../escape")).toThrow("invalid path characters");
    expect(() => conversationWorkspaceName("")).toThrow("invalid path characters");
    expect(() => conversationWorkspaceName("a/b")).toThrow("invalid path characters");
  });
});
