import { describe, expect, it } from "vitest";
import {
  assignSkillLabels,
  isWithinRoot,
  normalizeRoots,
  parseVirtualPath,
  toWorktreeRelative,
  virtualizeError,
  virtualizePath,
  type ReadRoot,
} from "../../src/agent/fs/virtual-path.js";
import { redactHostPaths } from "../../src/redact.js";

const roots: ReadRoot[] = [
  { scheme: "worktree", label: "", path: "/srv/repo" },
  { scheme: "skill", label: "alpha", path: "/srv/skills/alpha" },
  { scheme: "upload", label: "u-1", path: "/srv/uploads/c/u-1" },
];

describe("virtual path parsing", () => {
  it("accepts worktree:// URIs and plain relative paths", () => {
    expect(parseVirtualPath("worktree://src/app.ts", roots)).toMatchObject({ root: roots[0], relative: "src/app.ts" });
    expect(parseVirtualPath("src/app.ts", roots)).toMatchObject({ root: roots[0], relative: "src/app.ts" });
  });

  it("accepts upload:// and skill:// URIs with their labels", () => {
    expect(parseVirtualPath("upload://u-1/notes.txt", roots)).toMatchObject({ root: roots[2], relative: "notes.txt" });
    expect(parseVirtualPath("skill://alpha/SKILL.md", roots)).toMatchObject({ root: roots[1], relative: "SKILL.md" });
  });

  it("rejects host absolute paths, unknown schemes and unknown labels", () => {
    expect(parseVirtualPath("/etc/passwd", roots)).toMatchObject({ error: expect.stringContaining("absolute host paths") });
    expect(parseVirtualPath("C:\\secret.txt", roots)).toMatchObject({ error: expect.stringContaining("absolute host paths") });
    expect(parseVirtualPath("ftp://host/x", roots)).toMatchObject({ error: expect.stringContaining("unsupported path scheme") });
    expect(parseVirtualPath("upload://u-2/x.txt", roots)).toMatchObject({ error: expect.stringContaining("unknown upload root") });
  });

  it("normalizes legacy string roots without treating uploads as skills", () => {
    expect(normalizeRoots(["/srv/repo", "/srv/skills/alpha"])).toMatchObject([
      { scheme: "worktree", label: "" },
      { scheme: "skill", label: "alpha" },
    ]);
    expect(assignSkillLabels(["/a/shared", "/b/shared"])).toEqual(["shared", "shared-2"]);
  });

  it("renders virtual paths without a trailing dot for the root itself", () => {
    expect(virtualizePath(roots[0]!, "src/a.ts")).toBe("worktree://src/a.ts");
    expect(virtualizePath(roots[2]!, "notes.txt")).toBe("upload://u-1/notes.txt");
    expect(virtualizePath(roots[0]!, "")).toBe("worktree://");
  });
});

describe("write path normalization", () => {
  it("strips worktree:// and rejects everything else", () => {
    expect(toWorktreeRelative("worktree://src/a.ts")).toBe("src/a.ts");
    expect(toWorktreeRelative("src/a.ts")).toBe("src/a.ts");
    expect(() => toWorktreeRelative("/etc/passwd")).toThrow("absolute host paths");
    expect(() => toWorktreeRelative("upload://u-1/x")).toThrow("unsupported path scheme");
  });
});

describe("error sanitization", () => {
  it("replaces known root prefixes and masks remaining host paths", () => {
    expect(virtualizeError(new Error("ENOENT realpath /srv/repo/src/a.ts"), roots)).toBe("ENOENT realpath worktree://src/a.ts");
    expect(virtualizeError(new Error("spawn /Users/me/bin/node failed"), roots)).toBe("spawn <path> failed");
    expect(virtualizeError("outside the configured read-only roots", roots)).toBe("outside the configured read-only roots");
  });

  it("redacts host paths in model-facing text while keeping virtual URIs", () => {
    const text = "worktree://src/a.ts at /Users/me/project and C:\\Users\\me\\secret.txt";
    expect(redactHostPaths(text)).toBe("worktree://src/a.ts at <path> and <path>");
  });

  it("keeps boundary checks relative rather than prefix based", () => {
    expect(isWithinRoot("/srv/repo", "/srv/repo/src/a.ts")).toBe(true);
    expect(isWithinRoot("/srv/repo", "/srv/repo-other/a.ts")).toBe(false);
  });
});
