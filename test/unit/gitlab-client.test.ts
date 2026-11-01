import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { GitLabClient, GitLabWriteError } from "../../src/gitlab/client.js";

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