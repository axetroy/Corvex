import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { GitLabClient } from "../../src/gitlab/client.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

const sha = "b".repeat(40);
const branch = (name: string) => ({ name, commit: { id: sha, committed_date: "2026-11-20T00:00:00.000Z" } });

describe("listBranchCandidates", () => {
  it("fetches pages and filters short queries locally instead of relying on GitLab search", async () => {
    const queries: URLSearchParams[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      queries.push(url.searchParams);
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = page === 1
        ? [branch("main"), branch("feature/im-login"), branch("docs")]
        : page === 2
          ? [branch("hotfix/im-cache"), branch("im")]
          : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(items));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "token");
      const candidates = await client.listBranchCandidates(5, "im");
      expect(candidates.map((item) => item.name)).toEqual(["feature/im-login", "hotfix/im-cache", "im"]);
      // 短词不把 search 交给 GitLab，且并发拉了多页后即停。
      expect(queries.length).toBeGreaterThan(1);
      expect(queries.every((query) => !query.has("search"))).toBe(true);
      expect(queries.every((query) => query.get("per_page") === "50")).toBe(true);
    } finally {
      server.close();
    }
  });

  it("sends long queries to GitLab and still drops fuzzy non-matches", async () => {
    const queries: URLSearchParams[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      queries.push(url.searchParams);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([branch("feature/ci-check"), branch("unrelated")]));
    });
    const port = await listen(server);
    try {
      const client = new GitLabClient(`http://127.0.0.1:${port}`, "token");
      const candidates = await client.listBranchCandidates(5, "ci-check");
      expect(candidates.map((item) => item.name)).toEqual(["feature/ci-check"]);
      expect(queries[0]!.get("search")).toBe("ci-check");
    } finally {
      server.close();
    }
  });
});
