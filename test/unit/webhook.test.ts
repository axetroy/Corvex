import { describe, expect, it } from "vitest";
import {
  decodeNoteEvent,
  MAX_WEBHOOK_BODY_BYTES,
  validateWebhookToken,
} from "../../src/gitlab/webhook.js";

const event = {
  object_kind: "note",
  user: { id: 2, username: "developer" },
  project: { id: 1 },
  object_attributes: {
    id: 3,
    note: "@corvex review",
    noteable_type: "MergeRequest",
    system: false,
  },
  merge_request: { iid: 4, last_commit: { id: "a".repeat(40) } },
};

describe("GitLab webhook validation", () => {
  it("compares non-empty tokens and rejects a different length", () => {
    expect(validateWebhookToken("secret", "secret")).toBe(true);
    expect(validateWebhookToken("secret", "secrets")).toBe(false);
    expect(validateWebhookToken("", "secret")).toBe(false);
  });

  it("decodes a complete merge request note event", () => {
    expect(decodeNoteEvent(Buffer.from(JSON.stringify(event)))).toEqual(event);
  });

  it("rejects malformed, unsupported, and oversized events", () => {
    expect(() => decodeNoteEvent(Buffer.from("{"))).toThrow("decode GitLab note event");
    expect(() =>
      decodeNoteEvent(Buffer.from(JSON.stringify({ ...event, object_kind: "push" }))),
    ).toThrow("incomplete or unsupported");
    expect(() => decodeNoteEvent(Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1))).toThrow("exceeds 1 MiB");
  });
});
