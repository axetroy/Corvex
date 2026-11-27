import { describe, expect, it } from "vitest";
import { boundSessionEntries, stripImageContent, type SessionEntryLike } from "../../src/agent/session-persistence.js";

const header: SessionEntryLike = { type: "session", id: "h", timestamp: "t", cwd: "/tmp" };
const message = (id: string, size: number, parentId: string | null = null): SessionEntryLike => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: "x".repeat(size) },
});

describe("image content stripping", () => {
  it("replaces image blocks with a placeholder without mutating the original entries", () => {
    const entries: SessionEntryLike[] = [{
      type: "message", id: "m1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
      },
    }];
    const stripped = stripImageContent(entries);
    expect(stripped[0]!.message.content).toEqual([
      { type: "text", text: "look" },
      { type: "text", text: "[image omitted]" },
    ]);
    expect(JSON.stringify(stripped)).not.toContain("QUJD");
    expect((entries[0]!.message as { content: unknown[] }).content[1]).toMatchObject({ type: "image" });
  });
});

describe("bounded session persistence", () => {
  it("keeps everything when the payload fits", () => {
    const branch = [message("a", 100), message("b", 100, "a")];
    const result = boundSessionEntries(header, branch, 10_000);
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(3);
  });

  it("drops the prefix before a compaction checkpoint first", () => {
    const branch = [
      message("a", 2_000),
      { type: "compaction", id: "c", parentId: "a", summary: "old context" } as SessionEntryLike,
      message("b", 200, "c"),
    ];
    const result = boundSessionEntries(header, branch, 1_200);
    expect(result.truncated).toBe(true);
    expect(result.entries.some((entry) => entry.type === "compaction")).toBe(true);
    expect(result.entries.some((entry) => entry.id === "a")).toBe(false);
    expect(result.entries.some((entry) => entry.id === "b")).toBe(true);
  });

  it("drops from the recent tail when even the retained segment is too large", () => {
    const branch = [
      { type: "compaction", id: "c", parentId: null, summary: "s" } as SessionEntryLike,
      message("a", 300, "c"),
      message("b", 300, "a"),
      message("d", 300, "b"),
    ];
    const result = boundSessionEntries(header, branch, 800);
    expect(result.truncated).toBe(true);
    expect(result.entries.some((entry) => entry.type === "compaction")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.entries))).toBeLessThanOrEqual(800);
  });

  it("returns nothing when a single entry cannot fit", () => {
    const result = boundSessionEntries(header, [message("big", 5_000)], 500);
    expect(result.entries).toEqual([]);
  });

  it("keeps the contiguous parent chain of the surviving segment", () => {
    const branch = [message("a", 400), message("b", 400, "a"), message("d", 400, "b")];
    const result = boundSessionEntries(header, branch, 1_300);
    const kept = result.entries.filter((entry) => entry.type !== "session");
    for (let index = 1; index < kept.length; index += 1) {
      expect(kept[index]!.parentId).toBe(kept[index - 1]!.id);
    }
  });
});
