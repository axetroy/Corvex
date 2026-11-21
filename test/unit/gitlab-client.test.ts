import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { GitLabApiError, GitLabClient, GitLabWriteError, gitlabEndpoint, repositoryCloneUrl, repositoryWebUrl } from "../../src/gitlab/client.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

describe("GitLab base URL", () => {
  it("can be configured after startup through the console", async () => {
    const client = new GitLabClient("", "read", "write");
    await expect(client.listProjects("", 1)).rejects.toThrow("GitLab base URL is not configured");
    expect(() => client.configure("https://gitlab.example.com", "read", "write")).not.toThrow();
    expect(() => new GitLabClient("", "", "")).not.toThrow();
  });
});

describe("GitLab endpoint URLs", () => {
  it("preserves the instance subpath", () => {
    expect(gitlabEndpoint("https://gitlab.example.com/", "api/v4/projects"))
      .toBe("https://gitlab.example.com/api/v4/projects");
    expect(gitlabEndpoint("https://example.com/gitlab", "/oauth/token"))
      .toBe("https://example.com/gitlab/oauth/token");
  });
});

describe("GitLab authentication modes", () => {
  it("sends OAuth access tokens as Bearer instead of PRIVATE-TOKEN", async () => {
    let authorization = "";
    let privateToken = "";
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization ?? "");
      privateToken = String(request.headers["private-token"] ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "oauth-token", "oauth-token", 10_000, "bearer");
      await expect(client.listProjects("", 1)).resolves.toEqual([]);
      expect(authorization).toBe("Bearer oauth-token");
      expect(privateToken).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("GitLab write receipts", () => {
  it("lists accessible projects with a bounded page and optional search", async () => {
    let requestUrl = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        id: 5,
        name: "Corvex",
        path_with_namespace: "axetroy/Corvex",
        description: "GitLab code review and repair agent",
        http_url_to_repo: "https://gitlab.example.com/axetroy/Corvex.git",
        default_branch: "main",
      }]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      await expect(client.listProjects("Corvex", 2)).resolves.toEqual([{
        id: 5,
        name: "Corvex",
        path_with_namespace: "axetroy/Corvex",
        description: "GitLab code review and repair agent",
        http_url_to_repo: "https://gitlab.example.com/axetroy/Corvex.git",
        default_branch: "main",
      }]);
      expect(requestUrl).toBe("/api/v4/projects?per_page=50&page=2&order_by=name&sort=asc&search=Corvex");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("resolves a branch name to a verified full commit SHA", async () => {
    let requestUrl = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        name: "feature/topic",
        commit: { id: "a".repeat(40) },
      }));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      await expect(client.getBranch(5, "feature/topic")).resolves.toEqual({
        name: "feature/topic",
        commit: { id: "a".repeat(40) },
      });
      expect(requestUrl).toBe("/api/v4/projects/5/repository/branches/feature%2Ftopic");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("lists branches with bounded search queries", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        name: "main",
        commit: {
          id: "b".repeat(40),
          short_id: "bbbbbbbb",
          title: "Tighten branch search",
          committed_date: "2026-11-01T08:00:00.000Z",
        },
      }, {
        name: "legacy",
        commit: { id: "c".repeat(40), title: "   " },
      }]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      // 提交元数据按类型收窄后透传；空白标题等无效值被丢弃。
      await expect(client.listBranches(5, "ma", 2)).resolves.toEqual([
        {
          name: "main",
          commit: {
            id: "b".repeat(40),
            short_id: "bbbbbbbb",
            title: "Tighten branch search",
            committed_date: "2026-11-01T08:00:00.000Z",
          },
        },
        { name: "legacy", commit: { id: "c".repeat(40) } },
      ]);
      expect(requests.map((url) => new URL(url, "http://localhost").pathname)).toEqual([
        "/api/v4/projects/5/repository/branches",
      ]);
      const branchQuery = new URL(requests[0]!, "http://localhost").searchParams;
      expect(branchQuery.get("search")).toBe("ma");
      expect(branchQuery.has("order_by")).toBe(false);
      expect(branchQuery.has("sort")).toBe(false);
      expect(requests.every((url) => url.includes("per_page=50") && url.includes("page=2"))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("paginates Issue notes, filters system notes, and keeps the newest comments", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      const page = new URL(request.url ?? "", "http://localhost").searchParams.get("page");
      response.writeHead(200, {
        "content-type": "application/json",
        ...(page === "1" ? { "x-next-page": "2" } : {}),
      });
      response.end(JSON.stringify(page === "1"
        ? [{ id: 1, body: "system", created_at: "2026-01-01", author: { username: "gitlab" }, system: true }]
        : [
            { id: 2, body: "newest", created_at: "2026-01-02", author: { username: "alice" }, system: false },
            { id: 3, body: "older", created_at: "2026-01-01", author: { username: "bob" }, system: false },
          ]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      await expect(client.getIssueComments(5, 9, 2)).resolves.toEqual([
        { id: 2, author: "alice", createdAt: "2026-01-02", body: "newest", truncated: false },
        { id: 3, author: "bob", createdAt: "2026-01-01", body: "older", truncated: false },
      ]);
      expect(requests).toEqual([
        "/api/v4/projects/5/issues/9/notes?order_by=created_at&sort=desc&per_page=100&page=1",
        "/api/v4/projects/5/issues/9/notes?order_by=created_at&sort=desc&per_page=100&page=2",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("truncates oversized Issue note bodies before returning model context", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([
        { id: 1, body: "x".repeat(5000), created_at: "2026-01-01", author: { username: "alice" }, system: false },
      ]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      const comments = await client.getIssueComments(5, 9, 1);
      expect(comments[0]).toMatchObject({ body: "x".repeat(4000), truncated: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("reads an Issue and creates a draft merge request with pinned branches", async () => {
    const requests: string[] = [];
    let submittedFields = new URLSearchParams();
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "GET" && request.url === "/api/v4/projects/5/issues/9") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ iid: 9, title: "Add labels", description: "Details", state: "opened" }));
        return;
      }
      if (request.method === "GET" && request.url === "/api/v4/projects/5") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 5, http_url_to_repo: "https://gitlab.example.com/group/project.git", default_branch: "main" }));
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        submittedFields = new URLSearchParams(body);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({
          iid: 12,
          web_url: "https://gitlab.example.com/group/project/-/merge_requests/12",
          source_branch: "corvex/issue-9-event1",
          target_branch: "main",
        }));
      });
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.getIssue(5, 9)).resolves.toMatchObject({ title: "Add labels", state: "opened" });
      await expect(client.getProject(5)).resolves.toMatchObject({ default_branch: "main" });
      await expect(client.createDraftMergeRequest(5, {
        title: "Implement issue #9",
        description: "Implementation summary",
        sourceBranch: "corvex/issue-9-event1",
        targetBranch: "main",
      })).resolves.toEqual({
        iid: 12,
        webUrl: "https://gitlab.example.com/group/project/-/merge_requests/12",
        sourceBranch: "corvex/issue-9-event1",
        targetBranch: "main",
      });
      expect(requests).toEqual([
        "GET /api/v4/projects/5/issues/9",
        "GET /api/v4/projects/5",
        "POST /api/v4/projects/5/merge_requests",
      ]);
      expect([...submittedFields.entries()]).toEqual([
        ["title", "Draft: Implement issue #9"],
        ["description", "Implementation summary"],
        ["source_branch", "corvex/issue-9-event1"],
        ["target_branch", "main"],
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("posts notes to an Issue rather than a merge request", async () => {
    let requestUrl = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 43 }));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.postIssueNote(5, 9, "Issue acknowledgement")).resolves.toEqual({
        status: 201,
        resourceId: 43,
      });
      expect(requestUrl).toBe("/api/v4/projects/5/issues/9/notes");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("returns only the response status and resource ID", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 42, body: "sensitive response content" }));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.postNote(1, 2, "comment text")).resolves.toEqual({
        status: 201,
        resourceId: 42,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps a draft merge request in draft when updating its title", async () => {
    const requests: string[] = [];
    let submittedFields = new URLSearchParams();
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          iid: 9,
          state: "opened",
          title: "Draft: Old title",
          description: "",
          source_branch: "feature",
          target_branch: "main",
          sha: "a".repeat(40),
          diff_refs: { base_sha: "b".repeat(40), start_sha: "b".repeat(40), head_sha: "a".repeat(40) },
          draft: true,
        }));
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        submittedFields = new URLSearchParams(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 42, title: "Draft: Retitled" }));
      });
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await client.updateMergeRequest(5, 9, { title: "Retitled" });
      expect(requests).toEqual([
        "GET /api/v4/projects/5/merge_requests/9",
        "PUT /api/v4/projects/5/merge_requests/9",
      ]);
      expect(submittedFields.get("title")).toBe("Draft: Retitled");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("updates only the supplied merge request fields with PUT", async () => {
    const requestMethods: string[] = [];
    const requestPaths: string[] = [];
    let submittedFields = new URLSearchParams();
    const server = createServer((request, response) => {
      requestMethods.push(request.method ?? "");
      requestPaths.push(request.url ?? "");
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          iid: 9,
          state: "opened",
          title: "Existing title",
          description: "",
          source_branch: "feature",
          target_branch: "main",
          sha: "a".repeat(40),
          diff_refs: { base_sha: "b".repeat(40), start_sha: "b".repeat(40), head_sha: "a".repeat(40) },
          draft: false,
        }));
        return;
      }
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        submittedFields = new URLSearchParams(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 42, title: "Retitled" }));
      });
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.updateMergeRequest(5, 9, { title: "Retitled" })).resolves.toEqual({
        status: 200,
        resourceId: 42,
      });
      expect(requestMethods).toEqual(["GET", "PUT"]);
      expect(requestPaths).toEqual([
        "/api/v4/projects/5/merge_requests/9",
        "/api/v4/projects/5/merge_requests/9",
      ]);
      expect([...submittedFields.entries()]).toEqual([["title", "Retitled"]]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects empty or invalid metadata updates before making a request", async () => {
    const client = new GitLabClient("https://gitlab.example.com", "read", "write-token");
    await expect(client.updateMergeRequest(5, 9, {})).rejects.toThrow("at least one");
    await expect(client.updateMergeRequest(5, 9, { title: "   " })).rejects.toThrow("title must contain");
    await expect(client.updateMergeRequest(5, 9, { title: "x".repeat(256) })).rejects.toThrow("title must contain");
    await expect(client.updateMergeRequest(5, 9, { description: "x".repeat(100_001) })).rejects.toThrow("description must not exceed");
    await expect(client.updateMergeRequest(Number.MAX_SAFE_INTEGER + 1, 9, { title: "Valid" })).rejects.toThrow("safe integers");
  });

  it("marks a lost response as an unknown write outcome", async () => {
    const server = createServer((request) => request.socket.destroy());
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.postNote(1, 2, "comment text")).rejects.toBeInstanceOf(GitLabWriteError);
      await expect(client.postNote(1, 2, "comment text")).rejects.toMatchObject({ outcomeUnknown: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("GitLab read retries", () => {
  it("returns only the requested recent non-system merge request comments", async () => {
    let requestUrl = "";
    let requestToken = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      requestToken = request.headers["private-token"] ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([
        {
          id: 8,
          body: "Latest reply",
          system: false,
          created_at: "2026-11-03T10:00:00Z",
          author: { username: "reviewer" },
        },
        {
          id: 7,
          body: "Merged",
          system: true,
          created_at: "2026-11-03T09:00:00Z",
          author: { username: "system" },
        },
        {
          id: 6,
          body: "Earlier question",
          system: false,
          created_at: "2026-11-03T08:00:00Z",
          author: { username: "author" },
        },
      ]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read-token", "write-token");
      await expect(client.getMergeRequestComments(5, 9, 2)).resolves.toMatchObject([
        { id: 8, body: "Latest reply", author: "reviewer" },
        { id: 6, body: "Earlier question", author: "author" },
      ]);
      expect(requestUrl).toContain("/projects/5/merge_requests/9/notes?");
      expect(requestUrl).toContain("order_by=created_at");
      expect(requestUrl).toContain("sort=desc");
      expect(requestToken).toBe("read-token");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("retries a transient network failure", async () => {
    let attempts = 0;
    const server = createServer((request, response) => {
      attempts++;
      if (attempts === 1) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 1, http_url_to_repo: "https://gitlab.example/group/project.git" }));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.getProject(1)).resolves.toMatchObject({ id: 1 });
      expect(attempts).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("retries a transient response and returns the successful project response", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts++;
      if (attempts === 1) {
        response.writeHead(503, { "retry-after": "0" });
        response.end("temporarily unavailable");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 1, http_url_to_repo: "https://gitlab.example/group/project.git" }));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.getProject(1)).resolves.toMatchObject({ id: 1 });
      expect(attempts).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("caps transient GET retries at three attempts", async () => {
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts++;
      response.writeHead(503, { "retry-after": "0" });
      response.end("temporarily unavailable");
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      const request = client.getProject(1);
      await expect(request).rejects.toBeInstanceOf(GitLabApiError);
      await expect(request).rejects.toMatchObject({
        status: 503,
        message: expect.stringContaining("GitLab API returned 503"),
      });
      expect(attempts).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not retry POST or PUT requests after a transient server response", async () => {
    let attempts = 0;
    const server = createServer((request, response) => {
      attempts++;
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          iid: 2,
          state: "opened",
          title: "Existing title",
          description: "",
          source_branch: "feature",
          target_branch: "main",
          sha: "a".repeat(40),
          diff_refs: { base_sha: "b".repeat(40), start_sha: "b".repeat(40), head_sha: "a".repeat(40) },
          draft: false,
        }));
        return;
      }
      response.writeHead(503);
      response.end("temporarily unavailable");
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write-token");
      await expect(client.postNote(1, 2, "comment text")).rejects.toThrow("GitLab API returned 503");
      expect(attempts).toBe(1);
      await expect(client.updateMergeRequest(1, 2, { title: "Retitled" })).rejects.toThrow("GitLab API returned 503");
      expect(attempts).toBe(3);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("repository URLs from configured base URL", () => {
  const project = {
    id: 254,
    path_with_namespace: "digimaple/cloudoc_sync_drive",
    // GitLab 自己报告的地址故意放旧地址，派生函数必须忽略它。
    http_url_to_repo: "http://192.168.0.69:8092/digimaple/cloudoc_sync_drive.git",
  };

  it("derives clone and web URLs from gitlab.base_url", () => {
    expect(repositoryCloneUrl("https://xafg.qdzk3000.com:8092", project))
      .toBe("https://xafg.qdzk3000.com:8092/digimaple/cloudoc_sync_drive.git");
    expect(repositoryWebUrl("https://xafg.qdzk3000.com:8092/", project))
      .toBe("https://xafg.qdzk3000.com:8092/digimaple/cloudoc_sync_drive");
  });

  it("rejects missing or unsafe project paths", () => {
    expect(() => repositoryCloneUrl("https://gitlab.example.com", { ...project, path_with_namespace: "" })).toThrow();
    expect(() => repositoryCloneUrl("https://gitlab.example.com", { ...project, path_with_namespace: "../secret" })).toThrow();
    expect(() => repositoryCloneUrl("https://gitlab.example.com", { ...project, path_with_namespace: "group/repo?x=1" })).toThrow();
  });
});
describe("GitLabClient runtime reconfiguration", () => {
  it("uses the configured base URL and token on the next request", async () => {
    let authorization = "";
    const server = createServer((request, response) => {
      authorization = String(request.headers["private-token"] ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient("https://gitlab.example.com", "read", "write");
      client.configure(`http://127.0.0.1:${port}`, "new-read", "new-write");
      await expect(client.listProjects("anything", 1)).resolves.toEqual([]);
      expect(authorization).toBe("new-read");
    } finally {
      server.close();
    }
  });
});

describe("GitLab issue and MR state updates", () => {
  it("sends state_event when closing an issue or MR and only submitted issue fields", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        calls.push({
          url: request.url ?? "",
          method: request.method ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 1 }));
      });
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      await client.updateMergeRequest(7, 3, { stateEvent: "close" });
      await client.updateIssue(7, 9, { title: "New title", stateEvent: "close" });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ method: "PUT", url: "/api/v4/projects/7/merge_requests/3" });
      expect(calls[0].body).toContain("state_event=close");
      expect(calls[1].url).toBe("/api/v4/projects/7/issues/9");
      expect(calls[1].body).toContain("title=New+title");
      expect(calls[1].body).toContain("state_event=close");
    } finally {
      server.close();
    }
  });
});

describe("GitLab MR commit pagination", () => {
  it("returns one bounded page with a next-page cursor", async () => {
    let url = "";
    const server = createServer((request, response) => {
      url = request.url ?? "";
      response.writeHead(200, {
        "content-type": "application/json",
        "x-next-page": "2",
      });
      response.end(JSON.stringify([
        { id: "a".repeat(40), title: "Fix parser", author: { name: "Dev" }, created_at: "2026-11-20T01:00:00Z" },
        { id: "b".repeat(40), title: "x".repeat(500), author_name: "Other", created_at: "2026-11-19T01:00:00Z" },
      ]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      const page = await client.getMergeRequestCommits(7, 3, 1, 2);
      expect(url).toContain("/api/v4/projects/7/merge_requests/3/commits");
      expect(url).toContain("per_page=2");
      expect(page).toMatchObject({ page: 1, perPage: 2, hasMore: true, nextPage: 2 });
      expect(page.commits).toHaveLength(2);
      expect(page.commits[0]).toMatchObject({ id: "a".repeat(40), title: "Fix parser", author: "Dev" });
      expect(page.commits[1].title).toHaveLength(300);
    } finally {
      server.close();
    }
  });

  it("rejects an oversized page size before calling GitLab", async () => {
    const client = new GitLabClient("https://gitlab.example.com", "read", "write");
    await expect(client.getMergeRequestCommits(7, 3, 1, 21)).rejects.toThrow("page size must be between 1 and 20");
  });
});

describe("GitLab discovery and MR changes", () => {
  it("lists bounded issue and merge request summaries in the current project", async () => {
    let issuesUrl = "";
    let mrsUrl = "";
    const server = createServer((request, response) => {
      const url = request.url ?? "";
      if (url.includes("/issues?")) {
        issuesUrl = url;
        response.end(JSON.stringify([
          { iid: 1, title: "Issue one", state: "opened", web_url: "https://git.example/i/1" },
          { iid: 2, title: "Issue two", state: "closed" },
        ]));
      } else if (url.includes("/merge_requests?")) {
        mrsUrl = url;
        response.end(JSON.stringify([
          {
            iid: 3, title: "MR three", state: "opened",
            source_branch: "feature", target_branch: "main", web_url: "https://git.example/mr/3",
          },
        ]));
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      const issues = await client.listIssues(7, { state: "all", search: "parser", page: 2, perPage: 10 });
      expect(issuesUrl).toContain("/api/v4/projects/7/issues?");
      expect(issuesUrl).toContain("state=all");
      expect(issuesUrl).toContain("search=parser");
      expect(issuesUrl).toContain("page=2");
      expect(issues).toMatchObject([
        { iid: 1, title: "Issue one", state: "opened", webUrl: "https://git.example/i/1" },
        { iid: 2, title: "Issue two", state: "closed" },
      ]);

      const mrs = await client.listMergeRequests(7, {});
      expect(mrsUrl).toContain("/api/v4/projects/7/merge_requests?");
      expect(mrsUrl).toContain("state=opened");
      expect(mrs).toMatchObject([{ iid: 3, title: "MR three", sourceBranch: "feature", targetBranch: "main" }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("caps MR changes by file count and total patch bytes", async () => {
    const server = createServer((request, response) => {
      if (!(request.url ?? "").endsWith("/api/v4/projects/7/merge_requests/3/changes")) {
        response.statusCode = 404;
        response.end("{}");
        return;
      }
      response.end(JSON.stringify({
        changes: [
          { old_path: "a.ts", new_path: "a.ts", patch: "one" },
          { old_path: "b.ts", new_path: "b.ts", patch: "two" },
          { old_path: "c.ts", new_path: "c.ts", patch: "three" },
        ],
      }));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "read", "write");
      const changes = await client.getMergeRequestChanges(7, 3);
      expect(changes.changes).toHaveLength(3);
      expect(changes.truncated).toBe(false);
      expect(changes.changes[0]).toEqual({ oldPath: "a.ts", newPath: "a.ts", patch: "one" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects invalid discovery parameters before calling GitLab", async () => {
    const client = new GitLabClient("https://gitlab.example.com", "read", "write");
    await expect(client.listIssues(7, { perPage: 21 })).rejects.toThrow("page size must be between 1 and 20");
    await expect(client.listMergeRequests(7, { page: 0 })).rejects.toThrow("page must be between 1 and 10000");
    await expect(client.getMergeRequestChanges(0, 3)).rejects.toThrow("must be positive");
  });
});
