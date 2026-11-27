import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDependencies } from "../../src/agent/web-read.ts";
import { fetchSourceArchive } from "../../src/agent/skill-sources.ts";

describe("skill source archives", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves remote hosts through the shared DNS dependency", async () => {
    // 返回私网地址让 SSRF 校验在发起网络请求前就中止；关键是断言复用了真实解析器。
    const resolve = vi.spyOn(defaultDependencies, "resolve")
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(fetchSourceArchive({ channel: "url", value: "https://example.com/skills.zip" }))
      .rejects.toThrow("does not resolve exclusively to public IP addresses");
    expect(resolve).toHaveBeenCalledWith("example.com");
  });
});
