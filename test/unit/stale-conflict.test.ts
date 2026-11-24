import { describe, expect, it } from "vitest";
import { buildStaleConflictNote } from "../../src/app/stale-conflict.js";

describe("stale conflict note", () => {
  const expected = "a".repeat(40);
  const actual = "b".repeat(40);

  it("points at the exact commit and author that moved the branch", () => {
    const note = buildStaleConflictNote(expected, actual, "main", {
      authorName: "alice",
      title: "fix: parser",
      committedDate: "2026-11-24T00:00:00Z",
    });
    expect(note.traceName).toBe("stale.branch_conflict");
    expect(JSON.parse(note.input)).toEqual({ expectedSha: expected, actualSha: actual, branch: "main" });
    expect(JSON.parse(note.output)).toMatchObject({
      actualSha: actual,
      authorName: "alice",
      title: "fix: parser",
    });
    expect(note.message).toContain("alice");
    expect(note.message).toContain("fix: parser");
    expect(note.message).toContain(actual.slice(0, 12));
  });

  it("keeps the branch title when the commit lookup fails", () => {
    const note = buildStaleConflictNote(expected, actual, "main", {
      title: "fallback title",
      lookupError: "403 Forbidden",
    });
    expect(JSON.parse(note.output)).toMatchObject({ title: "fallback title", lookupError: "403 Forbidden" });
    expect(note.message).toContain("fallback title");
    expect(note.message).toContain("403 Forbidden");
  });
});
