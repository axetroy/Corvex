import { describe, expect, it } from "vitest";
import { contextSegmentKey, mergeContextNotice } from "../../src/app/ui/lib/conversationTimelineMerge.js";

interface Segment { kind: string; key: string; text: string; count?: number }
const make = (key: string, text: string): Segment => ({ kind: "context", key, text });

describe("conversation notice merging", () => {
  it("shares one segment for all microcompact notices", () => {
    expect(contextSegmentKey("microcompact-a,b")).toBe("microcompact");
    expect(contextSegmentKey("context.compact")).toBe("context-context.compact");
  });

  it("keeps one entry with a repeat count instead of flooding the timeline", () => {
    const segments: Segment[] = [{ kind: "thinking", key: "thinking-0", text: "..." }];
    mergeContextNotice(segments, "microcompact-a", "first", make);
    mergeContextNotice(segments, "microcompact-b", "second", make);
    mergeContextNotice(segments, "microcompact-c", "third", make);
    expect(segments).toHaveLength(2);
    expect(segments[1]).toMatchObject({ key: "microcompact", text: "third", count: 3 });
  });

  it("keeps unrelated context notices separate", () => {
    const segments: Segment[] = [];
    mergeContextNotice(segments, "context.compact", "compacted", make);
    mergeContextNotice(segments, "context.trim", "trimmed", make);
    expect(segments.map((segment) => segment.key)).toEqual(["context-context.compact", "context-context.trim"]);
  });
});
