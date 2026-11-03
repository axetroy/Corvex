import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMergeRequestMetadataExtension } from "../../src/agent/mr-update.js";

describe("merge request metadata tool", () => {
  it("updates only supplied fields for its bound MR and returns a receipt", async () => {
    const updateMetadata = vi.fn(async (fields: { title?: string; description?: string }) => ({
      status: 200,
      resourceId: 42,
      fields,
    }));
    let tool: {
      parameters: unknown;
      execute: (...args: unknown[]) => Promise<unknown>;
    } | undefined;
    createMergeRequestMetadataExtension(updateMetadata)({
      registerTool: (registered: typeof tool) => { tool = registered; },
    } as unknown as ExtensionAPI);
    if (!tool) throw new Error("MR metadata tool was not registered");

    await expect(tool.execute("call-1", { description: "" })).resolves.toMatchObject({
      content: [{ text: expect.stringContaining('"status":200') }],
    });
    expect(updateMetadata).toHaveBeenCalledWith({ description: "" });
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toMatch(/title/u);
    expect(schema).toMatch(/description/u);
    expect(schema).not.toMatch(/projectId|mrIid|mergeRequestId|url|path/u);

    await expect(tool.execute("call-2", {})).rejects.toThrow("at least one");
  });
});
