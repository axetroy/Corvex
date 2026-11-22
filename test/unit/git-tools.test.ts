import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGitExtension } from "../../src/agent/git/index.ts";
import { text, type GitToolAdapter } from "../../src/agent/git/common.ts";

type RegisteredTool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

function fakeAdapter(): GitToolAdapter {
  return {
    status: vi.fn(async () => ({ clean: true, files: [] })),
    log: vi.fn(async () => ({ commits: [], truncated: false })),
    show: vi.fn(async () => ({ sha: "a".repeat(40), output: "", truncated: false })),
    diff: vi.fn(async () => ({ diff: "", truncated: false })),
    clone: vi.fn(async () => ({ path: "/workspace", headSha: "a".repeat(40) })),
    branches: vi.fn(async () => ({ branches: ["main"], head: "a".repeat(40) })),
    createBranch: vi.fn(async () => ({ name: "task", sha: "a".repeat(40) })),
    switchBranch: vi.fn(async () => ({ name: "task", sha: "a".repeat(40) })),
    checkout: vi.fn(async () => ({ name: "task", sha: "a".repeat(40), fromRemote: false })),
    pull: vi.fn(async () => ({ sha: "a".repeat(40), fetched: true })),
    merge: vi.fn(async () => ({ sha: "b".repeat(40), ref: "main" })),
    commit: vi.fn(async () => ({ sha: "b".repeat(40), paths: ["a.ts"] })),
    push: vi.fn(async () => ({ ref: "refs/conversations/c1", sha: "b".repeat(40) })),
    pushBranch: vi.fn(async () => ({ branch: "fix/security", sha: "b".repeat(40) })),
    revert: vi.fn(async () => ({ sha: "c".repeat(40), revertedSha: "b".repeat(40) })),
  };
}

function collect(adapter: GitToolAdapter): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const pi = { registerTool: (tool: RegisteredTool) => registered.push(tool) } as unknown as ExtensionAPI;
  createGitExtension(adapter)(pi);
  return registered;
}

describe("consolidated Git tools", () => {
  it("registers inspect, workspace and change tools", () => {
    const names = collect(fakeAdapter()).map((tool) => tool.name);
    expect(names.sort()).toEqual([
      "git_branches", "git_checkout", "git_clone", "git_commit", "git_diff", "git_log",
      "git_merge", "git_pull", "git_push", "git_push_branch", "git_revert", "git_show", "git_status", "git_branch",
    ].sort());
  });

  it("forwards bounded arguments without exposing URLs or flags", async () => {
    const adapter = fakeAdapter();
    const registered = collect(adapter);
    const find = (name: string) => registered.find((tool) => tool.name === name)!;
    await find("git_log").execute("1", { limit: 5, path: "src/a.ts" });
    expect(adapter.log).toHaveBeenCalledWith(5, "src/a.ts");
    await find("git_branch").execute("2", { action: "create", name: "corvex/task" });
    expect(adapter.createBranch).toHaveBeenCalledWith("corvex/task");
    await find("git_checkout").execute("2b", { name: "feature/mr" });
    expect(adapter.checkout).toHaveBeenCalledWith("feature/mr");
    await find("git_merge").execute("3", { ref: "main" });
    expect(adapter.merge).toHaveBeenCalledWith("main");
    await find("git_commit").execute("4", { message: "fix" });
    expect(adapter.commit).toHaveBeenCalledWith("fix");
    await find("git_push_branch").execute("4b", { sha: "b".repeat(40), branch: "fix/security" });
    expect(adapter.pushBranch).toHaveBeenCalledWith("b".repeat(40), "fix/security");
    await find("git_revert").execute("5", { sha: "a".repeat(40) });
    expect(adapter.revert).toHaveBeenCalledWith("a".repeat(40));
  });

  it("serializes an empty result as a text string instead of undefined", () => {
    const result = text(undefined);
    expect(result.content).toEqual([{ type: "text", text: "null" }]);
  });

  it("returns an explicit result when there is nothing to commit or save", async () => {
    const adapter = fakeAdapter();
    adapter.commit = vi.fn(async () => undefined);
    adapter.push = vi.fn(async () => undefined);
    const registered = collect(adapter);
    const find = (name: string) => registered.find((tool) => tool.name === name)!;

    const commit = await find("git_commit").execute("1", { message: "noop" });
    expect(commit.content[0]?.text).toBe('{"committed":false,"reason":"no changes in the worktree"}');
    const push = await find("git_push").execute("2", {});
    expect(push.content[0]?.text).toBe('{"saved":false,"reason":"no changes in the worktree"}');
    expect(commit.content[0]?.text).toBeTypeOf("string");
    expect(push.content[0]?.text).toBeTypeOf("string");
  });
});
