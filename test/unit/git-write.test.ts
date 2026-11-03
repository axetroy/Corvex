import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitWriteExtension } from "../../src/agent/git-write.js";

describe("Git write tools", () => {
  it("registers only bounded operations bound to the current MR workspace", async () => {
    const writer = {
      status: vi.fn(async () => ({ headSha: "a".repeat(40), clean: true, files: [] })),
      applyPatch: vi.fn(async (patch: string) => ({ patch, changedFiles: ["src/app.ts"] })),
      commit: vi.fn(async (message: string) => ({ sha: "b".repeat(40), message, changedFiles: ["src/app.ts"] })),
      push: vi.fn(async () => ({ sha: "b".repeat(40), branch: "feature/fix" })),
      revert: vi.fn(async (sha: string) => ({ sha: "c".repeat(40), revertedSha: sha })),
    };
    const registered = new Map<string, {
      parameters: unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    }>();
    createGitWriteExtension(writer)({
      registerTool: (tool: { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }) => {
        registered.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);

    expect([...registered.keys()]).toEqual([
      "git_status",
      "git_apply_patch",
      "git_commit",
      "git_push",
      "git_revert",
    ]);
    await registered.get("git_apply_patch")!.execute("call-1", { patch: "diff" });
    await registered.get("git_commit")!.execute("call-2", { message: "Fix it" });
    await registered.get("git_push")!.execute("call-3", {});
    await registered.get("git_revert")!.execute("call-4", { sha: "b".repeat(40) });
    expect(writer.applyPatch).toHaveBeenCalledWith("diff");
    expect(writer.commit).toHaveBeenCalledWith("Fix it");
    expect(writer.push).toHaveBeenCalledOnce();
    expect(writer.revert).toHaveBeenCalledWith("b".repeat(40));
    expect(JSON.stringify([...registered.values()].map(({ parameters }) => parameters)))
      .not.toMatch(/projectId|mrIid|repository|branch|force/u);
  });
});