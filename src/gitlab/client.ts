import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "../guards.js";

export interface MergeRequest {
  iid: number;
  state: string;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  source_project_id?: number;
  target_project_id?: number;
  draft?: boolean;
  web_url?: string;
  sha: string;
  diff_refs: { base_sha: string; start_sha: string; head_sha: string };
}

export interface Project {
  id: number;
  name?: string;
  path_with_namespace?: string;
  /** 项目描述；GitLab 允许为空字符串。Agent 控制台用它作为选择器的第二行。 */
  description?: string;
  http_url_to_repo: string;
  /** GitLab 生成的仓库页面地址，供控制台跳转；旧实例可能仍指向内网地址。 */
  web_url?: string;
  default_branch?: string;
}

/**
 * 用配置的 `gitlab.base_url` 和 GitLab 项目路径派生仓库地址，不信任 GitLab
 * 返回的 `http_url_to_repo` / `web_url`：它们由实例的 external_url 生成，
 * 可能仍指向无法从 Corvex 访问的内网或旧域名。
 */
function projectRepositoryPath(project: Pick<Project, "path_with_namespace">): string {
  const path = (project.path_with_namespace ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (
    !path ||
    path.split("/").some((part) => !part || part === "." || part === ".." || /[\\?#@]/.test(part))
  ) {
    throw new Error("GitLab project path_with_namespace is missing or invalid");
  }
  return path;
}

export function repositoryCloneUrl(baseUrl: string, project: Pick<Project, "path_with_namespace">): string {
  return `${baseUrl.replace(/\/+$/, "")}/${projectRepositoryPath(project)}.git`;
}

export function repositoryWebUrl(baseUrl: string, project: Pick<Project, "path_with_namespace">): string {
  return `${baseUrl.replace(/\/+$/, "")}/${projectRepositoryPath(project)}`;
}

/** 拼接 GitLab 端点时保留实例子路径，不能把 `/api/v4` 挂到域名根。 */
export function gitlabEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** 统一仓库相对路径：去掉首尾斜杠与重复斜杠，拒绝绝对路径和 `..`。 */
export function normalizeRepoPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
  if (!normalized) return "";
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("invalid repository-relative path");
  }
  return parts.join("/");
}

/** 校验并填充 Issue/MR 共用的标签、负责人与里程碑字段。 */
function applyMetadataFields(form: URLSearchParams, fields: GitLabMetadataFields): void {
  if (fields.labels !== undefined) {
    if (!Array.isArray(fields.labels) || fields.labels.length > 20 ||
        fields.labels.some((label) => typeof label !== "string" || !label.trim() || label.length > 100 || /[\r\n]/.test(label))) {
      throw new Error("labels must be at most 20 non-empty single-line strings of 100 characters");
    }
    form.set("labels", fields.labels.join(","));
  }
  if (fields.assigneeIds !== undefined) {
    if (!Array.isArray(fields.assigneeIds) || fields.assigneeIds.length > 10 ||
        fields.assigneeIds.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new Error("assignee_ids must contain at most 10 positive integers");
    }
    form.set("assignee_ids", fields.assigneeIds.join(","));
  }
  if (fields.milestoneId !== undefined) {
    if (!Number.isSafeInteger(fields.milestoneId) || fields.milestoneId <= 0) {
      throw new Error("milestone_id must be a positive integer");
    }
    form.set("milestone_id", String(fields.milestoneId));
  }
}

/** 分支最近一次提交；只有 `id` 是必填，其余字段用于 Agent 控制台展示。 */
export interface GitLabBranchCommit {
  id: string;
  short_id?: string;
  title?: string;
  committed_date?: string;
}

export interface GitLabBranch {
  name: string;
  commit: GitLabBranchCommit;
}

/** 提交详情里只取定位冲突所需的有界字段；其余响应一概忽略。 */
export interface GitLabCommitInfo {
  id: string;
  shortId: string;
  title: string;
  authorName: string;
  committedDate: string;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string;
  state: string;
  web_url?: string;
}

export interface CreatedMergeRequest {
  iid: number;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface MergeRequestComment {
  id: number | string;
  author: string;
  createdAt: string;
  body: string;
  truncated: boolean;
}

export type IssueComment = MergeRequestComment;

/** 合并请求提交记录：只保留展示所需的小字段，避免整段 commit message 撑爆上下文。 */
export interface MergeRequestCommit {
  id: string;
  title: string;
  author: string;
  createdAt: string;
}

/** 一页 MR 提交记录与分页游标。 */
export interface MergeRequestCommitPage {
  commits: MergeRequestCommit[];
  page: number;
  perPage: number;
  hasMore: boolean;
  nextPage: number | null;
}

/** Issue/MR 列表项：只保留定位与展示所需字段，避免整段正文进入上下文。 */
export interface IssueSummary {
  iid: number;
  title: string;
  state: string;
  webUrl?: string;
}

export interface MergeRequestSummary {
  iid: number;
  title: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl?: string;
}

/** MR 变更集：文件路径与补丁文本，按总量截断。 */
export interface MergeRequestChange {
  oldPath: string;
  newPath: string;
  patch: string;
}

export interface MergeRequestChanges {
  changes: MergeRequestChange[];
  /** 因文件数或字节上限被截断；模型据此提示用户缩小范围。 */
  truncated: boolean;
}

export type GitLabListState = "opened" | "closed" | "all";

/** 仓库树条目；GitLab 的 tree 类型映射到统一的 directory/file/other。 */
export interface RepositoryTreeEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
}

export interface RepositoryTreeResult {
  entries: RepositoryTreeEntry[];
  truncated: boolean;
}

/** 文件内容原始响应；解码与截断交给上层适配器。 */
export interface RepositoryFile {
  path: string;
  size: number;
  encoding: string;
  content: string;
}

/** 标签/负责人/里程碑等公共字段，Issue 与 MR 更新都复用。 */
export interface GitLabMetadataFields {
  labels?: string[];
  assigneeIds?: number[];
  milestoneId?: number;
}

export interface MergeRequestMetadataUpdate extends GitLabMetadataFields {
  title?: string;
  description?: string;
  /** 关闭或重新打开合并请求。 */
  stateEvent?: "close" | "reopen";
  squash?: boolean;
}

/** Issue 可更新字段；与 MR 一样只允许显式传入的字段。 */
export interface IssueUpdate extends GitLabMetadataFields {
  title?: string;
  description?: string;
  stateEvent?: "close" | "reopen";
  dueDate?: string;
  confidential?: boolean;
}

export interface IssueCreate extends GitLabMetadataFields {
  title: string;
  description?: string;
  dueDate?: string;
  confidential?: boolean;
}

export interface CreatedIssue {
  iid: number;
  webUrl: string;
}

export interface MergeRequestCreate extends GitLabMetadataFields {
  title: string;
  description?: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
  squash?: boolean;
}

export interface MergeRequestMergeOptions {
  squash?: boolean;
  shouldRemoveSourceBranch?: boolean;
}

/** MR 讨论摘要：只保留定位与状态，正文由 comments 工具读取。 */
export interface MergeRequestDiscussion {
  id: string;
  resolved: boolean;
  body: string;
  author: string;
}

export interface MergeRequestDiscussionList {
  discussions: MergeRequestDiscussion[];
  truncated: boolean;
}

/** GitLab 写操作的最小回执，不包含响应正文。 */
export interface GitLabWriteReceipt {
  /** GitLab 返回的 HTTP 状态码。 */
  status: number;
  /** 从响应正文提取的资源 ID；响应无效或未提供 ID 时为空。 */
  resourceId: number | string | null;
}

/** 写请求未收到 HTTP 回执；远端副作用是否生效无法确认。 */
export class GitLabWriteError extends Error {
  readonly outcomeUnknown = true;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "GitLabWriteError";
  }
}

