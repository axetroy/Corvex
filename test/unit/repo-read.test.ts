import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAllowedFile } from "../../src/agent/repo-read.js";

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
  });

  it("rejects oversized and non-UTF-8 files", async () => {
    await writeFile(join(root, "large.txt"), "12345");
    await writeFile(join(root, "invalid.txt"), Buffer.from([0xff, 0xfe]));
    await expect(readAllowedFile("large.txt", [root], 4)).rejects.toThrow(
      "exceeds the 4-byte read limit",
    );
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
