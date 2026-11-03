import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitLabWriteReceipt, MergeRequestMetadataUpdate } from "../gitlab/client.js";

export type MergeRequestMetadataUpdater = (
  update: MergeRequestMetadataUpdate,
) => Promise<GitLabWriteReceipt>;

export function createMergeRequestMetadataExtension(
  updateMetadata: MergeRequestMetadataUpdater,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "update_mr_metadata",
      label: "Update MR title or description",
      executionMode: "sequential",
      description: "Update the title and/or description of the current merge request. Use only when the user explicitly asks to change MR metadata. Omitted fields remain unchanged; an empty description clears it. This tool is bound to the current MR.",
      promptSnippet: "update_mr_metadata: Change only the current MR title and/or description when the user explicitly requests it. Omit fields that should remain unchanged.",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
        description: Type.Optional(Type.String({ maxLength: 100_000 })),
      }),
      execute: async (_toolCallId, params) => {
        const update: MergeRequestMetadataUpdate = {};
        if (params.title !== undefined) update.title = params.title;
        if (params.description !== undefined) update.description = params.description;
        if (Object.keys(update).length === 0) {
          throw new Error("at least one MR title or description field must be provided");
        }
        const receipt = await updateMetadata(update);
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          details: {},
        };
      },
    });
  };
}
