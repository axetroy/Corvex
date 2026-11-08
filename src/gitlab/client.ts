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
  http_url_to_repo: string;
  default_branch?: string;
}

export interface GitLabBranch {
  name: string;
  commit: { id: string };
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string;
  state: string;
  web_url?: string;
}

export interface GitLabMergeRequestSummary {
  iid: number;
  title: string;
  description: string;
  state: string;
  source_branch: string;
  target_branch: string;
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

export interface MergeRequestMetadataUpdate {
  title?: string;
  description?: string;
}

export interface DiscussionPosition {
  baseSha: string;
  startSha: string;
  headSha: string;
  oldPath: string;
  newPath: string;
  newLine: number;
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

function validDiscussionPath(value: string): boolean {
  return (
    value !== "" &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export class GitLabClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly readToken: string,
    private readonly writeToken: string,
    private readonly requestTimeoutMs = 10_000,
  ) {
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
    if (!writeToken) throw new Error("GitLab write API token is required");
    if (requestTimeoutMs <= 0) throw new Error("GitLab request timeout must be positive");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
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
      simple: "true",
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
      return value as unknown as GitLabBranch;
    });
  }

  async listIssues(projectId: number, search: string, page: number, signal?: AbortSignal): Promise<GitLabIssue[]> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const query = this.targetListQuery(search, page, { scope: "all" });
    const result = await this.getJson(`/projects/${projectId}/issues?${query}`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab Issue list is not an array");
    return result.map((value) => {
      if (
        !isRecord(value) || !Number.isSafeInteger(value.iid) || typeof value.title !== "string" ||
        typeof value.description !== "string" || typeof value.state !== "string"
      ) throw new Error("GitLab returned an incomplete Issue list entry");
      return value as unknown as GitLabIssue;
    });
  }

  async listMergeRequests(
    projectId: number,
    search: string,
    page: number,
    signal?: AbortSignal,
  ): Promise<GitLabMergeRequestSummary[]> {
    if (projectId <= 0) throw new Error("project ID must be positive");
    const query = this.targetListQuery(search, page, { state: "all" });
    const result = await this.getJson(`/projects/${projectId}/merge_requests?${query}`, signal);
    if (!Array.isArray(result)) throw new Error("GitLab merge request list is not an array");
    return result.map((value) => {
      if (
        !isRecord(value) || !Number.isSafeInteger(value.iid) || typeof value.title !== "string" ||
        typeof value.description !== "string" || typeof value.state !== "string" ||
        typeof value.source_branch !== "string" || typeof value.target_branch !== "string"
      ) throw new Error("GitLab returned an incomplete merge request list entry");
      return value as unknown as GitLabMergeRequestSummary;
    });
  }

  private targetListQuery(search: string, page: number, extra: Record<string, string> = {}): URLSearchParams {
    const query = this.pagedSearchQuery(search, page);
    query.set("order_by", "updated_at");
    query.set("sort", "desc");
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return query;
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
        this.readToken,
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
        this.readToken,
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

  async createDraftMergeRequest(
    projectId: number,
    input: { title: string; description: string; sourceBranch: string; targetBranch: string },
    signal?: AbortSignal,
  ): Promise<CreatedMergeRequest> {
    if (!Number.isSafeInteger(projectId) || projectId <= 0) throw new Error("project ID must be a positive safe integer");
    if (!input.title.trim() || [...input.title].length > MAX_MR_TITLE_CHARACTERS - 7) {
      throw new Error("draft merge request title must contain 1-248 characters");
    }
    if ([...input.description].length > MAX_MR_DESCRIPTION_CHARACTERS) {
      throw new Error(`merge request description must not exceed ${MAX_MR_DESCRIPTION_CHARACTERS} characters`);
    }
    for (const [label, branch] of [["source", input.sourceBranch], ["target", input.targetBranch]] as const) {
      if (!branch.trim() || branch.length > 255 || branch.startsWith("-") || branch.includes("\0")) {
        throw new Error(`merge request ${label} branch is invalid`);
      }
    }
    const form = new URLSearchParams({
      title: `Draft: ${input.title.trim()}`,
      description: input.description,
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
    });
    let response: Response;
    try {
      response = await this.request(`/projects/${projectId}/merge_requests`, this.writeToken, "POST", signal, form);
    } catch (error) {
      throw new GitLabWriteError(`GitLab merge request creation outcome is unknown: ${String(error)}`, error);
    }
    if (!response.ok) await this.throwResponseError(response);
    const body = await this.successBody(response);
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder().decode(body));
    } catch (error) {
      throw new Error(`decode created merge request response: ${String(error)}`, { cause: error });
    }
    if (
      !isRecord(result) ||
      !Number.isSafeInteger(result.iid) ||
      typeof result.web_url !== "string" ||
      result.source_branch !== input.sourceBranch ||
      result.target_branch !== input.targetBranch
    ) {
      throw new Error("GitLab returned incomplete or mismatched created merge request metadata");
    }
    return {
      iid: result.iid as number,
      webUrl: result.web_url,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
    };
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
    if (update.title === undefined && update.description === undefined) {
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
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}`, form, signal, "PUT");
  }

  async postDiscussion(
    projectId: number,
    mrIid: number,
    body: string,
    position: DiscussionPosition,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    if (!fullSha(position.baseSha) || !fullSha(position.startSha) || !fullSha(position.headSha)) {
      throw new Error("discussion position requires full base, start, and head SHAs");
    }
    if (
      !validDiscussionPath(position.oldPath) ||
      !validDiscussionPath(position.newPath) ||
      position.newLine <= 0
    ) {
      throw new Error("discussion position has an invalid path or new line");
    }
    const form = new URLSearchParams({
      body,
      "position[position_type]": "text",
      "position[base_sha]": position.baseSha,
      "position[start_sha]": position.startSha,
      "position[head_sha]": position.headSha,
      "position[old_path]": position.oldPath,
      "position[new_path]": position.newPath,
      "position[new_line]": String(position.newLine),
    });
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/discussions`, form, signal);
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, this.readToken, "GET", signal);
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
    method: "POST" | "PUT" = "POST",
  ): Promise<GitLabWriteReceipt> {
    let response: Response;
    try {
      response = await this.request(path, this.writeToken, method, signal, form);
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
    method: "GET" | "POST" | "PUT",
    signal?: AbortSignal,
    form?: URLSearchParams,
  ): Promise<Response> {
    if (!token) throw new Error("GitLab API token is required for this request");
    const maxAttempts = method === "GET" ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)])
        : AbortSignal.timeout(this.requestTimeoutMs);
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/api/v4${path}`, {
          method,
          headers: {
            "PRIVATE-TOKEN": token,
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
