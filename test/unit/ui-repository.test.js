import { describe, expect, it } from "vitest";
import { safeRepositoryUrl } from "../../src/app/ui/components/RepositoryInfoDrawer.tsx";

describe("repository info link", () => {
  it("keeps http(s) URLs from GitLab", () => {
    expect(safeRepositoryUrl("https://gitlab.example.com/group/project")).toBe("https://gitlab.example.com/group/project");
    expect(safeRepositoryUrl("http://192.168.0.69:8092/group/project")).toBe("http://192.168.0.69:8092/group/project");
  });

  it("drops empty, malformed and non-http URLs", () => {
    expect(safeRepositoryUrl("")).toBeUndefined();
    expect(safeRepositoryUrl(null)).toBeUndefined();
    expect(safeRepositoryUrl("not a url")).toBeUndefined();
    expect(safeRepositoryUrl("javascript:alert(1)")).toBeUndefined();
  });
});
