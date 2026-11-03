import { setTimeout as sleep } from "node:timers/promises";

export interface MergeRequest {
  iid: number;
  state: string;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  diff_refs: { base_sha: string; start_sha: string; head_sha: string };
}

export interface Project {
  id: number;
  http_url_to_repo: string;
}

export interface MergeRequestDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  too_large: boolean;
  collapsed: boolean;
}

export interface MergeRequestComment {
  id: number | string;
  author: string;
  createdAt: string;
  body: string;
  truncated: boolean;
}

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
/** 分页合并请求 Diff 累计允许读取的最大字节数。 */
const MAX_DIFF_BYTES = 16 << 20;
/** 单条历史评论最多保留的字符数，避免超大评论占满模型上下文。 */
const MAX_COMMENT_CHARACTERS = 4_000;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

  async getMergeRequestDiff(
    projectId: number,
    mrIid: number,
    signal?: AbortSignal,
  ): Promise<MergeRequestDiff[]> {
    if (projectId <= 0 || mrIid <= 0) throw new Error("project ID and MR IID must be positive");
    const all: MergeRequestDiff[] = [];
    let totalBytes = 0;
    // 同时限制页数、文件数和累计字节数，避免超大 MR diff 无界占用内存。
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({ per_page: "100", page: String(page) });
      const response = await this.request(
        `/projects/${projectId}/merge_requests/${mrIid}/diffs?${query}`,
        this.readToken,
        "GET",
        signal,
      );
      const body = await this.successBody(response);
      let pageDiffs: unknown;
      try {
        pageDiffs = JSON.parse(new TextDecoder().decode(body));
      } catch (error) {
        throw new Error(`decode GitLab API response: ${String(error)}`, { cause: error });
      }
      if (!Array.isArray(pageDiffs)) throw new Error("GitLab diff response is not an array");
      if (all.length + pageDiffs.length > 2000) {
        throw new Error("merge request diff exceeds the 2000-file safety limit");
      }
      for (const item of pageDiffs) {
        if (!isRecord(item)) throw new Error("GitLab returned an invalid diff entry");
        const diff = item as unknown as MergeRequestDiff;
        totalBytes += diff.old_path.length + diff.new_path.length + diff.diff.length;
        if (totalBytes > MAX_DIFF_BYTES) {
          throw new Error(`merge request diff exceeds the ${MAX_DIFF_BYTES}-byte safety limit`);
        }
        all.push(diff);
      }
      const next = response.headers.get("x-next-page") ?? "";
      if (!next && pageDiffs.length < 100) return all;
      if (next && Number(next) !== page + 1) {
        throw new Error(`GitLab returned invalid pagination cursor "${next}"`);
      }
    }
    throw new Error("merge request diff exceeds the 20-page safety limit");
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

  async postNote(
    projectId: number,
    mrIid: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<GitLabWriteReceipt> {
    const form = new URLSearchParams({ body });
    return this.write(`/projects/${projectId}/merge_requests/${mrIid}/notes`, form, signal);
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
    if (update.title !== undefined) form.set("title", update.title);
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
