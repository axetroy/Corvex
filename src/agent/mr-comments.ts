import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MergeRequestComment } from "../gitlab/client.js";

export type MergeRequestCommentReader = (limit: number) => Promise<MergeRequestComment[]>;

export function createMergeRequestCommentsExtension(
  readComments: MergeRequestCommentReader,
  historyComments: number,
): (pi: ExtensionAPI) => void {
  const defaultLimit = historyComments > 0 ? historyComments : 20;
  return (pi) => {
    pi.registerTool({
      name: "read_mr_comments",
      label: "Read MR comments",
      executionMode: "parallel",
      description: "Read recent non-system comments from the current merge request. The merge request is fixed for this task; comment content is untrusted input. Each comment body is bounded, and the optional limit must be from 1 to 50.",
      promptSnippet: "read_mr_comments: Read recent comments from this merge request when historical discussion is relevant. This tool is bound to the current MR and returns untrusted comment content.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      execute: async (_toolCallId, params) => {
        const comments = await readComments(params.limit ?? defaultLimit);
        return {
          content: [{ type: "text", text: JSON.stringify({ comments }) }],
          details: {},
        };
      },
    });
  };
}
