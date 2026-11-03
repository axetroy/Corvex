import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { GitLabApiError, GitLabClient, GitLabWriteError } from "../../src/gitlab/client.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

describe("GitLab write receipts", () => {
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