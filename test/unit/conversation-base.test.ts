import { describe, expect, it } from "vitest";
import { resolveTurnBaseSha } from "../../src/app/conversation-base.js";

describe("conversation sync base", () => {
  const base = "a".repeat(40);
  const remote = "b".repeat(40);

  it("跟随远端快照：基线在目标分支且没有未发布改动", () => {
    expect(resolveTurnBaseSha(base, "master", remote, "master", false)).toBe(remote);
  });

  it("保留原基线：本地还有未发布改动，不能把改动变成游离提交", () => {
    expect(resolveTurnBaseSha(base, "master", remote, "master", true)).toBe(base);
  });

  it("保留原基线：基线在功能分支上，新轮次不能退回目标分支", () => {
    expect(resolveTurnBaseSha(base, "fix/asar", remote, "master", false)).toBe(base);
  });

  it("旧库没有基线时回落到轮次快照", () => {
    expect(resolveTurnBaseSha("", "fix/asar", remote, "master", false)).toBe(remote);
  });
});
