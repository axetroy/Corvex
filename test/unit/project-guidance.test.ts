import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectGuidance } from "../../src/agent/project-guidance.ts";

describe("project AGENTS.md guidance", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("reads the root AGENTS.md with an untrusted-data framing", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-agents-md-"));
    await writeFile(join(directory, "AGENTS.md"), "Run pnpm test before committing.");
    const result = await readProjectGuidance(directory, { enabled: true, maxBytes: 32_768, language: "en" });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("AGENTS.md");
    expect(result.files[0]?.content).toContain("untrusted repository data");
    expect(result.files[0]?.content).toContain("Run pnpm test before committing.");
    expect(result.truncated).toBe(false);
  });

  it("prefers AGENTS.override.md over AGENTS.md", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-agents-md-"));
    await writeFile(join(directory, "AGENTS.md"), "base guidance");
    await writeFile(join(directory, "AGENTS.override.md"), "override guidance");
    const result = await readProjectGuidance(directory, { enabled: true, maxBytes: 32_768, language: "en" });
    expect(result.files[0]?.path).toBe("AGENTS.override.md");
    expect(result.files[0]?.content).toContain("override guidance");
    expect(result.files[0]?.content).not.toContain("base guidance");
  });

  it("skips empty files and does not expose symlinks outside the worktree", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-agents-md-"));
    const outside = await mkdtemp(join(tmpdir(), "corvex-agents-outside-"));
    try {
      await writeFile(join(directory, "AGENTS.md"), "   \n");
      await writeFile(join(outside, "secret.md"), "outside content");
      await symlink(join(outside, "secret.md"), join(directory, "AGENTS.override.md"));
      const result = await readProjectGuidance(directory, { enabled: true, maxBytes: 32_768, language: "en" });
      expect(result.files).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("truncates guidance to the byte budget", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-agents-md-"));
    await writeFile(join(directory, "AGENTS.md"), "x".repeat(5_000));
    const result = await readProjectGuidance(directory, { enabled: true, maxBytes: 512, language: "en" });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(512);
    expect(result.files[0]?.content).toContain("[truncated]");
  });

  it("returns nothing when disabled", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-agents-md-"));
    await writeFile(join(directory, "AGENTS.md"), "ignored");
    const result = await readProjectGuidance(directory, { enabled: false, maxBytes: 32_768, language: "en" });
    expect(result.files).toEqual([]);
  });
});
