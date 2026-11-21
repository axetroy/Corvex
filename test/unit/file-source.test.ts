import { describe, expect, it, vi } from "vitest";
import { GitLabFileSource } from "../../src/app/files/gitlab-source.js";
import { isImagePath } from "../../src/app/files/image.js";
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
    expect(result.source).toBe("gitlab");
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

describe("file image preview", () => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = Buffer.concat([pngSignature, Buffer.from("payload")]);
  const sourceWith = (bytes: Buffer) => new GitLabFileSource(clientWithFile(bytes.toString("base64")), 7, "a".repeat(40));

  it("detects previewable extensions", () => {
    expect(isImagePath("assets/logo.PNG")).toBe(true);
    expect(isImagePath("docs/photo.jpeg")).toBe(true);
    expect(isImagePath("assets/icon.svg")).toBe(true);
    expect(isImagePath("src/index.ts")).toBe(false);
  });

  it("reads image bytes with a validated MIME type", async () => {
    const result = await sourceWith(png).readImage("assets/logo.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.path).toBe("assets/logo.png");
    expect(result.data.equals(png)).toBe(true);
    expect(result.source).toBe("gitlab");
  });

  it("accepts SVG with an XML declaration", async () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect((await sourceWith(svg).readImage("icon.svg")).mimeType).toBe("image/svg+xml");
  });

  it("rejects unsupported extensions and content that does not match its extension", async () => {
    await expect(sourceWith(png).readImage("assets/logo.txt")).rejects.toThrow("unsupported image format");
    await expect(sourceWith(png).readImage("assets/logo.jpg")).rejects.toThrow("not a supported image");
    await expect(sourceWith(Buffer.from("plain text")).readImage("assets/logo.png")).rejects.toThrow("not a supported image");
  });

  it("rejects images over the size limit", async () => {
    const large = Buffer.concat([pngSignature, Buffer.alloc((12 << 20) + 1)]);
    await expect(sourceWith(large).readImage("assets/large.png")).rejects.toThrow("exceeds");
  });
});
