import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { needsCommitMessageRewrite } from "./commit-message.js";
import { commitTreeArgs, withCommitTrailer, type CommitAuthor, type CommitPolicy } from "./commit-identity.js";
import { isValidBranchName } from "./refs.js";
import { buildSubmodulePlan, normalizeAllowedOrigin, parseGitmodules, parseSubmoduleHostTokens, type SkippedSubmodule } from "./submodules.js";
import type { GitGraphNode, GitGraphOptions, GitGraphResult, Workspace } from "./types.js";

/** 子模块只读检出选项；凭据与白名单都由运维台运行时设置提供。 */
export interface SubmoduleOptions {
  allowedOrigins?: string[];
  hostTokens?: string;
  onNotice?: (reason: "fetched" | SkippedSubmodule["reason"], path: string) => void;
}

const maxSubmoduleCount = 10;
const maxSubmoduleFetchBytes = 256 << 20;

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
  /** 只对指定 origin 生效的凭据；用户 OAuth token 绝不会用于第三方 host。 */
  extraHeaders?: { origin: string; token: string }[];
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

/** 管理页展示的一条回答：镜像或工作树目录的只读统计。 */
export interface StorageEntry {
  projectId: number;
  /** 目录名，如 `62.git` 或 `conversation-<uuid>`。 */
  name: string;
  /** 相对存储根目录的路径，用于展示与去重，不接受外部写入。 */
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  /** 仅工作树条目：对应的对话 ID（名称不符合约定时为空）。 */
  conversationId?: string;
  /** 该条目的大小统计是否因节点/深度上限而截断。 */
  truncated: boolean;
}

export interface StorageDescription {
  mirrors: StorageEntry[];
  workspaces: StorageEntry[];
  /** 任意条目截断或列表本身超限时为真，界面应提示数据为近似值。 */
  truncated: boolean;
}

