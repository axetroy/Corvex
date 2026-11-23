import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GitGraphNode, GitGraphOptions, GitGraphResult, Workspace } from "./types.js";

/** 单条 Git 命令允许捕获的标准输出上限。 */
const maxOutput = 16 << 20;
/** 单条 Git 命令保留的标准错误输出上限。 */
const maxErrorOutput = 4 << 10;
/** 单次工作区 diff 返回的最大字节数。 */
const maxWorkspaceDiffBytes = 32 << 10;
/** Git commit 对象的完整 SHA-1 或 SHA-256 十六进制格式。 */
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** 可安全用作工作区目录名的格式，并限制其最大长度。 */
const workspaceNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** 对话工作区目录名前缀：一个对话常驻一个 worktree，跨轮次复用。 */
const conversationWorkspacePrefix = "conversation-";
/** 对话工作区目录名格式，长度与 `workspaceNamePattern` 对齐，确保清理时能被识别。 */
const conversationWorkspacePattern = /^conversation-[0-9a-fA-F](?:[0-9a-fA-F-]{0,113}[0-9a-fA-F])?$/;
/** 对话本地改动 ref 名：只允许安全字符，避免注入进 git 参数。 */
const conversationRefPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function conversationChangesRef(conversationId: string): string {
  if (!conversationRefPattern.test(conversationId)) {
    throw new Error("conversation ID contains invalid path characters");
  }
  return `refs/conversations/${conversationId}`;
}

/** 每轮改动单独留一个 ref，便于按轮查看 diff；与会话 ref 分开命名空间避免冲突。 */
function conversationTurnRef(conversationId: string, turnId: string): string {
  if (!conversationRefPattern.test(conversationId) || !conversationRefPattern.test(turnId)) {
    throw new Error("conversation or turn ID contains invalid characters");
  }
  return `refs/conversation-turns/${conversationId}/${turnId}`;
}


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

export interface GitStorageCleanupPlan {
  workspaces: string[];
  mirrors: string[];
  applied: boolean;
}

/**
 * 由对话 ID 推导常驻工作区目录名。对话 ID 是 UUID，先做严格校验再拼进路径，
 * 避免任何非受管名称落进 workspace 根目录，也让 `storage cleanup` 能识别并保护它。
 */
export function conversationWorkspaceName(conversationId: string): string {
  const name = `${conversationWorkspacePrefix}${conversationId}`;
  if (!conversationWorkspacePattern.test(name)) {
    throw new Error("conversation ID contains invalid path characters");
  }
  return name;
}

/**
 * 以环境变量注入 Git 配置，避免依赖用户全局配置。Windows 上必须开启
 * `core.longpaths`，否则带深层资源目录（如前端主题图片）的仓库在 worktree
 * checkout 时会因 `Filename too long` 失败。
 */
export function gitConfigEntries(authToken: string, gitlabUrl: URL): [string, string][] {
  const entries: [string, string][] = [
    ["core.hooksPath", process.platform === "win32" ? "NUL" : "/dev/null"],
    ["credential.helper", ""],
  ];
  if (process.platform === "win32") entries.push(["core.longpaths", "true"]);
  if (authToken) {
    entries.push([
      `http.${gitlabUrl.protocol}//${gitlabUrl.host}/.extraHeader`,
      `Authorization: Basic ${Buffer.from(`oauth2:${authToken}`).toString("base64")}`,
    ]);
  }
  return entries;
}

/**
 * 构造 Git 子进程环境。除隔离宿主 Git 配置外，必须移除继承来的 askpass 配置：
 * 当 GitLab 凭据缺失时，git 会调用 askpass（例如 VS Code 的弹窗脚本）等待用户输入，
 * `GIT_TERMINAL_PROMPT=0` 只关闭终端提示，无法阻止 askpass，于是 clone/fetch 永久挂起，
 * 取消信号也因为子进程阻塞而不能及时生效。移除后 git 会立即报认证失败，轮次快速收尾。
 */
export function buildGitEnvironment(root: string, gitlabUrl: URL, authToken: string): NodeJS.ProcessEnv {
  const inheritedAskpassKeys = [
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "VSCODE_GIT_ASKPASS_MAIN",
    "VSCODE_GIT_ASKPASS_NODE",
    "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
  ];
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_CONFIG_") ||
      ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CURL_VERBOSE", "GIT_TERMINAL_PROMPT"].includes(key) ||
      inheritedAskpassKeys.includes(key) ||
      key.startsWith("GIT_TRACE")
    ) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  // Git 把配置路径中的反斜杠当作转义符；Windows 上也统一使用正斜杠。
  env.GIT_CONFIG_GLOBAL = join(root, ".corvex-no-global-git-config").replaceAll("\\", "/");
  env.GIT_TERMINAL_PROMPT = "0";
  const configs = gitConfigEntries(authToken, gitlabUrl);
  env.GIT_CONFIG_COUNT = String(configs.length);
  configs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

export class GitManager {
  private readonly root: string;
  private readonly mirrorRoot: string;
  private readonly workspaceRoot: string;
  private gitlabUrl: URL;
  private token: string;
  private writeToken: string;
  private readonly projectLocks = new Map<number, Promise<void>>();

  constructor(root: string, gitlabBaseUrl: string, token: string, writeToken = "") {
    if (!root.trim()) throw new Error("Git storage root is required");
    this.root = resolve(root);
    this.mirrorRoot = join(this.root, "mirrors");
    this.workspaceRoot = join(this.root, "workspaces");
    this.gitlabUrl = new URL("http://localhost");
    this.token = "";
    this.writeToken = "";
    this.reconfigureGitLab(gitlabBaseUrl, token, writeToken);
  }

  /** 运维台修改 GitLab 连接设置后更新镜像来源校验与凭据；现有镜像在下次使用时重新校验来源。 */
  reconfigureGitLab(gitlabBaseUrl: string, token: string, writeToken: string): void {
    // 地址可在运维台设置；尚未配置时保留占位 URL，不会用它发起网络请求。
    if (gitlabBaseUrl.trim()) {
      let url: URL;
      try {
        url = new URL(gitlabBaseUrl);
      } catch (error) {
        throw new Error(`invalid GitLab base URL "${gitlabBaseUrl}"`, { cause: error });
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error(`invalid GitLab base URL "${gitlabBaseUrl}"`);
      }
      this.gitlabUrl = url;
    } else {
      this.gitlabUrl = new URL("http://localhost");
    }
    this.token = token;
    this.writeToken = writeToken;
  }

