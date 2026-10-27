import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiffEngine } from "../../src/git/diff.js";
import { GitManager } from "../../src/git/manager.js";
import type { Workspace } from "../../src/git/types.js";

const execFile = promisify(execFileCallback);

describe("Git workflows", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("builds a bounded diff from validated Git output", async () => {
    const workspace: Workspace = {
      projectId: 1,
      jobId: "job-1",
      path: "unused",
      headSha: "b".repeat(40),
    };
    const calls: string[][] = [];
    const engine = new DiffEngine(async (_workspace, args) => {
      calls.push(args);
      if (args.includes("--name-status")) {
        return { stdout: Buffer.from("M\0src/app.ts\0"), truncated: false };
      }
      if (args.includes("--numstat")) {
        return { stdout: Buffer.from("1\t0\tsrc/app.ts\0"), truncated: false };
      }
      return {
        stdout: Buffer.from("diff --git a/src/app.ts b/src/app.ts\n@@ -0,0 +1 @@\n+value\n"),
        truncated: false,
      };
    });
    const result = await engine.diff(workspace, "a".repeat(40), 10, 1024);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.path).toBe("src/app.ts");
    expect(result.changes[0]?.patch).toContain("+value");
    expect(calls).toHaveLength(3);
  });

  it("applies a fix patch only to an authorized tracked file", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-git-"));
    const root = join(directory, "storage");
    const workspacePath = join(root, "workspaces", "7", "job-1");
    await mkdir(workspacePath, { recursive: true });
    await execFile("git", ["init", "-q", workspacePath]);
    await execFile("git", ["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", workspacePath, "config", "user.name", "Corvex test"]);
    await execFile("git", ["-C", workspacePath, "config", "core.autocrlf", "false"]);
    await writeFile(join(workspacePath, "a.txt"), "old\n");
    await execFile("git", ["-C", workspacePath, "add", "a.txt"]);
    await execFile("git", ["-C", workspacePath, "commit", "-q", "-m", "base"]);
    const { stdout } = await execFile("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    const manager = new GitManager(root, "https://gitlab.example.com", "read-token");
    await manager.initialize();
    const workspace: Workspace = {
      projectId: 7,
      jobId: "job-1",
      path: workspacePath,
      headSha: stdout.trim(),
    };
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    await expect(manager.applyPatch(workspace, patch, ["other.txt"], 1024)).rejects.toThrow(
      "unauthorized or unsupported path",
    );
    const applied = await manager.applyPatch(workspace, patch, ["a.txt"], 1024);
    expect(applied).toContain("+new");
  });
});
