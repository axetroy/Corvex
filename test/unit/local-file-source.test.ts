import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFileSource, WorkspaceUnavailableError } from "../../src/app/files/local-source.js";
import { createConversationFileSource } from "../../src/app/files/factory.js";
import type { GitLabClient } from "../../src/gitlab/client.js";

describe("local worktree file source", () => {
  let root = "";
  let source: LocalFileSource;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "corvex-local-files-"));
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
    await writeFile(join(root, "readme.md"), "# hello\n");
    source = new LocalFileSource(root);
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("lists a directory with stable ordering and no .git", async () => {
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "secret");
    const result = await source.listDirectory("");
    expect(result.entries.map((entry) => entry.path)).toEqual(["src", "readme.md"]);
    expect(result.entries[0]?.type).toBe("directory");
    expect(result.truncated).toBe(false);
    expect(result.source).toBe("local");
    expect((await source.listDirectory("src")).entries).toEqual([
      { name: "a.ts", path: "src/a.ts", type: "file" },
    ]);
  });

  it("reads text with the same line slicing as the GitLab adapter", async () => {
    const result = await source.readFile("src/a.ts", { startLine: 2, maxLines: 2 });
    expect(result.content).toBe("two\nthree");
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(5);
  });

  it("reads image bytes with a validated MIME type", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    await writeFile(join(root, "logo.png"), png);
    const result = await source.readImage("logo.png");
    expect(result.mimeType).toBe("image/png");
    expect(result.data.equals(png)).toBe(true);
    expect(result.source).toBe("local");
  });

  it("rejects absolute paths, traversal, .git and missing files", async () => {
    await expect(source.readFile("../outside")).rejects.toThrow("invalid repository-relative path");
    await expect(source.readFile("/etc/passwd")).rejects.toThrow("absolute paths");
    await expect(source.readFile(".git/config")).rejects.toThrow(".git");
    await expect(source.readFile("missing.txt")).rejects.toThrow("file not found");
  });

  it("signals a missing worktree distinctly", async () => {
    const missing = new LocalFileSource(join(root, "gone"));
    await expect(missing.listDirectory("")).rejects.toBeInstanceOf(WorkspaceUnavailableError);
  });

  it("defaults to local and falls back to GitLab only when the worktree is gone", async () => {
    const gitlab = {
      listRepositoryTree: vi.fn(async () => ({ entries: [], truncated: false })),
      getRepositoryFile: vi.fn(async () => ({ path: "a.txt", size: 0, encoding: "base64", content: "" })),
    } as unknown as GitLabClient;
    const options = {
      projectId: 7,
      sha: "a".repeat(40),
      workspacePath: root,
      gitlab,
      fallbackToGitLab: true,
    };
    const present = createConversationFileSource(options);
    expect(present.kind).toBe("local");
    expect((await present.listDirectory("")).entries.length).toBe(2);
    expect(gitlab.listRepositoryTree).not.toHaveBeenCalled();

    const absent = createConversationFileSource({ ...options, workspacePath: join(root, "gone") });
    const fallbackResult = await absent.listDirectory("");
    expect(fallbackResult.source).toBe("gitlab");
    expect(gitlab.listRepositoryTree).toHaveBeenCalledWith(7, { path: "", ref: "a".repeat(40) }, undefined);
  });
});