/** GitLab 返回的非成功 HTTP 响应，保留状态码供上层重试策略判断。 */
export class GitLabApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "GitLabApiError";
  }
}

/** GitLab 单个 API 响应正文的最大读取字节数。 */
const MAX_RESPONSE_BYTES = 20 << 20;
/** 单条历史评论最多保留的字符数，避免超大评论占满模型上下文。 */
const MAX_COMMENT_CHARACTERS = 4_000;
/** Issue 历史评论的总模型上下文预算。 */
const ISSUE_COMMENT_CONTEXT_BUDGET_BYTES = 24 << 10;
/** 历史评论最多扫描的 Notes API 页数。 */
const MAX_COMMENT_PAGES = 10;
const MAX_MR_COMMITS_PER_PAGE = 20;
const MAX_MR_COMMIT_TITLE_CHARACTERS = 300;
/** Issue/MR 列表与变更集都按页限量，避免小窗口模型被大段输出淹没。 */
const MAX_LIST_PER_PAGE = 20;
const MAX_MR_CHANGES = 50;
const MAX_MR_CHANGE_PATCH_BYTES = 256 << 10;
const MAX_REPOSITORY_TREE_ENTRIES = 200;
/** MR 标题和描述工具的输入上限。 */
const MAX_MR_TITLE_CHARACTERS = 255;
const MAX_MR_DESCRIPTION_CHARACTERS = 100_000;
/** 幂等 GET 请求允许的总尝试次数，包含首次请求。 */
const MAX_READ_ATTEMPTS = 3;
/** 仅接受不超过此毫秒数的 Retry-After 延迟，避免请求等待过久。 */
const MAX_RETRY_AFTER_MS = 2_000;
/** GET 请求中视为可能短暂恢复的 HTTP 状态码；POST 不使用此列表重试。 */
const RETRYABLE_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelay(response: Response, attempt: number): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : dateDelay;
    if (Number.isFinite(delay)) {
      return delay <= MAX_RETRY_AFTER_MS ? Math.max(0, delay) : undefined;
    }
  }
  return Math.min(1_000, 100 * 2 ** attempt);
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal) await sleep(delayMs, undefined, { signal });
  else await sleep(delayMs);
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  // 按实际读取字节数限流，不依赖可能缺失或不准确的 Content-Length。
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`response exceeds ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function fullSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

/**
 * 从 GitLab 对象里取出可选文本字段：非字符串、空白或超长时返回 undefined，
 * 避免把异常数据透传到 Agent 控制台。
 */
function optionalString(source: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

export class GitLabClient {
  private baseUrl: string;
  /** 当前登录用户的 OAuth access token；所有 GitLab 请求都必须带上它。 */
  private token: string;

  constructor(baseUrl: string, token: string, private readonly requestTimeoutMs = 10_000) {
    if (requestTimeoutMs <= 0) throw new Error("GitLab request timeout must be positive");
    this.baseUrl = "";
    this.token = "";
    this.configure(baseUrl, token);
  }

  /** 当前登录用户的令牌，供 GitManager 的 clone/fetch/push 使用。 */
  get authToken(): string {
    return this.token;
  }

  /** 运维台修改 GitLab 地址后立即生效；下一次请求使用新地址。 */
  configure(baseUrl: string, token: string): void {
    if (!baseUrl.trim()) {
      // 地址可以在运维台设置：启动时尚未配置时保留空值，调用 API 会给出明确错误。
      this.baseUrl = "";
      this.token = token;
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch (error) {
      throw new Error(`invalid GitLab base URL "${baseUrl}"`, { cause: error });
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(`invalid GitLab base URL "${baseUrl}"`);
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  /** 所有 GitLab 请求都要求先配置根地址。 */
  private requireBaseUrl(): string {
    if (!this.baseUrl) throw new Error("GitLab base URL is not configured");
    return this.baseUrl;
  }

  async getMergeRequest(projectId: number, mrIid: number, signal?: AbortSignal): Promise<MergeRequest> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    const result = await this.getJson(
      `/projects/${projectId}/merge_requests/${mrIid}`,
      signal,
    );
    if (!isRecord(result) || result.iid !== mrIid || !isRecord(result.diff_refs)) {
      throw new Error("GitLab returned a merge request with a mismatched IID");
    }
    return result as unknown as MergeRequest;
  }

  async getIssue(projectId: number, issueIid: number, signal?: AbortSignal): Promise<GitLabIssue> {
    if (projectId <= 0 || issueIid <= 0) throw new Error("project ID and issue IID must be positive");
    const result = await this.getJson(`/projects/${projectId}/issues/${issueIid}`, signal);
    if (
      !isRecord(result) ||
      result.iid !== issueIid ||
      typeof result.title !== "string" ||
      typeof result.description !== "string" ||
      typeof result.state !== "string"
    ) {
      throw new Error("GitLab returned incomplete or mismatched Issue metadata");
    }
    return result as unknown as GitLabIssue;
  }

  /**
   * 分页列出当前项目的 Issue。只返回摘要字段；state 支持 opened/closed/all。
   * 调用方必须按页获取，不能一次性拼接全部历史。
   */
  async listIssues(
    projectId: number,
    options: { search?: string; state?: GitLabListState; page?: number; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<IssueSummary[]> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const page = options.page ?? 1;
    const perPage = options.perPage ?? MAX_LIST_PER_PAGE;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      throw new Error("issue page must be between 1 and 10000");
    }
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_LIST_PER_PAGE) {
      throw new Error(`issue page size must be between 1 and ${MAX_LIST_PER_PAGE}`);
    }
    const query = new URLSearchParams({ per_page: String(perPage), page: String(page), order_by: "updated_at", sort: "desc" });
    const state = options.state ?? "opened";
    query.set("state", state);
    const search = (options.search ?? "").trim();
    if (search) {
      if ([...search].length > 100) throw new Error("issue search must be at most 100 characters");
      query.set("search", search);
    }
    const result = await this.getJson(`/projects/${projectId}/issues?${query}`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab issue list is not an array");
    return result.map((value) => {
      if (!isRecord(value) || !Number.isSafeInteger(value.iid) || typeof value.title !== "string" || typeof value.state !== "string") {
        throw new Error("GitLab returned an incomplete issue list entry");
      }
      const webUrl = typeof value.web_url === "string" ? value.web_url : undefined;
      return {
        iid: value.iid as number,
        title: value.title.slice(0, MAX_MR_TITLE_CHARACTERS),
        state: value.state,
        ...(webUrl ? { webUrl } : {}),
      };
    });
  }

  /** 分页列出当前项目的 MR，返回摘要字段。 */
  async listMergeRequests(
    projectId: number,
    options: { search?: string; state?: GitLabListState; page?: number; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<MergeRequestSummary[]> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const page = options.page ?? 1;
    const perPage = options.perPage ?? MAX_LIST_PER_PAGE;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      throw new Error("merge request page must be between 1 and 10000");
    }
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_LIST_PER_PAGE) {
      throw new Error(`merge request page size must be between 1 and ${MAX_LIST_PER_PAGE}`);
    }
    const query = new URLSearchParams({ per_page: String(perPage), page: String(page), order_by: "updated_at", sort: "desc" });
    const state = options.state ?? "opened";
    query.set("state", state);
    const search = (options.search ?? "").trim();
    if (search) {
      if ([...search].length > 100) throw new Error("merge request search must be at most 100 characters");
      query.set("search", search);
    }
    const result = await this.getJson(`/projects/${projectId}/merge_requests?${query}`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab merge request list is not an array");
    return result.map((value) => {
      if (
        !isRecord(value) || !Number.isSafeInteger(value.iid) || typeof value.title !== "string" ||
        typeof value.state !== "string" || typeof value.source_branch !== "string" || typeof value.target_branch !== "string"
      ) {
        throw new Error("GitLab returned an incomplete merge request list entry");
      }
      const webUrl = typeof value.web_url === "string" ? value.web_url : undefined;
      return {
        iid: value.iid as number,
        title: value.title.slice(0, MAX_MR_TITLE_CHARACTERS),
        state: value.state,
        sourceBranch: value.source_branch.slice(0, 255),
        targetBranch: value.target_branch.slice(0, 255),
        ...(webUrl ? { webUrl } : {}),
      };
    });
  }

  /**
   * 读取 MR 的逐文件变更。按文件数与补丁总字节双重截断，
   * 让模型先看关键改动；完整 diff 仍需从固定快照的 worktree 读取。
   */
  async getMergeRequestChanges(projectId: number, mrIid: number, signal?: AbortSignal): Promise<MergeRequestChanges> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    const result = await this.getJson(`/projects/${projectId}/merge_requests/${mrIid}/changes`, signal);
    if (!isRecord(result) || !Array.isArray(result.changes)) {
      throw new Error("GitLab returned invalid merge request changes");
    }
    const changes: MergeRequestChange[] = [];
    let bytes = 0;
    let truncated = false;
    for (const entry of result.changes) {
      if (!isRecord(entry)) throw new Error("GitLab returned an invalid merge request change");
      const oldPath = typeof entry.old_path === "string" ? entry.old_path : "";
      const newPath = typeof entry.new_path === "string" ? entry.new_path : "";
      const patch = typeof entry.patch === "string" ? entry.patch : "";
      if (!oldPath && !newPath) throw new Error("GitLab returned a change without a path");
      const patchBytes = Buffer.byteLength(patch);
      if (changes.length >= MAX_MR_CHANGES || bytes + patchBytes > MAX_MR_CHANGE_PATCH_BYTES) {
        truncated = true;
        break;
      }
      changes.push({ oldPath, newPath, patch });
      bytes += patchBytes;
    }
    return { changes, truncated };
  }

  /**
   * 读取某个固定提交下的一层仓库树。按条目数截断，避免大目录把上下文撑爆；
   * 调用方负责继续翻页或提示用户缩小范围。
   */
  async listRepositoryTree(
    projectId: number,
    options: { path?: string; ref?: string; page?: number; perPage?: number } = {},
    signal?: AbortSignal,
  ): Promise<RepositoryTreeResult> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const page = options.page ?? 1;
    const perPage = options.perPage ?? MAX_REPOSITORY_TREE_ENTRIES;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      throw new Error("repository tree page must be between 1 and 10000");
    }
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_REPOSITORY_TREE_ENTRIES) {
      throw new Error(`repository tree page size must be between 1 and ${MAX_REPOSITORY_TREE_ENTRIES}`);
    }
    const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    const ref = (options.ref ?? "").trim();
    if (ref) query.set("ref", ref);
    const path = normalizeRepoPath(options.path ?? "");
    if (path) query.set("path", path);
    const result = await this.getJson(`/projects/${projectId}/repository/tree?${query}`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab repository tree is not an array");
    const entries: RepositoryTreeEntry[] = result.map((value) => {
      if (!isRecord(value) || typeof value.name !== "string" || typeof value.path !== "string" || typeof value.type !== "string") {
        throw new Error("GitLab returned an incomplete repository tree entry");
      }
      const type = value.type === "tree" ? "directory" : value.type === "blob" ? "file" : value.type === "commit" ? "other" : "other";
      return { name: value.name, path: normalizeRepoPath(value.path), type };
    });
    return { entries, truncated: entries.length >= perPage };
  }

  /** 读取固定提交下的文件内容（原始编码）；解码、按行截断由适配器处理。 */
  async getRepositoryFile(
    projectId: number,
    path: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<RepositoryFile> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const normalized = normalizeRepoPath(path);
    if (!normalized) throw new Error("repository file path is required");
    if (!ref.trim()) throw new Error("repository file ref is required");
    const query = new URLSearchParams({ ref });
    const result = await this.getJson(
      `/projects/${projectId}/repository/files/${encodeURIComponent(normalized)}?${query}`,
      signal,
    );
    if (
      !isRecord(result) ||
      typeof result.content !== "string" ||
      (typeof result.size !== "number" && typeof result.size !== "undefined")
    ) {
      throw new Error("GitLab returned an incomplete repository file");
    }
    return {
      path: normalized,
      size: typeof result.size === "number" ? result.size : 0,
      encoding: typeof result.encoding === "string" ? result.encoding : "base64",
      content: result.content,
    };
  }

  async getProject(projectId: number, signal?: AbortSignal): Promise<Project> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const result = await this.getJson(`/projects/${projectId}`, signal);
    if (
      !isRecord(result) ||
      result.id !== projectId ||
      typeof result.http_url_to_repo !== "string" ||
      !result.http_url_to_repo
    ) {
      throw new Error("GitLab returned incomplete or mismatched project metadata");
    }
    return result as unknown as Project;
  }

  async listProjects(search: string, page: number, signal?: AbortSignal): Promise<Project[]> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      throw new Error("GitLab project page must be between 1 and 10000");
    }
    const query = new URLSearchParams({
      per_page: "50",
      page: String(page),
      order_by: "name",
      sort: "asc",
    });
    const normalizedSearch = search.trim();
    if (normalizedSearch) {
      if ([...normalizedSearch].length > 100) throw new Error("GitLab project search must be at most 100 characters");
      query.set("search", normalizedSearch);
    }
    const result = await this.getJson(`/projects?${query}`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab project list is not an array");
    return result.map((value) => {
      if (
        !isRecord(value) ||
        !Number.isSafeInteger(value.id) ||
        typeof value.name !== "string" ||
        typeof value.path_with_namespace !== "string" ||
        typeof value.http_url_to_repo !== "string" ||
        !value.http_url_to_repo ||
        (value.default_branch !== undefined && typeof value.default_branch !== "string")
      ) {
        throw new Error("GitLab returned an incomplete project list entry");
      }
      return value as unknown as Project;
    });
  }

  async getBranch(projectId: number, branchName: string, signal?: AbortSignal): Promise<GitLabBranch> {
    if (projectId <= 0 || !branchName.trim() || [...branchName].length > 255) {
      throw new Error("project ID and branch name are required");
    }
    const result = await this.getJson(
      `/projects/${projectId}/repository/branches/${encodeURIComponent(branchName)}`,
      signal,
    );
    if (
      !isRecord(result) ||
      result.name !== branchName ||
      !isRecord(result.commit) ||
      typeof result.commit.id !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(result.commit.id)
    ) {
      throw new Error("GitLab returned an invalid branch or commit SHA");
    }
    return result as unknown as GitLabBranch;
  }

  /**
   * 读取提交的作者与标题，用于解释「谁把分支推进了」。
   * 这是只读调用；失败时调用方应回退到分支接口自带的标题，不能因此改变轮次结果。
   */
  async getCommit(projectId: number, sha: string, signal?: AbortSignal): Promise<GitLabCommitInfo> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) throw new Error("commit lookup requires a full SHA");
    const result = await this.getJson(`/projects/${projectId}/repository/commits/${sha}`, signal);
    if (!isRecord(result) || typeof result.id !== "string") {
      throw new Error("GitLab returned an invalid commit");
    }
    const bounded = (value: unknown, max: number) =>
      typeof value === "string" ? value.slice(0, max) : "";
    return {
      id: result.id,
      shortId: bounded(result.short_id, 16),
      title: bounded(result.title, 500),
      authorName: bounded(result.author_name, 200),
      committedDate: bounded(result.committed_date, 40),
    };
  }

  async listBranches(projectId: number, search: string, page: number, signal?: AbortSignal): Promise<GitLabBranch[]> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const query = this.pagedSearchQuery(search, page);
    const result = await this.getJson(`/projects/${projectId}/repository/branches?${query}`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab branch list is not an array");
    return result.map((value) => {
      if (
        !isRecord(value) || typeof value.name !== "string" || !isRecord(value.commit) ||
        typeof value.commit.id !== "string" || !fullSha(value.commit.id)
      ) throw new Error("GitLab returned an invalid branch list entry");
      // 只保留 Agent 控制台需要的提交元数据；非字符串、空白或超长的值一律丢弃。
      const shortId = optionalString(value.commit, "short_id", 64);
      const title = optionalString(value.commit, "title", 4096);
      const committedDate = optionalString(value.commit, "committed_date", 64);
      return {
        name: value.name,
        commit: {
          id: value.commit.id,
          ...(shortId ? { short_id: shortId } : {}),
          ...(title ? { title } : {}),
          ...(committedDate ? { committed_date: committedDate } : {}),
        },
      };
    });
  }

  private pagedSearchQuery(search: string, page: number): URLSearchParams {
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      throw new Error("GitLab target page must be between 1 and 10000");
    }
    const query = new URLSearchParams({ per_page: "50", page: String(page) });
    const normalizedSearch = search.trim();
    if (normalizedSearch) {
      if ([...normalizedSearch].length > 100) throw new Error("GitLab target search must be at most 100 characters");
      query.set("search", normalizedSearch);
    }
    return query;
  }

  async getMergeRequestComments(
    projectId: number,
    mrIid: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestComment[]> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("merge request comment limit must be between 1 and 50");
    }
    const comments: MergeRequestComment[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const query = new URLSearchParams({
        order_by: "created_at",
        sort: "desc",
        per_page: "100",
        page: String(page),
      });
      const response = await this.request(
        `/projects/${projectId}/merge_requests/${mrIid}/notes?${query}`,
        this.token,
        "GET",
        signal,
      );
      const body = await this.successBody(response);
      let pageNotes: unknown;
      try {
        pageNotes = JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        throw new Error(`decode GitLab API response: ${String(error)}`, { cause: error });
      }
      if (!Array.isArray(pageNotes)) throw new Error("GitLab merge request notes response is not an array");
      for (const note of pageNotes) {
        if (!isRecord(note)) throw new Error("GitLab returned an invalid merge request note");
        if (note.system === true) continue;
        const noteId = typeof note.id === "number" && Number.isSafeInteger(note.id)
          ? note.id
          : typeof note.id === "string" ? note.id : undefined;
        if (
          noteId === undefined ||
          typeof note.body !== "string" ||
          typeof note.created_at !== "string" ||
          !isRecord(note.author) ||
          typeof note.author.username !== "string"
        ) {
          throw new Error("GitLab returned an incomplete merge request note");
        }
        const characters = [...note.body];
        comments.push({
          id: noteId,
          author: note.author.username.slice(0, 128),
          createdAt: note.created_at.slice(0, 64),
          body: characters.slice(0, MAX_COMMENT_CHARACTERS).join(""),
          truncated: characters.length > MAX_COMMENT_CHARACTERS,
        });
        if (comments.length >= limit) return comments;
      }
      const next = response.headers.get("x-next-page") ?? "";
      if (!next && pageNotes.length < 100) return comments;
      if (next && Number(next) !== page + 1) {
        throw new Error(`GitLab returned invalid notes pagination cursor "${next}"`);
      }
    }
    throw new Error("merge request comments exceed the 10-page safety limit");
  }

  /**
   * 分页读取 MR 提交记录。调用方必须按页获取，永远不一次性拼接全部历史；
   * 标题被截断，单页最多 20 条，避免小窗口模型被提交历史淹没。
   */
  async getMergeRequestCommits(
    projectId: number,
    mrIid: number,
    page = 1,
    perPage = 10,
    signal?: AbortSignal,
  ): Promise<MergeRequestCommitPage> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("commit page must be a positive integer");
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_MR_COMMITS_PER_PAGE) {
      throw new Error(`commit page size must be between 1 and ${MAX_MR_COMMITS_PER_PAGE}`);
    }
    const query = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    const response = await this.request(
      `/projects/${projectId}/merge_requests/${mrIid}/commits?${query}`,
      this.token,
      "GET",
      signal,
    );
    const body = await this.successBody(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch (error) {
      throw new Error(`decode GitLab API response: ${String(error)}`, { cause: error });
    }
    if (!Array.isArray(parsed)) throw new Error("GitLab merge request commits response is not an array");
    const commits: MergeRequestCommit[] = parsed.map((entry) => {
      if (!isRecord(entry)) throw new Error("GitLab returned an invalid merge request commit");
      const id = typeof entry.id === "string" ? entry.id : "";
      const title = typeof entry.title === "string" ? entry.title : "";
      if (!id || !title) throw new Error("GitLab returned an incomplete merge request commit");
      const author = isRecord(entry.author) && typeof entry.author.name === "string"
        ? entry.author.name
        : typeof entry.author_name === "string" ? entry.author_name : "";
      const createdAt = typeof entry.created_at === "string" ? entry.created_at : "";
      const characters = [...title];
      return {
        id: id.slice(0, 40),
        title: characters.slice(0, MAX_MR_COMMIT_TITLE_CHARACTERS).join(""),
        author: author.slice(0, 128),
        createdAt: createdAt.slice(0, 64),
      };
    });
    const nextHeader = response.headers.get("x-next-page") ?? "";
    const next = nextHeader ? Number(nextHeader) : Number.NaN;
    if (nextHeader && (!Number.isSafeInteger(next) || next !== page + 1)) {
      throw new Error("GitLab returned an invalid commits pagination cursor");
    }
    return {
      commits,
      page,
      perPage,
      hasMore: Boolean(nextHeader),
      nextPage: nextHeader ? next : null,
    };
  }

  async getIssueComments(
    projectId: number,
    issueIid: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<IssueComment[]> {
    if (projectId <= 0 || issueIid <= 0) throw new Error("project ID and issue IID must be positive");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Issue comment limit must be between 1 and 50");
    }
    const comments: IssueComment[] = [];
    let totalBytes = 0;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const query = new URLSearchParams({
        order_by: "created_at",
        sort: "desc",
        per_page: "100",
        page: String(page),
      });
      const response = await this.request(
        `/projects/${projectId}/issues/${issueIid}/notes?${query}`,
        this.token,
        "GET",
        signal,
      );
      const body = await this.successBody(response);
      let pageNotes: unknown;
      try {
        pageNotes = JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        throw new Error(`decode GitLab API response: ${String(error)}`, { cause: error });
      }
      if (!Array.isArray(pageNotes)) throw new Error("GitLab Issue notes response is not an array");
      for (const note of pageNotes) {
        if (!isRecord(note)) throw new Error("GitLab returned an invalid Issue note");
        if (note.system === true) continue;
        const noteId = typeof note.id === "number" && Number.isSafeInteger(note.id)
          ? note.id
          : typeof note.id === "string" ? note.id : undefined;
        if (
          noteId === undefined ||
          typeof note.body !== "string" ||
          typeof note.created_at !== "string" ||
          !isRecord(note.author) ||
          typeof note.author.username !== "string"
        ) {
          throw new Error("GitLab returned an incomplete Issue note");
        }
        let bodyText = "";
        let characters = 0;
        let commentBytes = 0;
        let truncated = false;
        const availableBytes = ISSUE_COMMENT_CONTEXT_BUDGET_BYTES - totalBytes;
        for (const character of note.body) {
          const bytes = Buffer.byteLength(character);
          if (characters >= MAX_COMMENT_CHARACTERS || commentBytes + bytes > availableBytes) {
            truncated = true;
            break;
          }
          bodyText += character;
          characters++;
          commentBytes += bytes;
        }
        comments.push({
          id: noteId,
          author: note.author.username.slice(0, 128),
          createdAt: note.created_at.slice(0, 64),
          body: bodyText,
          truncated,
        });
        totalBytes += commentBytes;
        if (comments.length >= limit || totalBytes >= ISSUE_COMMENT_CONTEXT_BUDGET_BYTES) return comments;
      }
      const next = response.headers.get("x-next-page") ?? "";
      if (!next && pageNotes.length < 100) return comments;
      if (next && Number(next) !== page + 1) {
        throw new Error(`GitLab returned invalid Issue notes pagination cursor "${next}"`);
      }
    }
    throw new Error("Issue comments exceed the 10-page safety limit");
  }

  async postNote(
    projectId: number,
    mrIid: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    const form = new URLSearchParams({ body });
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/notes`, form, signal);
  }

  async postIssueNote(
    projectId: number,
    issueIid: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(issueIid) || issueIid <= 0) {
      throw new Error("project ID and issue IID must be positive safe integers");
    }
    return this.write(`/projects/${projectId}/issues/${issueIid}/notes`, new URLSearchParams({ body }), signal);
  }

  async updateMergeRequest(
    projectId: number,
    mrIid: number,
    update: MergeRequestMetadataUpdate,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(mrIid) || mrIid <= 0) {
      throw new Error("project ID and MR IID must be positive safe integers");
    }
    if (
      update.title === undefined && update.description === undefined && update.stateEvent === undefined &&
      update.labels === undefined && update.assigneeIds === undefined && update.milestoneId === undefined &&
      update.squash === undefined
    ) {
      throw new Error("at least one merge request field must be provided");
    }
    if (update.title !== undefined && (!update.title.trim() || [...update.title].length > MAX_MR_TITLE_CHARACTERS)) {
      throw new Error(`merge request title must contain 1-${MAX_MR_TITLE_CHARACTERS} characters`);
    }
    if (update.description !== undefined && [...update.description].length > MAX_MR_DESCRIPTION_CHARACTERS) {
      throw new Error(`merge request description must not exceed ${MAX_MR_DESCRIPTION_CHARACTERS} characters`);
    }
    const form = new URLSearchParams();
    if (update.title !== undefined) {
      const current = await this.getMergeRequest(projectId, mrIid, signal);
      let title = update.title;
      if (current.draft) {
        const draftMarker = /^(\s*(?:\[draft\]|draft:|wip:)\s*)/i;
        const existingMarker = current.title.match(draftMarker)?.[1] ?? "Draft: ";
        if (!draftMarker.test(title)) title = `${existingMarker}${title}`;
        if ([...title].length > MAX_MR_TITLE_CHARACTERS) {
          throw new Error(`draft merge request title must not exceed ${MAX_MR_TITLE_CHARACTERS} characters`);
        }
      }
      form.set("title", title);
    }
    if (update.description !== undefined) form.set("description", update.description);
    if (update.stateEvent !== undefined) form.set("state_event", update.stateEvent);
    if (update.squash !== undefined) form.set("squash", String(update.squash));
    applyMetadataFields(form, update);
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}`, form, signal, "PUT");
  }

  /** 更新 Issue 的标题、详情或状态；只提交显式传入的字段。 */
  async updateIssue(
    projectId: number,
    issueIid: number,
    update: IssueUpdate,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(issueIid) || issueIid <= 0) {
      throw new Error("project ID and issue IID must be positive safe integers");
    }
    if (
      update.title === undefined && update.description === undefined && update.stateEvent === undefined &&
      update.labels === undefined && update.assigneeIds === undefined && update.milestoneId === undefined &&
      update.dueDate === undefined && update.confidential === undefined
    ) {
      throw new Error("at least one issue field must be provided");
    }
    if (update.title !== undefined && (!update.title.trim() || [...update.title].length > MAX_MR_TITLE_CHARACTERS)) {
      throw new Error(`issue title must contain 1-${MAX_MR_TITLE_CHARACTERS} characters`);
    }
    if (update.description !== undefined && [...update.description].length > MAX_MR_DESCRIPTION_CHARACTERS) {
      throw new Error(`issue description must not exceed ${MAX_MR_DESCRIPTION_CHARACTERS} characters`);
    }
    const form = new URLSearchParams();
    if (update.title !== undefined) form.set("title", update.title);
    if (update.description !== undefined) form.set("description", update.description);
    if (update.stateEvent !== undefined) form.set("state_event", update.stateEvent);
    if (update.dueDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(update.dueDate)) throw new Error("issue due_date must be YYYY-MM-DD");
      form.set("due_date", update.dueDate);
    }
    if (update.confidential !== undefined) form.set("confidential", String(update.confidential));
    applyMetadataFields(form, update);
    return this.write(`/projects/${projectId}/issues/${issueIid}`, form, signal, "PUT");
  }

  /** 创建资源并解析 iid/web_url；写入结果不确定时抛 GitLabWriteError。 */
  private async createResource(
    path: string,
    form: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<CreatedIssue> {
    let response: Response;
    try {
      response = await this.request(path, this.token, "POST", signal, form);
    } catch (error) {
      throw new GitLabWriteError(`GitLab resource creation outcome is unknown: ${String(error)}`, error);
    }
    if (!response.ok) await this.throwResponseError(response);
    const body = await this.successBody(response);
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder().decode(body));
    } catch (error) {
      throw new Error(`decode created resource response: ${String(error)}`, { cause: error });
    }
    if (!isRecord(result) || !Number.isSafeInteger(result.iid) || typeof result.web_url !== "string") {
      throw new Error("GitLab returned incomplete created resource metadata");
    }
    return { iid: result.iid as number, webUrl: result.web_url };
  }

  private validateCreateInput(title: string, description?: string): void {
    if (!title.trim() || [...title].length > MAX_MR_TITLE_CHARACTERS) {
      throw new Error(`title must contain 1-${MAX_MR_TITLE_CHARACTERS} characters`);
    }
    if (description !== undefined && [...description].length > MAX_MR_DESCRIPTION_CHARACTERS) {
      throw new Error(`description must not exceed ${MAX_MR_DESCRIPTION_CHARACTERS} characters`);
    }
  }

  async createIssue(
    projectId: number,
    input: IssueCreate,
    signal?: AbortSignal,
  ): Promise<CreatedIssue> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be a positive safe integer");
    this.validateCreateInput(input.title, input.description);
    if (input.dueDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
      throw new Error("issue due_date must be YYYY-MM-DD");
    }
    const form = new URLSearchParams({ title: input.title.trim() });
    if (input.description !== undefined) form.set("description", input.description);
    if (input.dueDate !== undefined) form.set("due_date", input.dueDate);
    if (input.confidential !== undefined) form.set("confidential", String(input.confidential));
    applyMetadataFields(form, input);
    return this.createResource(`/projects/${projectId}/issues`, form, signal);
  }

  async deleteIssue(projectId: number, issueIid: number, signal?: AbortSignal): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || issueIid <= 0) throw new Error("project ID and issue IID must be positive");
    return this.write(`/projects/${projectId}/issues/${issueIid}`, new URLSearchParams(), signal, "DELETE");
  }

  async updateIssueNote(
    projectId: number,
    issueIid: number,
    noteId: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || issueIid <= 0 || noteId <= 0) throw new Error("project ID, issue IID and note ID must be positive");
    if (!body.trim() || [...body].length > MAX_COMMENT_CHARACTERS) {
      throw new Error(`comment body must contain 1-${MAX_COMMENT_CHARACTERS} characters`);
    }
    return this.write(`/projects/${projectId}/issues/${issueIid}/notes/${noteId}`, new URLSearchParams({ body }), signal, "PUT");
  }

  async deleteIssueNote(
    projectId: number,
    issueIid: number,
    noteId: number,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || issueIid <= 0 || noteId <= 0) throw new Error("project ID, issue IID and note ID must be positive");
    return this.write(`/projects/${projectId}/issues/${issueIid}/notes/${noteId}`, new URLSearchParams(), signal, "DELETE");
  }

  async createMergeRequest(
    projectId: number,
    input: MergeRequestCreate,
    signal?: AbortSignal,
  ): Promise<CreatedMergeRequest> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be a positive safe integer");
    const title = input.draft ? `Draft: ${input.title.trim()}` : input.title.trim();
    this.validateCreateInput(title, input.description);
    for (const [label, branch] of [["source", input.sourceBranch], ["target", input.targetBranch]] as const) {
      if (!branch.trim() || branch.length > 255 || branch.startsWith("-") || branch.includes("\0")) {
        throw new Error(`merge request ${label} branch is invalid`);
      }
    }
    const form = new URLSearchParams({
      title,
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
    });
    if (input.description !== undefined) form.set("description", input.description);
    if (input.squash !== undefined) form.set("squash", String(input.squash));
    applyMetadataFields(form, input);
    const created = await this.createResource(`/projects/${projectId}/merge_requests`, form, signal);
    return { ...created, sourceBranch: input.sourceBranch, targetBranch: input.targetBranch };
  }

  async deleteMergeRequest(projectId: number, mrIid: number, signal?: AbortSignal): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}`, new URLSearchParams(), signal, "DELETE");
  }

  async mergeMergeRequest(
    projectId: number,
    mrIid: number,
    options: MergeRequestMergeOptions,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    const form = new URLSearchParams();
    if (options.squash !== undefined) form.set("squash", String(options.squash));
    if (options.shouldRemoveSourceBranch !== undefined) {
      form.set("should_remove_source_branch", String(options.shouldRemoveSourceBranch));
    }
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/merge`, form, signal, "PUT");
  }

  async approveMergeRequest(projectId: number, mrIid: number, signal?: AbortSignal): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/approve`, new URLSearchParams(), signal);
  }

  async unapproveMergeRequest(projectId: number, mrIid: number, signal?: AbortSignal): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/unapprove`, new URLSearchParams(), signal);
  }

  async updateMergeRequestNote(
    projectId: number,
    mrIid: number,
    noteId: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0 || noteId <= 0) throw new Error("project ID, MR IID and note ID must be positive");
    if (!body.trim() || [...body].length > MAX_COMMENT_CHARACTERS) {
      throw new Error(`comment body must contain 1-${MAX_COMMENT_CHARACTERS} characters`);
    }
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`, new URLSearchParams({ body }), signal, "PUT");
  }

  async deleteMergeRequestNote(
    projectId: number,
    mrIid: number,
    noteId: number,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0 || noteId <= 0) throw new Error("project ID, MR IID and note ID must be positive");
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}`, new URLSearchParams(), signal, "DELETE");
  }

  async listMergeRequestDiscussions(
    projectId: number,
    mrIid: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestDiscussionList> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    const result = await this.getJson(`/projects/${projectId}/merge_requests/${mrIid}/discussions?per_page=50`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab discussions response is not an array");
    const discussions: MergeRequestDiscussion[] = [];
    for (const entry of result.slice(0, 50)) {
      if (!isRecord(entry) || typeof entry.id !== "string") throw new Error("GitLab returned an invalid discussion");
      const notes = Array.isArray(entry.notes) ? entry.notes : [];
      const first = notes[0];
      discussions.push({
        id: entry.id,
        resolved: entry.resolved === true,
        body: isRecord(first) && typeof first.body === "string" ? first.body : "",
        author: isRecord(first) && isRecord(first.author) && typeof first.author.username === "string"
          ? first.author.username : "",
      });
    }
    return { discussions, truncated: result.length > 50 };
  }

  async resolveDiscussion(
    projectId: number,
    mrIid: number,
    discussionId: string,
    resolve: boolean,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0 || !discussionId.trim()) {
      throw new Error("project ID, MR IID and discussion ID are required");
    }
    const endpoint = resolve ? "resolve" : "unresolve";
    return this.write(
      `/projects/${projectId}/merge_requests/${mrIid}/discussions/${encodeURIComponent(discussionId)}/${endpoint}`,
      new URLSearchParams(),
      signal,
    );
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, this.token, "GET", signal);
    const body = await this.successBody(response);
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch (error) {
      throw new Error(`decode GitLab API response: ${String(error)}`, { cause: error });
    }
  }

  private async write(
    path: string,
    form: URLSearchParams,
    signal?: AbortSignal,
    method: "POST" | "PUT" | "DELETE" = "POST",
  ): Promise<GitLabWriteReceipt> {
    let response: Response;
    try {
      response = await this.request(path, this.token, method, signal, form);
    } catch (error) {
      throw new GitLabWriteError(`GitLab write outcome is unknown: ${String(error)}`, error);
    }
    if (!response.ok) await this.throwResponseError(response);
    let resourceId: number | string | null = null;
    try {
      const body = await readBounded(response, 16 << 10);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      if (isRecord(parsed) && (typeof parsed.id === "string" || Number.isSafeInteger(parsed.id))) {
        resourceId = parsed.id as number | string;
      }
    } catch {
      await response.body?.cancel().catch(() => {});
    }
    return { status: response.status, resourceId };
  }

  private async request(
    path: string,
    token: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    signal?: AbortSignal,
    form?: URLSearchParams,
  ): Promise<Response> {
    if (!token) throw new Error("GitLab API token is required for this request");
    const baseUrl = this.requireBaseUrl();
    const maxAttempts = method === "GET" ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)])
        : AbortSignal.timeout(this.requestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/api/v4${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
          body: form,
          signal: requestSignal,
        });
      } catch (error) {
        if (method !== "GET" || attempt + 1 >= maxAttempts || signal?.aborted) {
          throw new Error(`send GitLab API request: ${String(error)}`, { cause: error });
        }
        await waitForRetry(Math.min(1_000, 100 * 2 ** attempt), signal);
        continue;
      }
      if (
        method === "GET" &&
        attempt + 1 < maxAttempts &&
        RETRYABLE_READ_STATUSES.has(response.status) &&
        !signal?.aborted
      ) {
        const delay = retryDelay(response, attempt);
        if (delay !== undefined) {
          await response.body?.cancel().catch(() => {});
          await waitForRetry(delay, signal);
          continue;
        }
      }
      return response;
    }
    throw new Error("GitLab API request exhausted its retry attempts");
  }

  private async successBody(response: Response): Promise<Uint8Array> {
    if (!response.ok) return this.throwResponseError(response);
    try {
      return await readBounded(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw new Error(`read GitLab API response: ${String(error)}`, { cause: error });
    }
  }

  private async throwResponseError(response: Response): Promise<never> {
    let body: string;
    try {
      body = new TextDecoder().decode(await readBounded(response, 4 << 10)).trim();
    } catch (error) {
      body = `unable to read error response: ${String(error)}`;
    }
    throw new GitLabApiError(
      response.status,
      `GitLab API returned ${response.status} ${response.statusText}: ${body}`,
    );
  }
}
