import { describe, expect, it } from "vitest";
import type { GitLabBranch } from "../../src/gitlab/client.js";
import { rankBranches } from "../../src/app/http/ops/branch-ranking.js";

const now = Date.parse("2026-11-27T12:00:00.000Z");
const sha = "a".repeat(40);

function branch(name: string, committedDate: string, title = ""): GitLabBranch {
  return { name, commit: { id: sha, committed_date: committedDate, title } };
}

describe("rankBranches", () => {
  it("puts query similarity ahead of commit recency", () => {
    const ranked = rankBranches([
      branch("main", "2026-11-27T11:59:00.000Z"),
      branch("feature/im-login", "2026-01-01T00:00:00.000Z"),
    ], "im", new Map(), now);
    expect(ranked[0]!.name).toBe("feature/im-login");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("uses commit recency and recent conversations as tie breakers", () => {
    const sameName = [
      branch("feature/a", "2026-11-27T11:00:00.000Z"),
      branch("feature/b", "2026-11-01T00:00:00.000Z"),
      branch("feature/c", "2026-11-01T00:00:00.000Z"),
    ];
    const activity = new Map([["feature/c", { lastConversationAt: "2026-11-27T10:00:00.000Z", conversationCount: 3 }]]);
    const ranked = rankBranches(sameName, "feature", activity, now);
    // c 的提交较旧，但最近会话活跃度抵消后仍高于只有新鲜提交的 a。
    expect(ranked.map((item) => item.name)).toEqual(["feature/c", "feature/a", "feature/b"]);
  });

  it("matches commit titles below branch names and tokenizes multi-word queries", () => {
    const ranked = rankBranches([
      branch("release/1.0", "2026-11-27T11:00:00.000Z", "fix im login flow"),
      branch("hotfix", "2026-11-01T00:00:00.000Z", "unrelated"),
    ], "im login", new Map(), now);
    expect(ranked[0]!.name).toBe("release/1.0");
  });

  it("falls back to a stable name order for equal scores", () => {
    const ranked = rankBranches([
      branch("z", "2026-01-01T00:00:00.000Z"),
      branch("a", "2026-01-01T00:00:00.000Z"),
    ], "", new Map(), now);
    expect(ranked.map((item) => item.name)).toEqual(["a", "z"]);
  });
});
