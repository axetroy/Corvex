import { describe, expect, it, vi } from "vitest";
import { GitLabFileSource } from "../../src/app/files/gitlab-source.js";
import type { GitLabClient } from "../../src/gitlab/client.js";

function clientWithFile(content: string, encoding = "base64"): GitLabClient {
  return {
    listRepositoryTree: vi.fn(async () => ({ entries: [], truncated: false })),
    getRepositoryFile: vi.fn(async () => ({ path: "a.txt", size: content.length, encoding, content })),
  } as unknown as GitLabClient;
}

describe("GitLab file source adapter", () => {
  it("decodes base64 content and slices line ranges", async () => {
    const content = Buffer.from("one\ntwo\nthree\nfour\n", "utf8").toString("base64");
    const source = new GitLabFileSource(clientWithFile(content), 7, "a".repeat(40));
    const result = await source.readFile("a.txt", { startLine: 2, maxLines: 2 });
    expect(result.content).toBe("two\nthree");
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(5);
  });

  it("returns a placeholder for binary files", async () => {
    const source = new GitLabFileSource(clientWithFile(Buffer.from([0, 1, 2]).toString("base64")), 7, "a".repeat(40));
    const result = await source.readFile("image.png");
    expect(result.content).toContain("二进制文件");
    expect(result.truncated).toBe(false);
  });

  it("passes the pinned ref and normalized path to the client", async () => {
    const client = clientWithFile("");
    const source = new GitLabFileSource(client, 7, "c".repeat(40));
    await source.listDirectory("/src//sub/");
    expect(client.listRepositoryTree).toHaveBeenCalledWith(7, { path: "src/sub", ref: "c".repeat(40) }, undefined);
    await expect(source.listDirectory("../secret")).rejects.toThrow("invalid repository-relative path");
  });
});
