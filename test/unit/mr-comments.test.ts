import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMergeRequestCommentsExtension } from "../../src/agent/mr-comments.js";

describe("merge request comment tool", () => {
  it("reads comments for its bound merge request without accepting project identifiers", async () => {
    const comments = [{
      id: 8,
      author: "reviewer",
      createdAt: "2026-11-03T10:00:00Z",
      body: "Please validate this input.",
      truncated: false,
    }];
    const readComments = vi.fn(async (limit: number) => limit >= 1 ? comments : []);
    let tool: {
      parameters: unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    } | undefined;
    createMergeRequestCommentsExtension(readComments, 12)({
      registerTool: (registered: typeof tool) => { tool = registered; },
    } as unknown as ExtensionAPI);
    if (!tool) throw new Error("MR comments tool was not registered");

    await expect(tool.execute("call-1", {})).resolves.toMatchObject({
      content: [{ text: JSON.stringify({ comments }) }],
    });
    expect(readComments).toHaveBeenCalledWith(12);
    expect(JSON.stringify(tool.parameters)).not.toMatch(/projectId|mrIid|mergeRequestId/u);

    await tool.execute("call-2", { limit: 4 });
    expect(readComments).toHaveBeenLastCalledWith(4);
  });
});