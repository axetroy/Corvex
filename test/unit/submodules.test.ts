import { describe, expect, it } from "vitest";
import {
  buildSubmodulePlan,
  classifySubmoduleUrl,
  isPrivateAddress,
  normalizeAllowedOrigin,
  parseGitmodules,
  parseSubmoduleHostTokens,
} from "../../src/git/submodules.js";

describe("submodule URL policy", () => {
  it("normalizes allowed origins and rejects paths", () => {
    expect(normalizeAllowedOrigin("git.example.com:8443")).toBe("https://git.example.com:8443");
    expect(normalizeAllowedOrigin("http://192.168.0.10:8080")).toBe("http://192.168.0.10:8080");
    expect(normalizeAllowedOrigin("https://git.example.com/base")).toBeUndefined();
    expect(normalizeAllowedOrigin("user@git.example.com")).toBeUndefined();
  });

  it("allows same-origin URLs with the user token and explicit third-party origins without it", () => {
    const policy = {
      gitlabOrigin: "https://xafg.qdzk3000.com:8092",
      allowedOrigins: new Set(["http://192.168.0.10:8080"]),
      hostTokens: new Map([["http://192.168.0.10:8080", "readonly-token"]]),
    };
    expect(classifySubmoduleUrl("http://192.168.0.10:8080/root/lib.git", policy.gitlabOrigin, policy)).toMatchObject({
      item: { sameOrigin: false, url: "http://192.168.0.10:8080/root/lib.git", token: "readonly-token" },
    });
    expect(classifySubmoduleUrl("https://xafg.qdzk3000.com:8092/group/lib.git", policy.gitlabOrigin, policy)).toMatchObject({
      item: { sameOrigin: true },
    });
    expect(classifySubmoduleUrl("http://127.0.0.1:8080/a/b.git", policy.gitlabOrigin, policy)).toMatchObject({ reason: "private" });
    expect(classifySubmoduleUrl("https://evil.example/a/b.git", policy.gitlabOrigin, policy)).toMatchObject({ reason: "origin" });
    expect(classifySubmoduleUrl("https://u:p@evil.example/a/b.git", policy.gitlabOrigin, policy)).toMatchObject({ reason: "credentials" });
    expect(classifySubmoduleUrl("ssh://git@evil.example/a/b.git", policy.gitlabOrigin, policy)).toMatchObject({ reason: "scheme" });
    expect(classifySubmoduleUrl("http://192.168.0.10:8080/%2e%2e/a.git", policy.gitlabOrigin, policy)).toMatchObject({ reason: "path" });
  });

  it("parses bounded .gitmodules and intersects it with gitlinks", () => {
    const modules = parseGitmodules(`
[submodule "brand"]
\tpath = brand
\turl = http://192.168.0.10:8080/root/customize.git
[submodule "stale"]
\tpath = src/vendor
\turl = http://192.168.0.10:8080/root/lib.git
`);
    const plan = buildSubmodulePlan(
      [{ path: "brand", sha: "a".repeat(40) }],
      modules,
      "https://xafg.qdzk3000.com:8092",
      {
        gitlabOrigin: "https://xafg.qdzk3000.com:8092",
        allowedOrigins: new Set(["http://192.168.0.10:8080"]),
        hostTokens: new Map(),
      },
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ path: "brand", url: "http://192.168.0.10:8080/root/customize.git" });
    expect(plan.skipped).toHaveLength(0);
  });

  it("validates dedicated token maps without echoing them", () => {
    const tokens = parseSubmoduleHostTokens('{"https://git.example.com":"secret"}');
    expect(tokens.get("https://git.example.com")).toBe("secret");
    expect(() => parseSubmoduleHostTokens('{"bad path":"x"}')).toThrow();
    expect(isPrivateAddress("192.168.0.10")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});
