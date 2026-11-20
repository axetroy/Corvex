import { describe, expect, it } from "vitest";
import { conversationCapabilities, isConversationMode } from "../../src/events/model.ts";

describe("conversation modes", () => {
  it("recognizes the GitLab collaboration mode", () => {
    expect(isConversationMode("read_only")).toBe(true);
    expect(isConversationMode("gitlab")).toBe(true);
    expect(isConversationMode("unknown")).toBe(false);
  });

  it("grants GitLab writes only in collaboration mode", () => {
    expect(conversationCapabilities("read_only")).toMatchObject({ repositoryWrite: false, gitlabWrite: false });
    expect(conversationCapabilities("gitlab")).toMatchObject({ repositoryWrite: false, gitlabWrite: true });
  });
});