/** 单条目大小扫描的节点上限：packed Git 仓库几个文件即可覆盖主要体积，loose objects 过多时标记为截断。 */
const maxStorageSizeNodes = 50_000;
/** 单条目大小扫描的深度上限，避免异常深层目录导致栈溢出。 */
const maxStorageSizeDepth = 64;
/** 镜像/工作树列表各自的最大展示条数。 */
const maxStorageEntries = 2_000;

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
  private readonly projectLocks = new Map<number, Promise<void>>();

  /** 由 Runner 注入：按会话 ID 找到发起用户，作为会话提交的 author。 */
  private readonly resolveCommitAuthor?: (conversationId: string) => CommitAuthor | undefined;
  private readonly commitPolicy?: () => CommitPolicy;

  constructor(
    root: string,
    gitlabBaseUrl: string,
    resolveCommitAuthor?: (conversationId: string) => CommitAuthor | undefined,
    commitPolicy?: () => CommitPolicy,
  ) {
    this.resolveCommitAuthor = resolveCommitAuthor;
    this.commitPolicy = commitPolicy;
    if (!root.trim()) throw new Error("Git storage root is required");
    this.root = resolve(root);
    this.mirrorRoot = join(this.root, "mirrors");
    this.workspaceRoot = join(this.root, "workspaces");
    this.gitlabUrl = new URL("http://localhost");
    this.reconfigureGitLab(gitlabBaseUrl);
  }

  /** 会话提交一律用用户身份；没有可用身份时退回系统身份，绝不写成 Agent。 */
  private commitAuthor(conversationId: string): CommitAuthor {
    return this.resolveCommitAuthor?.(conversationId) ?? this.policy().fallback;
  }

  /** 运行时读取，管理中心改设置后无需重启。 */
  private policy(): CommitPolicy {
    return this.commitPolicy?.() ?? {
      trailer: "",
      fallback: { name: "Corvex", email: "no.reply@corvex-agent.com" },
    };
  }

  /** 运维台修改 GitLab 地址后更新镜像来源校验；现有镜像在下次使用时重新校验来源。 */
  reconfigureGitLab(gitlabBaseUrl: string): void {
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
  }

  async initialize(): Promise<void> {
    await mkdir(this.mirrorRoot, { recursive: true, mode: 0o750 });
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o750 });
  }

  /**
   * 递归统计目录字节数；符号链接跳过，节点/深度超限时置 truncated 并停止深入。
   * 并发清理导致目录消失（ENOENT）时跳过该条目，不让整个管理页请求失败。
   * 传入 stopAtBytes 时一旦累计超过该值立即停止遍历（只判断是否超限，不追求精确），
   * 并用 exceeded 标记；这能让「每轮一次」的容量检查在超大 worktree 上快速返回。
   */
  private async measureDirectory(
    directory: string,
    stopAtBytes?: number,
  ): Promise<{ bytes: number; truncated: boolean; exceeded: boolean }> {
    let nodes = 0;
    let truncated = false;
    let exceeded = false;
    const walk = async (path: string, depth: number): Promise<number> => {
      if (exceeded || nodes >= maxStorageSizeNodes || depth > maxStorageSizeDepth) {
        if (nodes >= maxStorageSizeNodes || depth > maxStorageSizeDepth) truncated = true;
        return 0;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
        throw error;
      }
      let total = 0;
      for (const entry of entries) {
        if (exceeded) return total;
        if (nodes >= maxStorageSizeNodes) {
          truncated = true;
          break;
        }
        // 符号链接一律跳过：既不跟随出受管根目录，也不重复计数。
        if (entry.isSymbolicLink()) continue;
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          total += await walk(child, depth + 1);
        } else if (entry.isFile()) {
          nodes += 1;
          try {
            const info = await lstat(child);
            total += info.size;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
            throw error;
          }
          if (stopAtBytes !== undefined && total >= stopAtBytes) {
            exceeded = true;
            return total;
          }
        }
      }
      return total;
    };
    const bytes = await walk(directory, 0);
    return { bytes, truncated, exceeded };
  }

  /**
   * 单个会话 worktree 的有界大小检查；超过节点/深度上限时 truncated 为真（结果为近似值）。
   * 传入 stopAtBytes 可提前结束遍历（只关心是否超限）。
   */
  async measureWorkspace(
    workspace: Workspace,
    stopAtBytes?: number,
  ): Promise<{ bytes: number; truncated: boolean; exceeded: boolean }> {
    this.validateWorkspace(workspace);
    const path = join(this.workspaceRoot, String(workspace.projectId), workspace.workspaceName);
    return this.measureDirectory(path, stopAtBytes);
  }

  /**
   * 只读扫描镜像与工作树目录，供运维台「存储管理」页展示大小与修改时间。
   * 不修改任何文件，也不建立项目锁——读到的 mtime/大小是扫描瞬间的近似值。
   */
  async describeStorage(): Promise<StorageDescription> {
    await this.initialize();
    for (const root of [this.workspaceRoot, this.mirrorRoot]) {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`managed Git storage path "${root}" is not a regular directory`);
      }
    }

    const mirrors: StorageEntry[] = [];
    for (const name of await readdir(this.mirrorRoot)) {
      if (mirrors.length >= maxStorageEntries) break;
      const match = /^([1-9]\d*)\.git$/.exec(name);
      if (!match) continue;
      const projectId = Number(match[1]);
      if (!Number.isSafeInteger(projectId)) continue;
      const path = join(this.mirrorRoot, name);
      let info;
      try { info = await lstat(path); } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      const size = await this.measureDirectory(path);
      mirrors.push({
        projectId,
        name,
        relativePath: `mirrors/${name}`,
        sizeBytes: size.bytes,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
        truncated: size.truncated,
      });
    }

    const workspaces: StorageEntry[] = [];
    for (const projectName of await readdir(this.workspaceRoot)) {
      if (workspaces.length >= maxStorageEntries) break;
      if (!/^[1-9]\d*$/.test(projectName)) continue;
      const projectId = Number(projectName);
      if (!Number.isSafeInteger(projectId)) continue;
      const projectRoot = join(this.workspaceRoot, projectName);
      let projectInfo;
      try { projectInfo = await lstat(projectRoot); } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) continue;
      for (const name of await readdir(projectRoot)) {
        if (workspaces.length >= maxStorageEntries) break;
        if (!workspaceNamePattern.test(name)) continue;
        const path = join(projectRoot, name);
        let info;
        try { info = await lstat(path); } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const size = await this.measureDirectory(path);
        const conversationId = conversationWorkspacePattern.test(name)
          ? name.slice(conversationWorkspacePrefix.length)
          : undefined;
        workspaces.push({
          projectId,
          name,
          relativePath: `workspaces/${projectName}/${name}`,
          sizeBytes: size.bytes,
          modifiedAt: new Date(info.mtimeMs).toISOString(),
          ...(conversationId ? { conversationId } : {}),
          truncated: size.truncated,
        });
      }
    }

    return {
      mirrors,
      workspaces,
      truncated: mirrors.length >= maxStorageEntries || workspaces.length >= maxStorageEntries ||
        mirrors.some((entry) => entry.truncated) || workspaces.some((entry) => entry.truncated),
    };
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

    // 空的项目目录（workspaces/<projectId>/ 下已无任何工作区）是删除 worktree 后的残留，
    // 与超时无关：一旦为空就是垃圾，直接纳入本次清理。
    const emptyProjectDirs: string[] = [];
    for (const projectName of await readdir(this.workspaceRoot)) {
      if (!/^[1-9]\d*$/.test(projectName)) continue;
      const projectRoot = join(this.workspaceRoot, projectName);
      const info = await lstat(projectRoot);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if ((await readdir(projectRoot)).length === 0 && !workspaces.some((path) => path.startsWith(`${projectRoot}${sep}`))) {
        emptyProjectDirs.push(projectRoot);
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
      // 删除空项目目录：本轮刚移除 worktree 的目录现在也可能为空，重新扫描一遍。
      // 同样必须持有项目锁，避免误删正在准备 worktree 的空目录（见 pruneEmptyWorkspaceDirs 注释）。
      for (const projectName of await readdir(this.workspaceRoot)) {
        if (!/^[1-9]\d*$/.test(projectName)) continue;
        const projectId = Number(projectName);
        if (!Number.isSafeInteger(projectId)) continue;
        const projectRoot = join(this.workspaceRoot, projectName);
        await this.withProjectLock(projectId, async () => {
          const info = await lstat(projectRoot).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
            throw error;
          });
          if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
          if ((await readdir(projectRoot)).length === 0) await rm(projectRoot, { recursive: true });
        });
      }
    }
    return { workspaces: [...workspaces, ...emptyProjectDirs], mirrors, applied: apply };
  }

  /**
   * 删除 workspaces 下已经空掉的项目目录；返回删除数量。
   *
   * 必须与 `prepareConversationWorkspace` 持有同一把项目锁：后者先 mkdir 空的项目目录，
   * 再 worktree add，中间的窗口若被清理线程扫到就会误删正在准备中的目录，导致 worktree add
   * 失败或写到一个已被删除的路径。加锁后二者串行，且在锁内二次确认仍然为空。
   */
  async pruneEmptyWorkspaceDirs(): Promise<number> {
    await this.initialize();
    let removed = 0;
    for (const projectName of await readdir(this.workspaceRoot)) {
      if (!/^[1-9]\d*$/.test(projectName)) continue;
      const projectId = Number(projectName);
      if (!Number.isSafeInteger(projectId)) continue;
      const projectRoot = join(this.workspaceRoot, projectName);
      await this.withProjectLock(projectId, async () => {
        const info = await lstat(projectRoot).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
        // 锁内二次确认：进入锁之前可能有新 turn 创建了 worktree。
        if ((await readdir(projectRoot)).length === 0) {
          await rm(projectRoot, { recursive: true });
          removed += 1;
        }
      });
    }
    return removed;
  }

  /** 读取提交树里的 gitlink 与 .gitmodules；两者取交集后才考虑检出。 */
  private async readSubmoduleSpecs(
    mirror: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ links: { path: string; sha: string }[]; gitmodules: Map<string, string> }> {
    const [tree, modules] = await Promise.all([
      this.run(mirror, ["--git-dir", mirror, "ls-tree", "-r", "-z", sha], undefined, 1 << 20, signal, {
        timeoutMs: 10_000,
      }),
      this.run(mirror, ["--git-dir", mirror, "show", `${sha}:.gitmodules`], undefined, 64 << 10, signal, {
        timeoutMs: 10_000,
        allowExitCodes: [0, 128],
      }),
    ]);
    const links: { path: string; sha: string }[] = [];
    for (const entry of tree.stdout.toString("utf8").split("\0")) {
      const match = /^160000 commit ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(entry);
      if (match && links.length < maxSubmoduleCount) links.push({ sha: match[1], path: match[2] });
    }
    return { links, gitmodules: modules.exitCode === 0 ? parseGitmodules(modules.stdout.toString("utf8")) : new Map() };
  }

  /** 子模块目录必须落在 worktree 内且路径各段都不是符号链接。 */
  private async safeSubmodulePath(root: string, relative: string): Promise<string | undefined> {
    this.validateWorkspaceFilePath(relative);
    let current = resolve(root);
    for (const segment of relative.split("/")) {
      current = join(current, segment);
      const info = await lstat(current).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info?.isSymbolicLink()) return undefined;
    }
    return current;
  }

  /**
   * 只读检出子模块：直接在 gitlink 指向的目录里初始化独立仓库并 fetch 固定的 commit，
   * 不改写 .gitmodules，也不在 mirror 里留下 modules 目录。写工具仍会拒绝这些路径。
   */
  private async prepareSubmodules(
    workspace: Workspace,
    mirror: string,
    sha: string,
    options: SubmoduleOptions,
    signal?: AbortSignal,
    authToken?: string,
  ): Promise<string[]> {
    const { links, gitmodules } = await this.readSubmoduleSpecs(mirror, sha, signal);
    if (links.length === 0) return [];
    const allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map(normalizeAllowedOrigin).filter((value): value is string => Boolean(value)),
    );
    const plan = buildSubmodulePlan(
      links,
      gitmodules,
      this.gitlabUrl.origin,
      { gitlabOrigin: this.gitlabUrl.origin, allowedOrigins, hostTokens: parseSubmoduleHostTokens(options.hostTokens ?? "") },
    );
    const prepared: string[] = [];
    for (const skipped of plan.skipped) options.onNotice?.(skipped.reason, skipped.path);
    for (const item of plan.items) {
      const target = await this.safeSubmodulePath(workspace.path, item.path);
      if (!target) {
        options.onNotice?.("path", item.path);
        continue;
      }
      try {
        const existing = await this.run(target, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal, {
          timeoutMs: 10_000, allowExitCodes: [0, 128],
        });
        if (existing.exitCode === 0 && existing.stdout.toString().trim().toLowerCase() === item.sha.toLowerCase()) {
          prepared.push(item.path);
          continue;
        }
        await mkdir(target, { recursive: true, mode: 0o750 });
        await this.run(target, ["init", "--quiet"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
        const headers = !item.sameOrigin && item.token ? [{ origin: item.origin, token: item.token }] : undefined;
        await this.run(
          target,
          [
            "-c", "protocol.file.allow=never", "-c", "http.followRedirects=false",
            "fetch", "--depth", "1", "--no-tags", item.url, item.sha,
          ],
          undefined, maxErrorOutput, signal,
          { timeoutMs: 60_000, authToken: item.sameOrigin ? authToken : undefined, extraHeaders: headers },
        );
        await this.run(target, ["checkout", "--detach", "FETCH_HEAD"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
        const head = (await this.run(target, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
        if (head.toLowerCase() !== item.sha.toLowerCase()) {
          options.onNotice?.("invalid", item.path);
          continue;
        }
        const size = await this.measureDirectory(target);
        if (size.bytes > maxSubmoduleFetchBytes || size.truncated) {
          await rm(target, { recursive: true, force: true }).catch(() => undefined);
          options.onNotice?.("invalid", item.path);
          continue;
        }
        prepared.push(item.path);
        options.onNotice?.("fetched", item.path);
      } catch (error) {
        if (signal?.aborted) throw error;
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        options.onNotice?.("invalid", item.path);
      }
    }
    return prepared;
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
    submoduleOptions: SubmoduleOptions = {},
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
      const submodules = await this.prepareSubmodules(
        { projectId, workspaceName, path: workspacePath, headSha: expectedSha },
        mirror,
        targetSha,
        submoduleOptions,
        signal,
        authToken,
      );
      await this.touch(workspacePath);
      return { projectId, workspaceName, path: workspacePath, headSha: expectedSha, submodules };
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
   * 轮末自动保存会用占位信息生成提交；用户随后给出明确提交信息时重写该提交的 message，
   * 保证推送到 GitLab 的是实际改动说明。只重写占位提交，tree 与 parent 保持不变。
   */
  private async rewordAutoConversationCommit(
    projectId: number,
    conversationId: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) return undefined;
    const ref = conversationChangesRef(conversationId);
    const current = await this.run(
      mirror,
      ["log", "-1", "--format=%B", ref],
      undefined, maxErrorOutput, signal,
      { timeoutMs: 10_000, allowExitCodes: [0, 128] },
    );
    if (current.exitCode !== 0) return undefined;
    const currentMessage = current.stdout.toString().trim();
    if (!needsCommitMessageRewrite(currentMessage, message)) return undefined;

    const resolved = await this.run(mirror, ["rev-parse", ref], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const sha = resolved.stdout.toString().trim();
    if (!shaPattern.test(sha)) throw new Error("conversation ref contains an invalid commit");
    const treeResult = await this.run(mirror, ["rev-parse", `${sha}^{tree}`], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const tree = treeResult.stdout.toString().trim();
    if (!shaPattern.test(tree)) throw new Error("git rev-parse returned an invalid tree id");
    const parentsResult = await this.run(mirror, ["rev-list", "--parents", "-n", "1", sha], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const parentShas = parentsResult.stdout.toString().trim().split(" ").slice(1);
    const created = await this.run(
      mirror,
      [
        ...commitTreeArgs(this.commitAuthor(conversationId), [
          tree, ...parentShas.flatMap((parent) => ["-p", parent]),
          "-m", withCommitTrailer(message, this.policy().trailer),
        ]),
      ],
      undefined, maxErrorOutput, signal, { timeoutMs: 30_000 },
    );
    const rewritten = created.stdout.toString().trim();
    if (!shaPattern.test(rewritten)) throw new Error("git commit-tree returned an invalid object id");
    await this.run(mirror, ["update-ref", ref, rewritten], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    // 每轮 ref 若指向被重写的占位提交，一并更新，避免按轮查看仍看到旧信息。
    const turnRefs = await this.run(
      mirror,
      ["for-each-ref", "--format=%(refname) %(objectname)", `refs/conversation-turns/${conversationId}`],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
    );
    for (const line of turnRefs.stdout.toString().split("\n")) {
      const [name, object] = line.split(" ");
      if (name && object === sha) {
        await this.run(mirror, ["update-ref", name, rewritten], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
      }
    }
    return rewritten;
  }

  /**
   * 只撤销会话改动中的某一个文件：以该 ref 的父提交为基线重建新提交，
   * 其他文件保持原样，因此 diff 里这个文件不再出现，也不会留下一条反向变更。
   */
  async discardConversationFile(
    workspace: Workspace,
    conversationId: string,
    requestedPath: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; path: string }> {
    this.validateWorkspace(workspace);
    this.validateWorkspaceFilePath(requestedPath);
    const ref = conversationChangesRef(conversationId);
    const mirror = join(this.mirrorRoot, `${workspace.projectId}.git`);
    const resolved = await this.run(
      mirror,
      ["--git-dir", mirror, "rev-parse", "--verify", "--quiet", ref],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
    if (resolved.exitCode !== 0) throw new Error("no conversation changes to discard");
    const oldSha = resolved.stdout.toString().trim();
    if (!shaPattern.test(oldSha)) throw new Error("conversation ref contains an invalid commit");
    const parents = await this.run(
      mirror,
      ["--git-dir", mirror, "rev-list", "--parents", "-n", "1", oldSha],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
    );
    const baseSha = parents.stdout.toString().trim().split(" ")[1];
    if (!shaPattern.test(baseSha ?? "")) throw new Error("cannot resolve the conversation change baseline");

    const inBase = await this.run(
      mirror,
      ["--git-dir", mirror, "ls-tree", "-r", "--name-only", baseSha, "--", requestedPath],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
    );
    if (inBase.stdout.toString("utf8").trim()) {
      await this.run(workspace.path, ["checkout", baseSha, "--", requestedPath], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    } else {
      await this.run(workspace.path, ["rm", "-f", "--", requestedPath], undefined, maxErrorOutput, signal, { timeoutMs: 10_000, allowExitCodes: [0, 1] });
    }
    const treeResult = await this.run(workspace.path, ["write-tree"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const tree = treeResult.stdout.toString().trim();
    if (!shaPattern.test(tree)) throw new Error("git write-tree returned an invalid object id");
    const created = await this.run(
      workspace.path,
      [
        ...commitTreeArgs(this.commitAuthor(conversationId), [
          tree, "-p", baseSha,
          "-m", withCommitTrailer(`discard changes to ${requestedPath}`, this.policy().trailer),
        ]),
      ],
      undefined, maxErrorOutput, signal, { timeoutMs: 30_000 },
    );
    const newSha = created.stdout.toString().trim();
    if (!shaPattern.test(newSha)) throw new Error("git commit-tree returned an invalid object id");
    await this.run(mirror, ["--git-dir", mirror, "update-ref", ref, newSha], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const turnRefs = await this.run(
      mirror,
      ["--git-dir", mirror, "for-each-ref", "--format=%(refname) %(objectname)", `refs/conversation-turns/${conversationId}`],
      undefined, maxErrorOutput, signal, { timeoutMs: 10_000 },
    );
    for (const line of turnRefs.stdout.toString().split("\n")) {
      const [name, object] = line.split(" ");
      if (name && object === oldSha) {
        await this.run(mirror, ["--git-dir", mirror, "update-ref", name, newSha], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
      }
    }
    await this.run(workspace.path, ["checkout", "--detach", newSha], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    return { sha: newSha, path: requestedPath };
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
    const ref = conversationChangesRef(conversationId);
    const mirror = join(this.mirrorRoot, `${workspace.projectId}.git`);
    if (status.clean) {
      // 工作区干净但 HEAD 已因 rebase/merge/cherry-pick 前进时，把会话 ref 同步到 HEAD。
      // 否则下一轮 prepareConversationWorkspace 会按旧 ref 重建 worktree，丢掉这些操作的结果。
      // 只处理 detached HEAD：检出到本地分支时 HEAD 代表分支而不是本会话的工作，不能覆盖 ref。
      const branch = await this.currentBranch(workspace, signal);
      const existing = await this.run(
        mirror,
        ["--git-dir", mirror, "rev-parse", "--verify", "--quiet", ref],
        undefined, maxErrorOutput, signal,
        { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      if (!branch && existing.exitCode === 0 && status.headSha !== existing.stdout.toString().trim()) {
        await this.run(mirror, ["--git-dir", mirror, "update-ref", ref, status.headSha], undefined, maxErrorOutput, signal, {
          timeoutMs: 10_000,
        });
        if (turnId) {
          await this.run(
            mirror,
            ["--git-dir", mirror, "update-ref", conversationTurnRef(conversationId, turnId), status.headSha],
            undefined, maxErrorOutput, signal,
            { timeoutMs: 10_000 },
          );
        }
        return { sha: status.headSha, paths: [] };
      }
      // 工作区已干净但用户随后给出了明确的提交信息：重写轮末占位提交，
      // 让 git_commit / git_publish 真正使用这条信息，而不是推送占位信息。
      if (message?.trim()) {
        const rewritten = await this.rewordAutoConversationCommit(workspace.projectId, conversationId, message, signal);
        if (rewritten) return { sha: rewritten, paths: [] };
      }
      return undefined;
    }
    await this.run(workspace.path, ["add", "-A", "--"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const treeResult = await this.run(workspace.path, ["write-tree"], undefined, maxErrorOutput, signal, { timeoutMs: 10_000 });
    const tree = treeResult.stdout.toString().trim();
    if (!shaPattern.test(tree)) throw new Error("git write-tree returned an invalid object id");
    const commitResult = await this.run(
      workspace.path,
      [
        ...commitTreeArgs(this.commitAuthor(conversationId), [
          tree, "-p", workspace.headSha,
          "-m", withCommitTrailer(
            message?.trim() || `Corvex conversation changes ${conversationId}`, this.policy().trailer,
          ),
        ]),
      ],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 30_000 },
    );
    const sha = commitResult.stdout.toString().trim();
    if (!shaPattern.test(sha)) throw new Error("git commit-tree returned an invalid object id");
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
    // 把 detached HEAD 指向新提交：提交树正是由当前 worktree 生成的，内容不会丢失。
    // 这样 worktree 立即变干净，rebase/merge/cherry-pick 的干净工作区检查才能通过，
    // 也避免下一次 save 对同一批改动重复生成提交。用 checkout --detach 而非 reset --hard，
    // 是为了绝不改写模型可能检出的本地分支。
    await this.run(workspace.path, ["checkout", "--detach", sha], undefined, maxErrorOutput, signal, { timeoutMs: 30_000 });
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
    if (!isValidBranchName(branch)) {
      throw new Error("invalid GitLab branch name");
    }
    if (!authToken) throw new Error("the logged-in user's GitLab token is required");
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

    // 推送前先刷新远端分支指针：否则远程一旦前进就必然非快进失败，而模型没有任何
    // 正规手段把 GitLab 的新提交拉进镜像，只能反复试错。
    await this.syncMirrorFromGitLab(projectId, signal, authToken);
    const remoteRef = `refs/corvex/remote/${branch}`;
    const remoteTipResult = await this.run(
      mirror,
      ["--git-dir", mirror, "rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`],
      undefined, maxErrorOutput, signal,
      { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
    if (remoteTipResult.exitCode === 0) {
      const remoteTip = remoteTipResult.stdout.toString().trim();
      const ancestor = await this.run(
        mirror,
        ["--git-dir", mirror, "merge-base", "--is-ancestor", remoteTip, sha],
        undefined, maxErrorOutput, signal,
        { timeoutMs: 10_000, allowExitCodes: [0, 1] },
      );
      if (ancestor.exitCode !== 0) {
        throw new Error(
          `GitLab branch ${branch} has advanced to ${remoteTip.slice(0, 12)}. ` +
          `Run git_pull to refresh the mirror, then rebase onto origin/${branch} and retry. Never force-push.`,
        );
      }
    }

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

  /**
   * 只删除会话改动 ref，保留轮次 ref 与 worktree。
   * publish 成功后改动已进入 GitLab，不再是「未发布改动」，Changes 视图应回到空状态。
   */
  async clearConversationChangesRef(
    projectId: number,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const mirror = join(this.mirrorRoot, `${projectId}.git`);
    if (!(await this.pathExists(mirror))) return;
    await this.run(
      this.mirrorRoot,
      ["--git-dir", mirror, "update-ref", "-d", conversationChangesRef(conversationId)],
      undefined,
      maxErrorOutput,
      signal,
      { timeoutMs: 10_000, allowExitCodes: [0, 1] },
    );
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
    if (!isValidBranchName(name, 128)) throw new Error("invalid branch name");
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
      // 同时接受 rebase 到 "origin/<branch>"（恢复提示里的写法）和裸分支名。
      target = local.exitCode === 0 ? onto : onto.startsWith("origin/") ? onto : `origin/${onto}`;
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
  async fetchFromMirror(
    workspace: Workspace,
    signal?: AbortSignal,
    authToken?: string,
  ): Promise<{ sha: string; fetched: boolean }> {
    this.validateWorkspace(workspace);
    const before = (await this.run(workspace.path, ["rev-parse", "HEAD"], undefined, maxErrorOutput, signal)).stdout.toString().trim();
    // 镜像以 --mirror 克隆，worktree 继承了 remote.origin.mirror / +refs/*:refs/*，
    // 即使命令行给了显式 refspec，git 仍会尝试更新本地分支并撞上已检出的分支。
    // 直接用镜像路径作为 fetch 源（而非 remote 名）即可绕过远程配置，只写远端跟踪引用。
    const mirror = join(this.mirrorRoot, `${workspace.projectId}.git`);
    // 普通仓库（测试或外部 worktree）没有镜像目录，退回 origin 并只写跟踪引用。
    const source = await this.pathExists(mirror) ? mirror : "origin";
    await this.run(
      workspace.path,
      [
        "fetch", "--no-tags", source,
        "+refs/heads/*:refs/remotes/mirror/*",
        "+refs/corvex/remote/*:refs/remotes/origin/*",
      ],
      undefined, maxErrorOutput, signal,
      { timeoutMs: 30_000, ...(authToken ? { authToken } : {}) },
    );
    return { sha: before, fetched: true };
  }

  /**
   * 从配置的 GitLab 实例刷新项目镜像里的远端分支指针。
   *
   * 镜像是 --mirror 克隆，默认 refspec 会覆盖本地分支；这里把 GitLab 的分支写进独立的
   * refs/corvex/remote/* 命名空间，避免更新任何可能已被 worktree 检出的 refs/heads/*。
   * 随后 fetchFromMirror 会把这些指针映射为 worktree 的 origin/*，模型即可 rebase/合并。
   */
  async syncMirrorFromGitLab(
    projectId: number,
    signal?: AbortSignal,
    authToken?: string,
  ): Promise<{ projectId: number; branches: string[] }> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be positive");
    if (!authToken) throw new Error("the logged-in user's GitLab token is required");
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
    await this.run(
      mirror,
      ["--git-dir", mirror, "fetch", "--quiet", "--no-tags", origin, "+refs/heads/*:refs/corvex/remote/*"],
      undefined, maxErrorOutput, signal,
      { authToken, timeoutMs: 60_000 },
    );
    const refs = await this.run(
      mirror,
      ["--git-dir", mirror, "for-each-ref", "--format=%(refname:short)", "refs/corvex/remote"],
      undefined, maxErrorOutput, signal,
      { timeoutMs: 10_000 },
    );
    return {
      projectId,
      branches: refs.stdout.toString().split("\n")
        .map((line) => line.trim().replace(/^corvex\/remote\//, ""))
        .filter(Boolean),
    };
  }

  /** 把本地分支或完整 SHA 合并进当前 worktree；冲突时直接中止，不留下半合并状态。 */
  async mergeRef(workspace: Workspace, ref: string, signal?: AbortSignal): Promise<{ sha: string; ref: string }> {
    this.validateWorkspace(workspace);
    if (!shaPattern.test(ref)) this.validateBranchName(ref);
    const status = await this.getWorkspaceStatus(workspace, signal);
    if (!status.clean) {
      throw new Error(
        `merge requires a clean worktree; commit or save the pending changes first (${status.files.map((file) => file.path).join(", ")}).`,
      );
    }
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
      throw new Error(
        `Commit ${sha.slice(0, 12)} is not reachable from the pinned revision ${workspace.headSha.slice(0, 12)}. ` +
        "It may come from a merge request diff or a remote branch. Use get_merge_request_changes to read MR file patches, or git_pull then git_merge/git_rebase onto origin/<branch> first.",
      );
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
    const env = this.gitEnvironment(options.authToken ?? "");
    for (const header of options.extraHeaders ?? []) {
      const index = Number(env.GIT_CONFIG_COUNT ?? 0);
      env.GIT_CONFIG_COUNT = String(index + 1);
      env[`GIT_CONFIG_KEY_${index}`] = `http.${header.origin}/.extraHeader`;
      env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Basic ${Buffer.from(`oauth2:${header.token}`).toString("base64")}`;
    }
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
