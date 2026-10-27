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

export interface DiscussionPosition {
  baseSha: string;
  startSha: string;
  headSha: string;
  oldPath: string;
  newPath: string;
  newLine: number;
}

const MAX_RESPONSE_BYTES = 20 << 20;
const MAX_DIFF_BYTES = 16 << 20;

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
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
    if (!readToken || !writeToken) throw new Error("GitLab read and write API tokens are required");
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

  async postNote(
    projectId: number,
    mrIid: number,
    body: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const form = new URLSearchParams({ body });
    await this.write(`/projects/${projectId}/merge_requests/${mrIid}/notes`, form, signal);
  }

  async postDiscussion(
    projectId: number,
    mrIid: number,
    body: string,
    position: DiscussionPosition,
    signal?: AbortSignal,
  ): Promise<void> {
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
    await this.write(`/projects/${projectId}/merge_requests/${mrIid}/discussions`, form, signal);
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

  private async write(path: string, form: URLSearchParams, signal?: AbortSignal): Promise<void> {
    const response = await this.request(path, this.writeToken, "POST", signal, form);
    if (!response.ok) await this.throwResponseError(response);
    await response.body?.cancel();
  }

  private async request(
    path: string,
    token: string,
    method: "GET" | "POST",
    signal?: AbortSignal,
    form?: URLSearchParams,
  ): Promise<Response> {
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
      throw new Error(`send GitLab API request: ${String(error)}`, { cause: error });
    }
    return response;
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
    throw new Error(`GitLab API returned ${response.status} ${response.statusText}: ${body}`);
  }
}
