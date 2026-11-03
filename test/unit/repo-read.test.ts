import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadOnlyFileExtension,
  readAllowedDirectory,
  readAllowedFile,
  searchAllowedFiles,
  statAllowedPath,
} from "../../src/agent/repo-read.js";

describe("readAllowedFile", () => {
  let root: string;
  let skills: string;
  let outside: string;

  beforeEach(async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "corvex-read-"));
    root = join(temporaryRoot, "repository");
    skills = join(temporaryRoot, "skills");
    outside = join(temporaryRoot, "outside.txt");
    await mkdir(root);
    await mkdir(skills);
    await writeFile(join(root, "README.md"), "# Repository\n");
    await writeFile(join(skills, "SKILL.md"), "# Trusted skill\n");
    await writeFile(outside, "secret");
  });

  afterEach(async () => {
    await rm(join(root, ".."), { recursive: true, force: true });
  });

  it("reads files from the repository and explicitly trusted skill roots", async () => {
    await expect(readAllowedFile("README.md", [root, skills])).resolves.toBe("# Repository\n");
    await expect(readAllowedFile(join(skills, "SKILL.md"), [root, skills])).resolves.toBe(
      "# Trusted skill\n",
    );
  });

  it("rejects paths outside allowed roots", async () => {
    await expect(readAllowedFile(outside, [root, skills])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    await expect(readAllowedFile("../outside.txt", [root, skills])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    await expect(readAllowedFile("../missing.txt", [root, skills])).rejects.toThrow(
      "use a repository-relative path without '..' segments",
    );
  });

  it("explains that read_file requires a file rather than a directory", async () => {
    await mkdir(join(root, "nested"));

    await expect(readAllowedFile("nested", [root])).rejects.toThrow(
      "provide a file path, not a directory",
    );
  });

  it("guides path inspection when a requested file is missing", async () => {
    await expect(readAllowedFile("missing.ts", [root])).rejects.toThrow(
      "inspect the parent directory with read_dir and verify the intended path with stat",
    );
  });

  it("lists immediate directory entries and reports exact path metadata", async () => {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "file.ts"), "value");

    await expect(readAllowedDirectory(".", [root])).resolves.toMatchObject({
      path: ".",
      entries: expect.arrayContaining([
        { name: "nested", type: "directory" },
        { name: "README.md", type: "file" },
      ]),
      truncated: false,
    });
    await expect(statAllowedPath("nested/file.ts", [root])).resolves.toMatchObject({
      path: "nested/file.ts",
      type: "file",
      size: 5,
    });
    await expect(statAllowedPath("nested", [root])).resolves.toMatchObject({
      path: "nested",
      type: "directory",
    });
  });

  it("stops enumerating directories at the configured result limit", async () => {
    await Promise.all(
      Array.from({ length: 205 }, (_, index) => writeFile(join(root, `entry-${index}.txt`), "")),
    );

    await expect(readAllowedDirectory(".", [root])).resolves.toMatchObject({
      entries: expect.arrayContaining([{ name: "entry-0.txt", type: "file" }]),
      truncated: true,
    });
    const result = await readAllowedDirectory(".", [root]);
    expect(result.entries).toHaveLength(200);
  });

  it("keeps directory listing and metadata inspection inside allowed roots", async () => {
    await expect(readAllowedDirectory(outside, [root])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    await expect(statAllowedPath(outside, [root])).rejects.toThrow(
      "outside the configured read-only roots",
    );
  });

  it("registers git_grep only when pinned Git search is available", async () => {
    const registered = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const registrar = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
        registered.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    createReadOnlyFileExtension([root])(registrar);
    expect(registered.has("git_grep")).toBe(false);

    createReadOnlyFileExtension([root], async () => ({
      matches: [{ path: "src/app.ts", line: 9, text: "const target = true" }],
      truncated: true,
    }))(registrar);
    const tool = registered.get("git_grep");
    expect(tool).toBeDefined();
    const result = await tool!.execute("call-1", { query: "target", path: "src" });
    expect(result).toMatchObject({
      content: [{
        text: JSON.stringify({
          matches: [{ path: "src/app.ts", line: 9, text: "const target = true" }],
          truncated: true,
        }),
      }],
    });
  });

  it("reuses a sequential range cursor without changing line headers", async () => {
    await writeFile(join(root, "large.txt"), Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"));
    let readFileTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    createReadOnlyFileExtension([root])({
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        if (tool.name === "read_file") readFileTool = tool;
      },
    } as unknown as ExtensionAPI);
    if (!readFileTool) throw new Error("read_file tool was not registered");

    const first = await readFileTool.execute("call-1", { path: "large.txt", startLine: 1, maxLines: 3 });
    const second = await readFileTool.execute("call-2", { path: "large.txt", startLine: 4, maxLines: 3 });

    expect(first).toMatchObject({ content: [{ text: expect.stringContaining("[Lines 1-3; more lines available from 4]") }] });
    expect(first).toMatchObject({ content: [{ text: expect.stringContaining("line 1\nline 2\nline 3") }] });
    expect(second).toMatchObject({ content: [{ text: expect.stringContaining("[Lines 4-6; more lines available from 7]") }] });
    expect(second).toMatchObject({ content: [{ text: expect.stringContaining("line 4\nline 5\nline 6") }] });
  });

  it("registers read_dir and stat as agent tools", () => {
    const registered = new Map<string, string | undefined>();
    const extension = createReadOnlyFileExtension([root]);

    extension({
      registerTool: (tool: { name: string; executionMode?: string }) => {
        registered.set(tool.name, tool.executionMode);
      },
    } as unknown as ExtensionAPI);

    expect(registered).toEqual(new Map([
      ["read_file", "parallel"],
      ["read_dir", "parallel"],
      ["stat", "parallel"],
      ["search_text", "parallel"],
    ]));
  });

  it("searches literal text with bounded, case-insensitive results", async () => {
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "nested", "file.ts"), "first Match\nno hit\nMATCH again\n");
    await writeFile(join(root, "node_modules", "ignored.ts"), "match should be ignored");

    await expect(searchAllowedFiles("match", ".", [root])).resolves.toEqual({
      matches: [
        { path: "nested/file.ts", line: 1, text: "first Match" },
        { path: "nested/file.ts", line: 3, text: "MATCH again" },
      ],
      scannedFiles: 2,
      truncated: false,
    });
    await expect(searchAllowedFiles("match", ".", [root], true)).resolves.toMatchObject({ matches: [] });
  });

  it("restricts search to allowed paths and validates the query", async () => {
    await expect(searchAllowedFiles("secret", outside, [root])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    await expect(searchAllowedFiles("  ", ".", [root])).rejects.toThrow("search query must contain");
    await expect(searchAllowedFiles("x".repeat(257), ".", [root])).rejects.toThrow(
      "search query must contain",
    );
  });

  it("caps search results and reports truncation", async () => {
    await writeFile(join(root, "many.txt"), Array.from({ length: 60 }, (_, index) => `match ${index}`).join("\n"));

    await expect(searchAllowedFiles("match", "many.txt", [root])).resolves.toMatchObject({
      matches: expect.arrayContaining([{ path: "many.txt", line: 50, text: "match 49" }]),
      scannedFiles: 1,
      truncated: true,
    });
    const result = await searchAllowedFiles("match", "many.txt", [root]);
    expect(result.matches).toHaveLength(50);
  });

  it("does not mark exactly fifty complete matches as truncated", async () => {
    await writeFile(join(root, "exact.txt"), Array.from({ length: 50 }, (_, index) => `match ${index}`).join("\n"));

    await expect(searchAllowedFiles("match", "exact.txt", [root])).resolves.toMatchObject({
      matches: expect.arrayContaining([{ path: "exact.txt", line: 50, text: "match 49" }]),
      truncated: false,
    });
  });

  it("skips oversized files and reports incomplete search results", async () => {
    await writeFile(join(root, "large.txt"), `${"x".repeat(300 << 10)}target`);

    await expect(searchAllowedFiles("target", "large.txt", [root])).resolves.toEqual({
      matches: [],
      scannedFiles: 1,
      truncated: true,
    });
  });

  it("rejects oversized and non-UTF-8 files", async () => {
    await writeFile(join(root, "large.txt"), "12345");
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff, 0xfe]));
    await expect(readAllowedFile("large.txt", [root], 4)).rejects.toThrow(
      "exceeds the 4-byte read limit",
    );
    await expect(readAllowedFile("large.txt", [root], 4)).rejects.toThrow("startLine: 1");
    await expect(readAllowedFile("invalid.txt", [root])).rejects.toThrow("not valid UTF-8");
  });

  it("reads a bounded line range from an oversized file", async () => {
    await writeFile(join(root, "large.txt"), Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"));

    const result = await readAllowedFile("large.txt", [root], 64, { startLine: 5, maxLines: 3 });

    expect(result).toContain("Lines 5-7");
    expect(result).toContain("more lines available from 8");
    expect(result).toContain("line 5\nline 6\nline 7");
    expect(result).not.toContain("line 4");
    expect(result).not.toContain("line 8");
  });

  it("reports the exact line count when a file ends with a newline", async () => {
    await writeFile(join(root, "tail.txt"), "alpha\nbeta\n");

    await expect(readAllowedFile("tail.txt", [root], 64, { startLine: 3, maxLines: 1 })).rejects.toThrow(
      "startLine 3 exceeds the file length of 2 lines",
    );
  });

  it("counts the final line when a file has no trailing newline", async () => {
    await writeFile(join(root, "no-tail.txt"), "alpha\nbeta");

    await expect(readAllowedFile("no-tail.txt", [root], 64, { startLine: 3, maxLines: 1 })).rejects.toThrow(
      "startLine 3 exceeds the file length of 2 lines",
    );
  });
});
