import { describe, expect, it, vi } from "vitest";
import { GitToolBudgetExceededError, withGitToolBudget } from "../../src/agent/git/budget.js";
import type { GitToolAdapter } from "../../src/agent/git/common.js";

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
    sync: vi.fn(async () => ({ projectId: 7, branches: ["main"] })),
    merge: vi.fn(async () => ({ sha: "b".repeat(40), ref: "main" })),
    commit: vi.fn(async () => ({ sha: "b".repeat(40), paths: ["a.ts"] })),
    push: vi.fn(async () => ({ ref: "refs/conversations/c1", sha: "b".repeat(40) })),
    pushBranch: vi.fn(async () => ({ branch: "fix", sha: "b".repeat(40) })),
    publish: vi.fn(async () => ({ branch: "fix", sha: "b".repeat(40), committed: true })),
    revert: vi.fn(async () => ({ sha: "c".repeat(40), revertedSha: "b".repeat(40) })),
    rebase: vi.fn(async () => ({ sha: "c".repeat(40), onto: "origin/main" })),
    cherryPick: vi.fn(async () => ({ sha: "c".repeat(40), pickedSha: "b".repeat(40) })),
  };
}

describe("Git tool call budget", () => {
  it("shares one budget across all Git tools and forces a report once exhausted", async () => {
    const adapter = fakeAdapter();
    const guarded = withGitToolBudget(adapter, 2);

    await guarded.status();
    await guarded.pull();
    expect(adapter.status).toHaveBeenCalledOnce();
    expect(adapter.pull).toHaveBeenCalledOnce();

    await expect(guarded.merge("main")).rejects.toBeInstanceOf(GitToolBudgetExceededError);
    await expect(guarded.commit("again")).rejects.toThrow("Stop calling Git tools now");
    // 预算耗尽后底层实现完全不再被调用。
    expect(adapter.merge).not.toHaveBeenCalled();
    expect(adapter.commit).not.toHaveBeenCalled();
  });

  it("counts failed calls toward the budget", async () => {
    const adapter = fakeAdapter();
    vi.mocked(adapter.pushBranch).mockRejectedValueOnce(new Error("non-fast-forward"));
    const guarded = withGitToolBudget(adapter, 2);

    await expect(guarded.pushBranch("a".repeat(40), "fix")).rejects.toThrow("non-fast-forward");
    await guarded.sync();
    await expect(guarded.publish("fix")).rejects.toBeInstanceOf(GitToolBudgetExceededError);
    expect(adapter.publish).not.toHaveBeenCalled();
  });

  it("treats 0 and invalid limits as unlimited", async () => {
    for (const limit of [0, -1, Number.NaN]) {
      const adapter = fakeAdapter();
      const guarded = withGitToolBudget(adapter, limit);
      for (let index = 0; index < 50; index += 1) await guarded.status();
      expect(adapter.status).toHaveBeenCalledTimes(50);
    }
  });
});
