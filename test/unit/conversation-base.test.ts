import { describe, expect, it } from "vitest";
import { resolveTurnBaseSha } from "../../src/app/conversation-base.js";

describe("conversation sync base", () => {
  const base = "a".repeat(40);
  const remote = "b".repeat(40);

  it("跟随远端快照：没有未发布改动时基线前进", () => {
    expect(resolveTurnBaseSha(base, remote, false)).toBe(remote);
  });

  it("保留原基线：本地还有未发布改动，不能把改动变成游离提交", () => {
    expect(resolveTurnBaseSha(base, remote, true)).toBe(base);
  });

  it("旧库没有基线时回落到轮次快照", () => {
    expect(resolveTurnBaseSha("", remote, true)).toBe(remote);
  });
});
