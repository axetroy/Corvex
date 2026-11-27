import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFsReadExtension,
  readAllowedDirectory,
  readAllowedFile,
  readAllowedTree,
  renderDirectoryTree,
  requireRelativeRepoPath,
  searchAllowedFiles,
  findAllowedFiles,
  statAllowedPath,
} from "../../src/agent/fs/index.js";

describe("readAllowedFile", () => {
  let root: string;
  let skills: string;
  let outside: string;
  let base: string;

  beforeEach(async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "corvex-read-"));
    base = temporaryRoot;
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

  it("reads an uploaded file from a per-turn upload root but not from a foreign one", async () => {
    // 附件的 UUID 目录作为第三个只读根注入；相对路径仍按 worktree 解析。
    const uploadDir = join(base, "uploads", "c1", "u1");
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, "notes.txt"), "uploaded text\n");
    const foreignDir = join(base, "uploads", "c1", "u2");
    await mkdir(foreignDir, { recursive: true });
    await writeFile(join(foreignDir, "secret.txt"), "foreign\n");

    await expect(readAllowedFile(join(uploadDir, "notes.txt"), [root, skills, uploadDir])).resolves.toBe("uploaded text\n");
    await expect(readAllowedFile(join(foreignDir, "secret.txt"), [root, skills, uploadDir])).rejects.toThrow(
      "outside the configured read-only roots",
    );
  });

  it("rejects paths outside allowed roots", async () => {
    await expect(readAllowedFile(outside, [root, skills])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    // 绝对路径本身不是放行条件：realpath 后必须仍落在允许根内。
    await expect(readAllowedFile("/etc/passwd", [root, skills])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    await expect(readAllowedFile("../outside.txt", [root, skills])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    await expect(readAllowedFile("../missing.txt", [root, skills])).rejects.toThrow(
      "use a repository-relative path without '..' segments",
    );
  });

  it("rejects absolute paths inside the repository with a relative-path hint", async () => {
    await expect(requireRelativeRepoPath(join(root, "README.md"), [root, skills])).rejects.toThrow(
      "use a repository-relative path",
    );
    await expect(requireRelativeRepoPath(join(skills, "SKILL.md"), [root, skills])).resolves.toBe(
      join(skills, "SKILL.md"),
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
    createFsReadExtension([root])(registrar);
    expect(registered.has("git_grep")).toBe(false);

    createFsReadExtension([root], async () => ({
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
    createFsReadExtension([root])({
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

  it("hints after repeated reads of the same file in one turn", async () => {
    await writeFile(join(root, "same.txt"), "content\n");
    let readFileTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    createFsReadExtension([root], undefined, undefined, 3)({
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        if (tool.name === "read_file") readFileTool = tool;
      },
    } as unknown as ExtensionAPI);
    if (!readFileTool) throw new Error("read_file tool was not registered");

    const first = await readFileTool.execute("call-1", { path: "same.txt" });
    expect(first).toMatchObject({ content: [{ text: "content\n" }] });
    let result: { content: { text: string }[] } | undefined;
    for (let index = 0; index < 2; index += 1) {
      result = await readFileTool.execute(`call-${index + 2}`, { path: "same.txt" }) as typeof result;
    }
    expect(result?.content[0]?.text).toContain("has been read 3 times");
    expect(result?.content[0]?.text).toContain("content");
  });

  it("registers read_dir and stat as agent tools", () => {
    const registered = new Map<string, string | undefined>();
    const extension = createFsReadExtension([root]);

    extension({
      registerTool: (tool: { name: string; executionMode?: string }) => {
        registered.set(tool.name, tool.executionMode);
      },
    } as unknown as ExtensionAPI);

    expect(registered).toEqual(new Map([
      ["read_file", "parallel"],
      ["read_dir", "parallel"],
      ["tree", "parallel"],
      ["stat", "parallel"],
      ["search_text", "parallel"],
      ["glob", "parallel"],
    ]));
  });

  it("matches regular expressions only when explicitly enabled and with bounded input", async () => {
    await writeFile(join(root, "code.ts"), "const a = pause();\nconst pauseX = 1;\n");
    const literal = await searchAllowedFiles("pause\\(\\)", ".", [root], true);
    expect(literal.matches).toEqual([]);

    const regex = await searchAllowedFiles("pause\\(\\)", ".", [root], { regex: true });
    expect(regex.matches).toHaveLength(1);
    expect(regex.matches[0]).toMatchObject({ line: 1 });

    // 中文/大小写不敏感由 gi 标志处理；过长与非法模式在执行前被拒。
    await expect(searchAllowedFiles("x".repeat(201), ".", [root], { regex: true })).rejects.toThrow("at most 200");
    await expect(searchAllowedFiles("[", ".", [root], { regex: true })).rejects.toThrow("invalid regular expression");
  });

  it("finds files by bounded glob patterns without reading content", async () => {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "a.test.ts"), "secret content");
    await writeFile(join(root, "src", "nested", "b.test.ts"), "secret content");
    await writeFile(join(root, "src", "index.ts"), "export {}");
    await writeFile(join(root, "node_modules", "ignored.test.ts"), "test");

    const tests = await findAllowedFiles(".", [root], "*.test.ts");
    expect(tests.matches).toEqual(["src/a.test.ts", "src/nested/b.test.ts"]);
    expect(tests.truncated).toBe(false);

    const all = await findAllowedFiles("src", [root], "**/*.ts");
    expect(all.matches).toContain("src/index.ts");
    expect(all.matches).toContain("src/nested/b.test.ts");
    // 输出里不含任何文件内容。
    expect(JSON.stringify(all)).not.toContain("secret content");

    await expect(findAllowedFiles(".", [root], "")).rejects.toThrow("glob pattern must contain");
    await expect(findAllowedFiles("../outside", [root], "*")).rejects.toThrow("outside");
  });

  it("builds a bounded tree without following symlinks or entering ignored directories", async () => {
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "a.ts"), "a");
    await writeFile(join(root, "src", "nested", "b.ts"), "b");
    await writeFile(join(root, "node_modules", "ignored.ts"), "ignored");
    await symlink(join(root, "src"), join(root, "linked"));

    const result = await readAllowedTree(".", [root], { maxDepth: 3 });
    expect(result.path).toBe(".");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "linked", "README.md", "src", "a.ts", "nested", "b.ts",
    ]);
    expect(result.entries.some((entry) => entry.name === "node_modules")).toBe(false);
    expect(result.entries.find((entry) => entry.name === "linked")).toMatchObject({ type: "symlink", depth: 1 });
    expect(result.entries.find((entry) => entry.name === "b.ts")).toMatchObject({ depth: 3 });
    expect(result.truncated).toBe(false);
    const rendered = renderDirectoryTree(result);
    expect(rendered).toContain("src/");
    expect(rendered).toContain("    b.ts");
    expect(rendered).not.toContain("[truncated:");
  });

  it("exposes the tree tool with a repository-relative path", async () => {
    await mkdir(join(root, "lib"));
    await writeFile(join(root, "lib", "index.ts"), "export {}");
    let treeTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    createFsReadExtension([root])({
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        if (tool.name === "tree") treeTool = tool;
      },
    } as unknown as ExtensionAPI);
    if (!treeTool) throw new Error("tree tool was not registered");

    const result = await treeTool.execute("call-1", { path: "lib" });
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining("index.ts") }] });
    await expect(treeTool.execute("call-2", { path: "../outside" })).rejects.toThrow("outside");
  });

  it("reads via virtual URIs and never puts host paths in tool schemas or errors", async () => {
    const uploadDir = join(base, "uploads", "u-1");
    await mkdir(uploadDir, { recursive: true });
    await writeFile(join(uploadDir, "notes.txt"), "attachment body\n");
    const tools = new Map<string, { description: string; execute: (...args: unknown[]) => Promise<unknown> }>();
    createFsReadExtension([
      { scheme: "worktree", label: "", path: root },
      { scheme: "upload", label: "u-1", path: uploadDir },
    ])({
      registerTool: (tool: { name: string; description: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);

    const readFile = tools.get("read_file")!;
    expect(readFile.description).not.toContain(root);
    expect(readFile.description).not.toContain(uploadDir);
    expect(readFile.description).toContain("worktree://");
    expect(readFile.description).toContain("upload://");

    const fromWorktree = await readFile.execute("call-1", { path: "worktree://README.md" });
    expect(fromWorktree).toMatchObject({ content: [{ text: "# Repository\n" }] });
    const fromUpload = await readFile.execute("call-2", { path: "upload://u-1/notes.txt" });
    expect(fromUpload).toMatchObject({ content: [{ text: "attachment body\n" }] });

    // 宿主绝对路径与错误文本都不泄露。
    await expect(readFile.execute("call-3", { path: "/etc/passwd" })).rejects.toThrow("absolute host paths");
    try {
      await readFile.execute("call-4", { path: "upload://u-1/missing.txt" });
      throw new Error("expected failure");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(root);
      expect(message).not.toContain(uploadDir);
      expect(message).toContain("inspect the parent directory");
    }
  });

  it("stops at the node limit and marks the tree truncated", async () => {
    for (let index = 0; index < 12; index += 1) await writeFile(join(root, `file-${index}.ts`), "x");
    const result = await readAllowedTree(".", [root], { maxNodes: 5 });
    expect(result.entries).toHaveLength(5);
    expect(result.truncated).toBe(true);
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

  it("adds a numbered code frame with context around matches", async () => {
    await writeFile(join(root, "framed.ts"), "a\nb\ntarget\nc\nd\n");

    const result = await searchAllowedFiles("target", ".", [root], { contextLines: 1 });
    expect(result.matches).toEqual([{
      path: "framed.ts",
      line: 3,
      text: "target",
      frame: ["  2 │ b", "> 3 │ target", "  4 │ c"].join("\n"),
    }]);
  });

  it("clamps context at file boundaries and caps each framed line", async () => {
    await writeFile(join(root, "edge.ts"), `target\n${"x".repeat(500)}`);

    const result = await searchAllowedFiles("target", ".", [root], { contextLines: 2 });
    const frame = result.matches[0]?.frame?.split("\n");
    expect(frame).toEqual(["> 1 │ target", `  2 │ ${"x".repeat(400)}`]);
  });

  it("rejects out-of-range context lines", async () => {
    await expect(searchAllowedFiles("x", ".", [root], { contextLines: -1 })).rejects.toThrow(
      "contextLines must be an integer between 0 and 5",
    );
    await expect(searchAllowedFiles("x", ".", [root], { contextLines: 6 })).rejects.toThrow(
      "contextLines must be an integer between 0 and 5",
    );
  });

  it("omits frames by default for backward compatibility", async () => {
    await writeFile(join(root, "plain.txt"), "target\n");

    await expect(searchAllowedFiles("target", ".", [root])).resolves.toMatchObject({
      matches: [{ path: "plain.txt", line: 1, text: "target" }],
    });
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

  it("truncates an oversized line instead of failing a minified file read", async () => {
    const hugeLine = "x".repeat(64 << 10);
    await writeFile(join(root, "minified.js"), `${hugeLine}\nconst answer = 42;\n`);

    const result = await readAllowedFile("minified.js", [root], undefined, { startLine: 1, maxLines: 2 });

    expect(result).toContain("[Lines 1-2]");
    expect(result).toContain("[line truncated, 61440 bytes omitted]");
    expect(result).toContain("const answer = 42;");
    expect(result.length).toBeLessThan(8 << 10);
  });

  it("stops at the output budget and reports where to continue", async () => {
    const lines = Array.from(
      { length: 400 },
      (_, index) => `${String(index + 1).padStart(3, "0")}:${"y".repeat(1000)}`,
    );
    await writeFile(join(root, "wide.txt"), lines.join("\n"));

    const first = await readAllowedFile("wide.txt", [root], undefined, { startLine: 1, maxLines: 400 });
    const nextLine = Number(/more lines available from (\d+)/.exec(first)?.[1]);
    expect(nextLine).toBeGreaterThan(1);
    expect(nextLine).toBeLessThan(401);
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(256 << 10);

    const second = await readAllowedFile("wide.txt", [root], undefined, { startLine: nextLine, maxLines: 2 });
    expect(second).toContain(`[Lines ${nextLine}-${nextLine + 1}`);
    expect(second).toContain(lines[nextLine - 1]!.slice(0, 8));
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