  get writeEnabled(): boolean {
    return this.writeToken.length > 0;
  }

  async initialize(): Promise<void> {
    await mkdir(this.mirrorRoot, { recursive: true, mode: 0o750 });
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o750 });
  }

  async cleanupStorage(
    protectedProjectIds: ReadonlySet<number>,
    olderThan: Date,
    apply = false,
    activeConversationIds: ReadonlySet<string> = new Set(),
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
      for (const workspaceName of await readdir(projectRoot)) {
        if (!workspaceNamePattern.test(workspaceName)) continue;
        if (
          conversationWorkspacePattern.test(workspaceName) &&
          activeConversationIds.has(workspaceName.slice(conversationWorkspacePrefix.length))
        ) {
          continue;
        }
        const workspacePath = join(projectRoot, workspaceName);
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

  /**
   * 获取一个对话的常驻 worktree：同一个对话跨轮次复用同一目录，避免每轮
   * 重新 checkout 再整棵删除。固定快照不可变，因此 HEAD 命中时只做一次
   * `rev-parse` 校验；快照变化时在同一目录内 `checkout --detach`，比重建 worktree 便宜。
   * 传入的 `signal` 只约束本次获取，不会在轮次取消时删掉可复用的目录。
   */
  async prepareConversationWorkspace(
    projectId: number,
    conversationId: string,
    repositoryUrl: string,
    expectedSha: string,
    signal?: AbortSignal,
    authToken?: string,
  ): Promise<Workspace> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    if (!shaPattern.test(expectedSha)) {
      throw new Error("expected commit SHA must be a full 40- or 64-character hexadecimal SHA");
    }
    const workspaceName = conversationWorkspaceName(conversationId);
    const canonicalUrl = this.validateRepositoryUrl(repositoryUrl);
    return this.withProjectLock(projectId, async () => {
      const mirror = join(this.mirrorRoot, `${projectId}.git`);
      await this.ensureCommit(mirror, canonicalUrl, expectedSha, signal, authToken);

      // 若该会话有持久化的本地改动，优先检出它（其父提交必须是 pinned SHA），
      // 于是 worktree 被清理后仍能恢复用户/模型编辑过的文件。
      let targetSha = expectedSha;
      const changes = await this.getConversationChanges(projectId, conversationId, signal);
      if (changes) {
        const ancestor = await this.run(
          mirror,
          ["--git-dir", mirror, "merge-base", "--is-ancestor", expectedSha, changes.sha],
          undefined,
          maxErrorOutput,
          signal,
          { timeoutMs: 10_000, allowExitCodes: [0, 1] },
        );
        if (ancestor.exitCode === 0) targetSha = changes.sha;
      }

      const projectRoot = join(this.workspaceRoot, String(projectId));
      await mkdir(projectRoot, { recursive: true, mode: 0o750 });
      const rootInfo = await lstat(projectRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error("project workspace path is not a regular directory");
      }
      const workspacePath = join(projectRoot, workspaceName);
      if (!(await this.pathExists(workspacePath)) || !(await this.alignConversationWorkspace(workspacePath, targetSha, signal))) {
        await this.removeWorktree(mirror, workspacePath);
        try {
          await this.run(mirror, ["--git-dir", mirror, "worktree", "add", "--detach", workspacePath, targetSha], undefined, maxErrorOutput, signal);
        } catch (error) {
          // checkout 失败可能留下半成品目录，清掉后下次才能重新创建。
          await this.removeWorktree(mirror, workspacePath);
          throw error;
        }
      }
      const actual = (await this.run(workspacePath, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
      if (actual.toLowerCase() !== targetSha.toLowerCase()) {
        await this.removeWorktree(mirror, workspacePath);
        throw new Error(`conversation workspace HEAD mismatch: got ${actual}, expected ${targetSha}`);
      }
      await this.touch(workspacePath);
      return { projectId, workspaceName, path: workspacePath, headSha: expectedSha };
    });
  }

  /**
   * 启动时清理所有遗留的对话 worktree：重启后不存在运行中的对话轮次，
   * 这些目录都可以按需重建，留着只会长期占用磁盘。镜像保留不动。
   */
  async removeAllConversationWorkspaces(signal?: AbortSignal): Promise<{ removed: number }> {
    let removed = 0;
    for (const projectName of await readdir(this.workspaceRoot)) {
      if (!/^[1-9]\d*$/.test(projectName)) continue;
      const projectRoot = join(this.workspaceRoot, projectName);
      const projectInfo = await lstat(projectRoot);
      if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) continue;
      const mirror = join(this.mirrorRoot, `${projectName}.git`);
      for (const name of await readdir(projectRoot)) {
        if (!conversationWorkspacePattern.test(name)) continue;
        const workspacePath = join(projectRoot, name);
        const info = await lstat(workspacePath);
        if (!info.isDirectory()) continue;
        await this.removeWorktree(mirror, workspacePath, signal);
        removed += 1;
      }
    }
    return { removed };
  }

  /** 按对话 ID 删除常驻 worktree，供会话删除接口在缓存之外也能清理目录。 */
  async removeConversationWorkspaceById(
    projectId: number,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const workspaceName = conversationWorkspaceName(conversationId);
    await this.withProjectLock(projectId, async () => {
      const workspacePath = join(this.workspaceRoot, String(projectId), workspaceName);
      if (!(await this.pathExists(workspacePath))) return;
      const mirror = join(this.mirrorRoot, `${projectId}.git`);
      await this.removeWorktree(mirror, workspacePath, signal);
    });
  }

  /** 对话本地改动 ref 是否存在，及其包含的文件路径。 */
  async getConversationChanges(
    projectId: number,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; paths: string[] } | undefined> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const ref = conversationChangesRef(conversationId);
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) return undefined;
    const head = await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "rev-parse", "--verify", "--quiet", ref],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [1] },
    );
    if (head.exitCode !== 0) return undefined;
    const sha = head.stdout.toString().trim();
    if (!shaPattern.test(sha)) throw new Error("Git returned an invalid conversation changes commit");
    const changed = await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha],
      undefined,
      64 << 10,
      signal,
      { timeoutMs: 10_000 },
    );
    if (changed.truncated) throw new Error("conversation changes file list exceeds the output limit");
    return { sha, paths: changed.stdout.toString().split("\0").filter(Boolean) };
  }

  /**
   * 把 worktree 的本地改动提交到镜像里的对话 ref。ref 的父提交是 pinned SHA，
   * 因此 worktree 被淘汰、重启或清理后都能按同一基线恢复，且不进入数据库。
   */
  async saveConversationChanges(
    workspace: Workspace,
    conversationId: string,
    signal?: AbortSignal,
    message?: string,
    turnId?: string,
  ): Promise<{ sha: string; paths: string[] } | undefined> {
    this.validateWorkspace(workspace);
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (status.clean) return undefined;
    await this.run(workspace.path, ["add", "-A", "--"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const treeResult = await this.run(workspace.path, ["write-tree"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const tree = treeResult.stdout.toString().trim();
    if (!shaPattern.test(tree)) throw new Error("git write-tree returned an invalid object id");
    const commitResult = await this.run(
      workspace.path,
      [
        "-c", "user.name=Corvex Agent", "-c", "user.email=corvex-agent@localhost", "-c", "commit.gpgsign=false",
        "commit-tree", tree, "-p", workspace.headSha, "-m", message?.trim() || `Corvex conversation changes ${conversationId}`,
      ],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000 },
    );
    const sha = commitResult.stdout.toString().trim();
    if (!shaPattern.test(sha)) throw new Error("git commit-tree returned an invalid object id");
    const ref = conversationChangesRef(conversationId);
    const mirror = join(this.mirrorRoot, `${workspace.projectId}.git`);
    await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "update-ref", ref, sha],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000 },
    );
    if (turnId) {
      await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "update-ref", conversationTurnRef(conversationId, turnId), sha],
        undefined,
        maxErrorOutput,
        signal,
        { timeoutMs: 10_000 },
      );
    }
    // 工作区文件保留实际改动，只把暂存区对齐到新 ref，避免后续状态重复上报。
    await this.run(workspace.path, ["read-tree", sha], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    return { sha, paths: status.files.map((file) => file.path) };
  }

  /** 按会话 ID 把当前 worktree 改动写入会话 ref；供控制台文件操作后立即持久化。 */
  async saveConversationChangesById(
    projectId: number,
    conversationId: string,
    expectedSha: string,
    signal?: AbortSignal,
    turnId?: string,
  ): Promise<{ sha: string; paths: string[] } | undefined> {
    const workspaceName = conversationWorkspaceName(conversationId);
    const workspace: Workspace = {
      projectId,
      workspaceName,
      path: join(this.workspaceRoot, String(projectId), workspaceName),
      headSha: expectedSha,
    };
    return this.saveConversationChanges(workspace, conversationId, signal, undefined, turnId);
  }

  /**
   * 一步完成「保存改动 + 推送到 GitLab 分支」：先用当前工作区改动生成（或复用）会话提交，
   * 再把该提交快进推到指定分支。Agent 不需要在两次调用之间传递 SHA，避免记错提交。
   */
  async publishToGitLabBranch(
    projectId: number,
    conversationId: string,
    workspace: Workspace,
    branch: string,
    message?: string,
    signal?: AbortSignal,
    authToken?: string,
  ): Promise<{ branch: string; sha: string; committed: boolean }> {
    const saved = await this.saveConversationChanges(workspace, conversationId, signal, message);
    let sha: string;
    if (saved) {
      sha = saved.sha;
    } else {
      const mirror = join(this.mirrorRoot, `${projectId}.git`);
      const ref = conversationChangesRef(conversationId);
      const existing = await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "show-ref", "--verify", "--quiet", ref],
        undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      if (existing.exitCode !== 0) {
        throw new Error("no changes to publish and no saved conversation commit");
      }
      const resolved = await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "rev-parse", ref],
        undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
      );
      sha = resolved.stdout.toString().trim();
      if (!shaPattern.test(sha)) throw new Error("conversation ref contains an invalid commit");
    }
    const pushed = await this.pushBranchToGitLab(projectId, sha, branch, signal, authToken);
    return { ...pushed, committed: Boolean(saved) };
  }

  /**
   * 把镜像中已有的提交推到该项目的 GitLab 具名分支，让 MR 能读到真实 diff。
   * 只快进、不强制：远端分支前进时 Git 自身会拒绝非快进更新；URL 由镜像 origin 读取并
   * 强制与配置的 GitLab 主机一致，不接受任意远端。需要写令牌且由用户明确要求时调用。
   */
  async pushBranchToGitLab(
    projectId: number,
    sha: string,
    branch: string,
    signal?: AbortSignal,
    authToken?: string,
  ): Promise<{ branch: string; sha: string }> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    if (!shaPattern.test(sha)) throw new Error("pushed commit must be a full SHA");
    if (
      !branch || branch.length > 200 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
      branch.includes("..") || branch.endsWith(".lock") || branch.includes("@{")
    ) {
      throw new Error("invalid GitLab branch name");
    }
    if (!authToken) throw new Error("GitLab write token is not configured");
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) throw new Error("project mirror is not available");
    const origin = (
      await this.run(mirror, ["--git-dir", mirror, "config", "--get", "remote.origin.url"], undefined, maxErrorOutput, signal)
    ).stdout.toString().trim();
    let remote: URL;
    try {
      remote = new URL(origin);
    } catch (error) {
      throw new Error("mirror origin is not a valid URL", { cause: error });
    }
    if (
      remote.username || remote.password || remote.search || remote.hash ||
      remote.protocol !== this.gitlabUrl.protocol ||
      remote.host.toLowerCase() !== this.gitlabUrl.host.toLowerCase()
    ) {
      throw new Error("mirror origin does not match the configured GitLab host");
    }
    const commitCheck = await this.run(
      mirror,
      ["--git-dir", mirror, "cat-file", "-e", `${sha}^{commit}`],
      undefined, maxErrorOutput, signal,
      { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
    if (commitCheck.exitCode !== 0) throw new Error("commit is not available in the project mirror");
    await this.run(
      mirror,
      ["--git-dir", mirror, "push", "--porcelain", origin, `${sha}:refs/heads/${branch}`],
      undefined, maxErrorOutput, signal,
      { authToken, timeoutMs: 60_000 },
    );
    await this.run(
      mirror,
      ["--git-dir", mirror, "fetch", "--quiet", origin, `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      undefined, maxErrorOutput, signal,
      { authToken, timeoutMs: 60_000 },
    );
    return { branch, sha };
  }

  private async listConversationChangeEntries(signal?: AbortSignal): Promise<Array<{ projectId: number; conversationId: string; sha: string }>> {
    const entries: Array<{ projectId: number; conversationId: string; sha: string }> = [];
    const mirrors = await readdir(this.mirrorRoot).catch(() => [] as string[]);
    for (const name of mirrors) {
      const match = /^([1-9]\d*)\.git$/.exec(name);
      if (!match) continue;
      const projectId = Number(match[1]);
      const mirror = join(this.mirrorRoot, name);
      const refs = await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "for-each-ref", "--format=%(refname) %(objectname)", "refs/conversations"],
        undefined,
        1 << 20,
        signal,
        { timeoutMs: 10_000 },
      );
      const prefix = "refs/conversations/";
      for (const line of refs.stdout.toString().split("\n")) {
        const [ref, sha] = line.trim().split(" ");
        if (!ref?.startsWith(prefix) || !sha || !shaPattern.test(sha)) continue;
        entries.push({ projectId, conversationId: ref.slice(prefix.length), sha });
      }
    }
    return entries;
  }

  /** 列出镜像中所有对话改动 ref（ID → commit SHA）。 */
  async listConversationChanges(signal?: AbortSignal): Promise<Map<string, string>> {
    return new Map((await this.listConversationChangeEntries(signal)).map((entry) => [entry.conversationId, entry.sha]));
  }

  /** 删除镜像中已无对应会话的改动 ref，返回删除数量。 */
  async pruneConversationChanges(validIds: ReadonlySet<string>, signal?: AbortSignal): Promise<number> {
    const entries = await this.listConversationChangeEntries(signal);
    let removed = 0;
    const removedIds = new Set<string>();
    for (const entry of entries) {
      if (validIds.has(entry.conversationId) || removedIds.has(entry.conversationId)) continue;
      removedIds.add(entry.conversationId);
      const mirror = join(this.mirrorRoot, `${entry.projectId}.git`);
      await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "update-ref", "-d", conversationChangesRef(entry.conversationId)],
        undefined,
        maxErrorOutput,
        signal,
        { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      // 同时删除该会话所有轮次 ref，避免删除会话后残留对象。
      await this.deleteConversationTurnRefs(mirror, entry.conversationId, signal);
      removed += 1;
    }
    return removed;
  }

  /** 回收镜像里的不可达对象；会话 ref 与远端 ref 仍可达，不受影响。 */
  async gcMirrors(retentionDays: number, signal?: AbortSignal): Promise<number> {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 36_500) {
      throw new Error("mirror retention days must be between 1 and 36500");
    }
    const mirrors = await readdir(this.mirrorRoot).catch(() => [] as string[]);
    let count = 0;
    for (const name of mirrors) {
      if (!/^[1-9]\d*\.git$/.test(name)) continue;
      const mirror = join(this.mirrorRoot, name);
      await this.run(this.mirrorRoot, ["--git-dir", mirror, "reflog", "expire", "--expire=now", "--all"], undefined, maxErrorOutput, signal, { timeoutMs: 30_000 });
      await this.run(this.mirrorRoot, ["--git-dir", mirror, "gc", "--quiet", `--prune=${retentionDays}.days`], undefined, maxErrorOutput, signal, { timeoutMs: 5 * 60_000 });
      count += 1;
    }
    return count;
  }

  /** 删除某会话所有轮次 ref；会话 ID 必须合法，不接受任意 ref 名。 */
  private async deleteConversationTurnRefs(
    mirror: string,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!conversationRefPattern.test(conversationId)) return;
    const prefix = `refs/conversation-turns/${conversationId}/`;
    const listed = await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "for-each-ref", "--format=%(refname)", prefix],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
    );
    for (const ref of listed.stdout.toString().split("\n").map((line) => line.trim()).filter(Boolean)) {
      if (!ref.startsWith(prefix)) continue;
      await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "update-ref", "-d", ref],
        undefined, maxErrorOutput, signal,
        { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      ).catch(() => undefined);
    }
  }

  /** 放弃对话的本地改动：删除 ref 并清理对应 worktree。 */
  async discardConversationChanges(
    projectId: number,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const ref = conversationChangesRef(conversationId);
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    const workspacePath = join(this.workspaceRoot, String(projectId), conversationWorkspaceName(conversationId));
    await this.withProjectLock(projectId, async () => {
      // 测试或尚未克隆的部署可能没有镜像；此时只需要清理可能存在的 worktree。
      if (await this.pathExists(mirror)) {
        await this.run(
          this.mirrorRoot,
          ["--git-dir", mirror, "update-ref", "-d", ref],
          undefined,
          maxErrorOutput,
          signal,
          { timeoutMs: 10_000, allowExitCodes: [0, 1] },
        );
        await this.deleteConversationTurnRefs(mirror, conversationId, signal);
      }
      if (await this.pathExists(workspacePath)) await this.removeWorktree(mirror, workspacePath, signal);
    });
  }

  /** 删除一个对话的常驻 worktree；目录不存在时视为已清理。 */
  async removeConversationWorkspace(workspace: Workspace, signal?: AbortSignal): Promise<void> {
    if (workspace.projectId <= 0 || !conversationWorkspacePattern.test(workspace.workspaceName)) {
      throw new Error("invalid conversation workspace identity");
    }
    const expectedPath = join(this.workspaceRoot, String(workspace.projectId), workspace.workspaceName);
    if (resolve(workspace.path) !== resolve(expectedPath)) {
      throw new Error("conversation workspace path does not match its managed location");
    }
    await this.withProjectLock(workspace.projectId, async () => {
      if (!(await this.pathExists(expectedPath))) return;
      const mirror = join(this.mirrorRoot, `${workspace.projectId}.git`);
      await this.removeWorktree(mirror, expectedPath, signal);
    });
  }

  /**
   * 尝试复用已有对话工作区：确认目录仍是受管 worktree，并把 HEAD 对齐到目标快照。
   * 返回 false 表示目录不可复用（例如残留目录或镜像元数据已失效），调用方应重建。
   */
  private async alignConversationWorkspace(
    workspacePath: string,
    expectedSha: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const head = (await this.run(workspacePath, ["rev-parse", "--verify", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
      if (head.toLowerCase() !== expectedSha.toLowerCase()) {
        await this.run(workspacePath, ["checkout", "--detach", "--force", expectedSha], undefined, maxErrorOutput, signal);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async touch(path: string): Promise<void> {
    const now = new Date();
    await utimes(path, now, now);
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

  /** 列出 worktree 中的本地分支及当前 HEAD。 */
  async listBranches(workspace: Workspace, signal?: AbortSignal): Promise<{ branches: string[]; head: string }> {
    this.validateWorkspace(workspace);
    const result = await this.run(
      workspace.path,
      ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
      undefined,
      1 << 16,
      signal,
      { timeoutMs: 10_000 },
    );
    const head = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { branches: result.stdout.toString().split("\n").map((line) => line.trim()).filter(Boolean), head };
  }

  private validateBranchName(name: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(name) || name.includes("..") || name.endsWith("/") || name.endsWith(".")) {
      throw new Error("invalid branch name");
    }
  }

  /** 在 worktree 的当前提交上创建本地分支，不切换 HEAD。 */
  async createBranch(workspace: Workspace, name: string, signal?: AbortSignal): Promise<{ name: string; sha: string }> {
    this.validateWorkspace(workspace);
    this.validateBranchName(name);
    await this.run(workspace.path, ["branch", name, "HEAD"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const sha = (await this.run(workspace.path, ["rev-parse", name], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { name, sha };
  }

  /** 切换到 worktree 中已有的本地分支；只读仓库操作，不修改远端。 */
  async switchBranch(workspace: Workspace, name: string, signal?: AbortSignal): Promise<{ name: string; sha: string }> {
    this.validateWorkspace(workspace);
    this.validateBranchName(name);
    await this.run(workspace.path, ["checkout", name], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const sha = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { name, sha };
  }

  /**
   * 检出分支：本地存在则直接切换；否则从已配置的 origin 的同名跟踪分支创建本地分支并切换。
   * 不接受任意远端 URL 或强制操作；远程引用必须已存在于本地镜像。
   */
  async checkoutBranch(workspace: Workspace, name: string, signal?: AbortSignal): Promise<{ name: string; sha: string; fromRemote: boolean }> {
    this.validateWorkspace(workspace);
    this.validateBranchName(name);
    const local = await this.run(
      workspace.path,
      ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
      undefined, maxErrorOutput, signal,
      { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
    let fromRemote = false;
    if (local.exitCode === 0) {
      await this.run(workspace.path, ["checkout", name], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    } else {
      const remoteRef = `refs/remotes/origin/${name}`;
      const remote = await this.run(
        workspace.path,
        ["show-ref", "--verify", "--quiet", remoteRef],
        undefined, maxErrorOutput, signal,
        { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      if (remote.exitCode !== 0) throw new Error(`branch ${name} does not exist locally or on origin`);
      await this.run(
        workspace.path,
        ["checkout", "-b", name, "--track", `origin/${name}`],
        undefined, maxErrorOutput, signal,
        { timeoutMs: 10_000 },
      );
      fromRemote = true;
    }
    const sha = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { name, sha, fromRemote };
  }

  /** 在 worktree 中用普通 revert commit 撤销一个本地提交，冲突时中止。 */
  async revertWorktreeCommit(workspace: Workspace, sha: string, signal?: AbortSignal): Promise<{ sha: string; revertedSha: string }> {
    this.validateWorkspace(workspace);
    if (!shaPattern.test(sha)) throw new Error("revert requires a full commit SHA");
    const parents = (await this.run(workspace.path, ["rev-list", "--parents", "-n", "1", sha], undefined, maxErrorOutput, signal))
      .stdout.toString().trim().split(/\s+/).length - 1;
    try {
      await this.run(
        workspace.path,
        ["revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), sha],
        undefined,
        maxErrorOutput,
        signal,
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      await this.run(workspace.path, ["revert", "--abort"], undefined, maxErrorOutput, signal, {
        timeoutMs: 10_000,
        allowExitCodes: [0, 1, 128],
      }).catch(() => undefined);
      throw error;
    }
    const head = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { sha: head, revertedSha: sha };
  }

  /**
   * 把当前 worktree 的提交变基到指定的本地分支或完整提交上。
   * 只接受已存在的本地/远端跟踪分支或完整 SHA；要求工作区干净，冲突时中止，不留半变基状态。
   */
  async rebaseWorktree(workspace: Workspace, onto: string, signal?: AbortSignal): Promise<{ sha: string; onto: string }> {
    this.validateWorkspace(workspace);
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (!status.clean) throw new Error("rebase requires a clean worktree; commit or save changes first");
    let target = onto;
    if (!shaPattern.test(onto)) {
      this.validateBranchName(onto);
      const local = await this.run(
        workspace.path, ["show-ref", "--verify", "--quiet", `refs/heads/${onto}`],
        undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      target = local.exitCode === 0 ? onto : `origin/${onto}`;
      const available = await this.run(
        workspace.path, ["rev-parse", "--verify", "--quiet", target],
        undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      if (available.exitCode !== 0) throw new Error(`rebase target ${onto} does not exist locally or on origin`);
    } else {
      const available = await this.run(
        workspace.path, ["cat-file", "-e", `${onto}^{commit}`],
        undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      if (available.exitCode !== 0) throw new Error("rebase target commit is not available");
    }
    try {
      await this.run(workspace.path, ["rebase", target], undefined, maxErrorOutput, signal, { timeoutMs: 60_000 });
    } catch (error) {
      await this.run(workspace.path, ["rebase", "--abort"], undefined, maxErrorOutput, signal, {
        timeoutMs: 10_000, allowExitCodes: [0, 1, 128],
      }).catch(() => undefined);
      throw error;
    }
    const sha = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { sha, onto: target };
  }

  /** 把镜像中已有的提交摘到当前 worktree；冲突时中止。 */
  async cherryPickWorktree(workspace: Workspace, sha: string, signal?: AbortSignal): Promise<{ sha: string; pickedSha: string }> {
    this.validateWorkspace(workspace);
    if (!shaPattern.test(sha)) throw new Error("cherry-pick requires a full commit SHA");
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (!status.clean) throw new Error("cherry-pick requires a clean worktree; commit or save changes first");
    const available = await this.run(
      workspace.path, ["cat-file", "-e", `${sha}^{commit}`],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
    if (available.exitCode !== 0) throw new Error("cherry-pick commit is not available in the project mirror");
    try {
      await this.run(workspace.path, ["cherry-pick", sha], undefined, maxErrorOutput, signal, { timeoutMs: 60_000 });
    } catch (error) {
      await this.run(workspace.path, ["cherry-pick", "--abort"], undefined, maxErrorOutput, signal, {
        timeoutMs: 10_000, allowExitCodes: [0, 1, 128],
      }).catch(() => undefined);
      throw error;
    }
    const head = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { sha: head, pickedSha: sha };
  }

  /** 读出 worktree 当前检出的分支；.detached HEAD 返回空字符串。 */
  async currentBranch(workspace: Workspace, signal?: AbortSignal): Promise<string> {
    this.validateWorkspace(workspace);
    const result = await this.run(
      workspace.path,
      ["symbolic-ref", "--short", "--quiet", "HEAD"],
      undefined, maxErrorOutput, signal,
      { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
    return result.exitCode === 0 ? result.stdout.toString().trim() : "";
  }

  /** 从已配置的本地镜像抓取对象；worktree 仍固定到当前提交，不自动改变 HEAD。 */
  async fetchFromMirror(workspace: Workspace, signal?: AbortSignal): Promise<{ sha: string; fetched: boolean }> {
    this.validateWorkspace(workspace);
    const before = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    await this.run(workspace.path, ["fetch", "--no-tags", "origin"], undefined, maxErrorOutput, signal, { timeoutMs: 30_000 });
    return { sha: before, fetched: true };
  }

  /** 把本地分支或完整 SHA 合并进当前 worktree；冲突时直接中止，不留下半合并状态。 */
  async mergeRef(workspace: Workspace, ref: string, signal?: AbortSignal): Promise<{ sha: string; ref: string }> {
    this.validateWorkspace(workspace);
    if (!shaPattern.test(ref)) this.validateBranchName(ref);
    try {
      await this.run(
        workspace.path,
        ["merge", "--no-edit", "--no-ff", ref],
        undefined,
        maxErrorOutput,
        signal,
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      // 冲突时清掉半合并状态，避免后续工具在 MERGE_HEAD 下继续操作。
      await this.run(workspace.path, ["merge", "--abort"], undefined, maxErrorOutput, signal, {
        timeoutMs: 10_000,
        allowExitCodes: [0, 1, 128],
      }).catch(() => undefined);
      throw error;
    }
    const sha = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    return { sha, ref };
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

  /**
   * 从项目镜像读取提交图谱：拓扑顺序 + 父提交 + 分支 ref。
   * 只做查询，不修改 worktree 或 ref；分页由 offset 控制并由 limit+1 探测是否还有更多。
   */
  async getCommitGraph(
    projectId: number,
    options: GitGraphOptions,
    signal?: AbortSignal,
  ): Promise<GitGraphResult> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 300) {
      throw new Error("graph limit must be between 1 and 300");
    }
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) {
      throw new Error("graph offset must be between 0 and 10000");
    }
    if (options.author !== undefined && (options.author.length > 200 || options.author.includes("\0"))) {
      throw new Error("invalid author filter");
    }
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) return { nodes: [], truncated: false, offset };

    const refsResult = await this.run(
      this.mirrorRoot,
      [
        "--git-dir", mirror, "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(*objectname)",
        "refs/heads", "refs/remotes", "refs/conversations", "refs/tags",
      ],
      undefined,
      1 << 20,
      signal,
      { timeoutMs: 10_000 },
    );
    const refsBySha = new Map<string, string[]>();
    const tagsBySha = new Map<string, string[]>();
    for (const line of refsResult.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [refname, objectSha, dereferencedSha] = line.split("\0");
      // lightweight tag 的 *objectname 为空，annotated tag 需解引用到目标提交。
      const sha = dereferencedSha || objectSha;
      if (!refname || !sha || !shaPattern.test(sha)) continue;
      const isTag = refname.startsWith("refs/tags/");
      const shortName = refname.replace(/^refs\/(?:tags|heads|remotes|conversations)\//, "");
      const target = isTag ? tagsBySha : refsBySha;
      const names = target.get(sha) ?? [];
      if (!names.includes(shortName)) names.push(shortName);
      target.set(sha, names);
    }

    const revResult = await this.run(
      this.mirrorRoot,
      [
        "--git-dir", mirror, "rev-list", "--parents", "--topo-order", "--date-order", "--all",
        ...(options.author ? [`--author=${options.author}`] : []),
        `--max-count=${options.limit + 1}`, `--skip=${offset}`,
      ],
      undefined,
      1 << 20,
      signal,
      { timeoutMs: 10_000 },
    );
    const lines = revResult.stdout.toString("utf8").split("\n").filter(Boolean);
    const truncated = lines.length > options.limit;
    const rows = lines.slice(0, options.limit);
    const shas = rows.map((line) => line.split(" ")[0]!).filter((sha) => shaPattern.test(sha));
    const details = new Map<string, { subject: string; author: string; authoredAt: string }>();
    if (shas.length) {
      const detailResult = await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "log", "--no-walk", "--format=%H%x00%an%x00%aI%x00%s%x00", ...shas],
        undefined,
        1 << 20,
        signal,
        { timeoutMs: 10_000 },
      );
      for (const record of detailResult.stdout.toString("utf8").split("\n")) {
        if (!record) continue;
        const [sha, author, authoredAt, subject] = record.split("\0");
        if (!sha || !shaPattern.test(sha)) continue;
        details.set(sha, {
          author: (author ?? "").slice(0, 256),
          authoredAt: (authoredAt ?? "").slice(0, 64),
          subject: (subject ?? "").slice(0, 512),
        });
      }
    }
    const nodes: GitGraphNode[] = rows.map((line) => {
      const [sha, ...parents] = line.split(" ").filter(Boolean);
      const detail = details.get(sha!) ?? { subject: "", author: "", authoredAt: "" };
      return {
        sha: sha!,
        parents: parents.filter((parent) => shaPattern.test(parent)),
        subject: detail.subject,
        author: detail.author,
        authoredAt: detail.authoredAt,
        refs: refsBySha.get(sha!) ?? [],
        tags: tagsBySha.get(sha!) ?? [],
      };
    });
    return { nodes, truncated, offset };
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

  /**
   * 从项目镜像读取单个提交的完整信息与补丁；与图谱同源，不依赖易被淘汰的 worktree。
   */
  /**
   * 把单个提交导出为标准 mbox 补丁（git format-patch），可直接被 git apply / git am 应用。
   * 只从项目镜像读取，不修改 worktree 或 ref。
   */
  async formatPatchFromMirror(
    projectId: number,
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ patch: string; truncated: boolean }> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    if (!shaPattern.test(sha)) throw new Error("patch export requires a full commit SHA");
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) throw new Error("project mirror is not available");
    const result = await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "format-patch", "-1", "--stdout", "--no-signature", sha],
      undefined,
      1 << 20,
      signal,
      { timeoutMs: 10_000, terminateOnOutputLimit: true },
    );
    return { patch: result.stdout.toString("utf8"), truncated: result.truncated };
  }

  /** 对比镜像中某个 ref 与其父提交，返回有界的文件状态与补丁。 */
  private async diffRefAgainstParent(
    mirror: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; files: Array<{ path: string; status: string; patch: string; truncated: boolean }>; truncated: boolean }> {
    const exists = await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "show-ref", "--verify", "--quiet", ref],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
    if (exists.exitCode !== 0) return { sha: "", files: [], truncated: false };
    const resolved = await this.run(
      this.mirrorRoot, ["--git-dir", mirror, "rev-parse", ref], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
    );
    const sha = resolved.stdout.toString().trim();
    if (!shaPattern.test(sha)) throw new Error("conversation ref contains an invalid commit");
    const parentResult = await this.run(
      this.mirrorRoot, ["--git-dir", mirror, "rev-parse", `${sha}^`], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
    );
    const base = parentResult.stdout.toString().trim();
    if (!shaPattern.test(base)) throw new Error("conversation ref has no valid parent commit");

    const status = await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "diff", "--name-status", "-z", base, sha],
      undefined, 1 << 20, signal, { timeoutMs: 30_000 },
    );
    const parts = status.stdout.toString().split("\0").filter(Boolean);
    const files: Array<{ path: string; status: string; patch: string; truncated: boolean }> = [];
    let truncated = false;
    let totalBytes = 0;
    const maxFiles = 200;
    const maxTotalBytes = 1 << 20;
    for (let index = 0; index + 1 < parts.length && files.length < maxFiles; index += 2) {
      const statusCode = parts[index]!;
      const path = parts[index + 1]!;
      if (!this.validPatchPath(path)) {
        truncated = true;
        continue;
      }
      const patchResult = await this.run(
        this.mirrorRoot,
        ["--git-dir", mirror, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", base, sha, "--", `:(literal)${path}`],
        undefined, 256 << 10, signal, { timeoutMs: 30_000, terminateOnOutputLimit: true },
      );
      const patch = patchResult.stdout.toString("utf8");
      totalBytes += Buffer.byteLength(patch);
      if (totalBytes > maxTotalBytes || patchResult.truncated) truncated = true;
      files.push({ path, status: statusCode, patch, truncated: patchResult.truncated });
    }
    if (parts.length > maxFiles * 2) truncated = true;
    return { sha, files, truncated };
  }

  /**
   * 列出会话 ref 相对其父提交（固定快照）的全部文件变更。
   * 直接从镜像的 Git 对象计算，不依赖任何工具调用记录：以后即使加入命令行，只要改动
   * 最终落进 worktree/会话 ref，这里就能检测到。
   */
  async getConversationChangeDetails(
    projectId: number,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; files: Array<{ path: string; status: string; patch: string; truncated: boolean }>; truncated: boolean }> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) throw new Error("project mirror is not available");
    return this.diffRefAgainstParent(mirror, conversationChangesRef(conversationId), signal);
  }

  /** 列出某一轮保存的文件变更；该轮没有写入改动时返回空列表。 */
  async getConversationTurnChanges(
    projectId: number,
    conversationId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; files: Array<{ path: string; status: string; patch: string; truncated: boolean }>; truncated: boolean }> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) throw new Error("project mirror is not available");
    return this.diffRefAgainstParent(mirror, conversationTurnRef(conversationId, turnId), signal);
  }

  /** 列出镜像中所有提交作者（去重、有界），供控制台的图谱筛选使用。 */
  async listCommitAuthors(projectId: number, signal?: AbortSignal): Promise<string[]> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) return [];
    const result = await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "log", "--all", "--format=%an"],
      undefined,
      1 << 20,
      signal,
      { timeoutMs: 10_000, terminateOnOutputLimit: true },
    );
    const authors = new Set<string>();
    for (const name of result.stdout.toString("utf8").split("\n")) {
      const trimmed = name.trim().slice(0, 200);
      if (trimmed) authors.add(trimmed);
      if (authors.size >= 200) break;
    }
    return [...authors].sort((a, b) => a.localeCompare(b));
  }

  async showCommitFromMirror(
    projectId: number,
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; output: string; truncated: boolean }> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    if (!shaPattern.test(sha)) throw new Error("commit lookup requires a full commit SHA");
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) throw new Error("project mirror is not available");
    const result = await this.run(
      this.mirrorRoot,
      [
        "--git-dir", mirror, "show", "--no-ext-diff", "--no-textconv", "--no-renames",
        "--no-color", "--format=fuller", "--unified=3", sha,
      ],
      undefined,
      256 << 10,
      signal,
      { timeoutMs: 10_000, terminateOnOutputLimit: true },
    );
    return { sha, output: result.stdout.toString("utf8"), truncated: result.truncated };
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
    if (workspace.projectId <= 0 || !workspaceNamePattern.test(workspace.workspaceName) || !shaPattern.test(workspace.headSha)) {
      throw new Error("invalid workspace identity");
    }
    const expected = join(this.workspaceRoot, String(workspace.projectId), workspace.workspaceName);
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
    // 仓库地址由配置的 gitlab.base_url 派生，这里强制主机一致：
    // 只从配置允许的 GitLab 主机克隆/推送，避免被外部数据带去访问其它远端。
    if (
      repository.protocol !== this.gitlabUrl.protocol ||
      repository.host.toLowerCase() !== this.gitlabUrl.host.toLowerCase()
    ) {
      throw new Error(
        `repository URL must use the configured GitLab scheme and host, expected ${this.gitlabUrl.host.toLowerCase()}, got ${repository.host.toLowerCase()}`,
      );
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

  private async ensureMirror(mirror: string, repositoryUrl: string, signal?: AbortSignal, authToken?: string): Promise<void> {
    try {
      const info = await lstat(mirror);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("project mirror path is not a regular directory");
      const origin = (
        await this.run(mirror, ["--git-dir", mirror, "config", "--get", "remote.origin.url"], undefined, maxErrorOutput, signal)
      ).stdout.toString().trim();
      if (this.validateRepositoryUrl(origin) !== repositoryUrl) {
        // 配置的 GitLab 地址变更后，旧镜像仍指向之前的主机。路径一致时只更新
        // origin（新地址由配置派生、主机可信），避免为每个仓库重新克隆一遍。
        const previous = new URL(origin);
        const current = new URL(repositoryUrl);
        if (previous.pathname.replace(/\/+$/, "") !== current.pathname.replace(/\/+$/, "")) {
          throw new Error("project mirror origin does not match the authorized GitLab repository");
        }
        await this.run(
          mirror,
          ["--git-dir", mirror, "config", "remote.origin.url", repositoryUrl],
          undefined,
          maxErrorOutput,
          signal,
        );
      }
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const tempRoot = join(this.mirrorRoot, `.clone-${randomBytes(8).toString("hex")}`);
    await mkdir(tempRoot, { recursive: true });
    const tempMirror = join(tempRoot, "repository.git");
    try {
      await this.runWithRetry(this.root, ["clone", "--mirror", "--quiet", repositoryUrl, tempMirror], signal, authToken);
      await rename(tempMirror, mirror);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  /** 保证镜像存在且 origin 匹配；只有需要刷新分支指针时才联网。 */
  private async updateMirror(mirror: string, repositoryUrl: string, signal?: AbortSignal, authToken?: string): Promise<void> {
    await this.ensureMirror(mirror, repositoryUrl, signal, authToken);
    await this.runWithRetry(mirror, ["--git-dir", mirror, "remote", "update", "--prune"], signal, authToken);
  }

  /**
   * 保证镜像里已有指定提交：命中本地对象库时不联网，缺失时才按 SHA 定向抓取。
   * 固定的提交快照是不可变的，因此重复请求同一 SHA（例如同一分支的后续对话轮次）
   * 不需要每次刷新远端。
   */
  private async ensureCommit(mirror: string, repositoryUrl: string, sha: string, signal?: AbortSignal, authToken?: string): Promise<void> {
    await this.ensureMirror(mirror, repositoryUrl, signal, authToken);
    if (await this.hasCommit(mirror, sha, signal)) return;
    await this.runWithRetry(mirror, ["--git-dir", mirror, "fetch", "--no-tags", "origin", sha], signal, authToken);
    if (!(await this.hasCommit(mirror, sha, signal))) {
      throw new Error(`GitLab did not provide the expected commit ${sha}`);
    }
  }

  private async hasCommit(mirror: string, sha: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.run(
      mirror,
      ["--git-dir", mirror, "cat-file", "-e", `${sha}^{commit}`],
      undefined,
      maxErrorOutput,
      signal,
      { allowExitCodes: [1, 128] },
    );
    return result.exitCode === 0;
  }

  private async removeWorktree(mirror: string, workspacePath: string, signal?: AbortSignal): Promise<void> {
    try {
      await lstat(workspacePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw new Error(`inspect workspace before cleanup: ${String(error)}`, { cause: error });
    }
    let mirrorExists = false;
    try {
      const info = await lstat(mirror);
      mirrorExists = info.isDirectory() && !info.isSymbolicLink();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (mirrorExists) {
      try {
        await this.run(mirror, ["--git-dir", mirror, "worktree", "remove", "--force", workspacePath], undefined, maxErrorOutput, signal);
      } catch {
        // 目录残留但已不是受管 worktree（例如镜像元数据被 prune 过）时直接删除。
      }
    }
    // 无论上一步是否成功都确保目录消失，避免残留目录永久占用磁盘并阻塞后续复用。
    await rm(workspacePath, { recursive: true, force: true });
    if (mirrorExists) {
      await this.run(mirror, ["--git-dir", mirror, "worktree", "prune"], undefined, maxErrorOutput, signal);
    }
  }

  private async runWithRetry(cwd: string, args: string[], signal?: AbortSignal, authToken?: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.run(cwd, args, undefined, maxOutput, signal, authToken ? { authToken } : undefined);
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
    return buildGitEnvironment(this.root, this.gitlabUrl, authToken);
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
