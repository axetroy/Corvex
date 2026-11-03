import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitHistoryExtension } from "../../src/agent/git-history.js";

describe("Git history tools", () => {
  it("registers bounded log and show tools without allowing repository selection", async () => {
    const getCommitLog = vi.fn(async (limit: number, path?: string) => ({
      commits: [{ sha: "a".repeat(40), author: "reviewer", authoredAt: "2026-11-03T10:00:00Z", subject: `Tighten validation (${limit}) ${path ?? ""}` }],
      truncated: false,
    }));
    const showCommit = vi.fn(async (sha: string, path?: string) => ({
      sha,
      output: `commit details and patch ${path ?? ""}`,
      truncated: false,
    }));
    const registered = new Map<string, {
      parameters: unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    }>();
    createGitHistoryExtension(getCommitLog, showCommit)({
      registerTool: (tool: { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }) => {
        registered.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);

    expect([...registered.keys()]).toEqual(["git_log", "git_show"]);
    await expect(registered.get("git_log")!.execute("call-1", { path: "src/app.ts" })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("Tighten validation") }],
    });
    expect(getCommitLog).toHaveBeenCalledWith(10, "src/app.ts");
    await expect(registered.get("git_show")!.execute("call-2", { sha: "b".repeat(40), path: "src/app.ts" })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining("commit details and patch") }],
    });
    expect(showCommit).toHaveBeenCalledWith("b".repeat(40), "src/app.ts");
    expect(JSON.stringify([...registered.values()].map(({ parameters }) => parameters)))
      .not.toMatch(/projectId|mrIid|repository|revision/u);
  });
});
