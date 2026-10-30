import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createReadOnlyFileExtension,
  readAllowedDirectory,
  readAllowedFile,
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

  it("keeps directory listing and metadata inspection inside allowed roots", async () => {
    await expect(readAllowedDirectory(outside, [root])).rejects.toThrow(
      "outside the configured read-only roots",
    );
    await expect(statAllowedPath(outside, [root])).rejects.toThrow(
      "outside the configured read-only roots",
    );
  });

  it("registers read_dir and stat as agent tools", () => {
    const registered: string[] = [];
    const extension = createReadOnlyFileExtension([root]);

    extension({
      registerTool: (tool: { name: string }) => registered.push(tool.name),
    } as unknown as ExtensionAPI);

    expect(registered).toEqual(expect.arrayContaining(["read_file", "read_dir", "stat"]));
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
