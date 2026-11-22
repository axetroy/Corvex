import { describe, expect, it } from "vitest";
import { operationsUiAsset } from "../../src/app/http/operations-ui.ts";

describe("ops console asset whitelist", () => {
  it("serves the Monaco codicon font emitted by Vite", () => {
    expect(operationsUiAsset("assets/codicon-DF1abBS2.ttf")).toEqual({
      file: "assets/codicon-DF1abBS2.ttf",
      contentType: "font/ttf",
    });
    expect(operationsUiAsset("assets/index-abc.js")?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("still rejects traversal and unsupported extensions", () => {
    expect(operationsUiAsset("../index.html")).toBeUndefined();
    expect(operationsUiAsset("assets/secret.exe")).toBeUndefined();
    expect(operationsUiAsset("assets/name with space.ttf")).toBeUndefined();
  });
});
