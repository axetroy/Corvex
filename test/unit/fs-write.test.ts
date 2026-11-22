import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceTextExactly, maxReplaceBytes, resolveWorktreePath } from "../../src/agent/fs/index.ts";

describe("worktree path guard", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("resolves relative paths and rejects escapes, .git and symlinks", async () => {
    root = await mkdtemp(join(tmpdir(), "corvex-fs-write-"));
    await writeFile(join(root, "a.txt"), "a");
    await expect(resolveWorktreePath(root, "src/a.ts")).resolves.toMatchObject({ path: "src/a.ts" });
    await expect(resolveWorktreePath(root, "../escape")).rejects.toThrow("invalid repository-relative path");
    await expect(resolveWorktreePath(root, ".git/config")).rejects.toThrow(".git");
    const resolved = await resolveWorktreePath(root, "a.txt");
    // macOS 的 /var 与 Windows 的短路径都可能是符号链接，统一按 realpath 比较。
    expect(resolved.target).toBe(await realpath(join(root, "a.txt")));
  });
});

describe("exact text replacement", () => {
  it("replaces one exact match", () => {
    expect(replaceTextExactly("const a = 1;\nconst b = 2;", "const a = 1;", "const a = 3;", false)).toEqual({
      updated: "const a = 3;\nconst b = 2;",
      replaced: 1,
    });
  });

  it("replaces all matches when requested", () => {
    expect(replaceTextExactly("a\na\nb", "a", "x", true)).toEqual({ updated: "x\nx\nb", replaced: 2 });
  });

  it("rejects missing or ambiguous matches", () => {
    expect(() => replaceTextExactly("hello", "nope", "x", false)).toThrow("not found");
    expect(() => replaceTextExactly("a a", "a", "x", false)).toThrow("matched 2 times");
  });

  it("caps replacement fragment size", () => {
    expect(() => replaceTextExactly("x", "x", "y".repeat(maxReplaceBytes + 1), false)).toThrow("new_string exceeds");
  });
});
