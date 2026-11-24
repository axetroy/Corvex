import { describe, expect, it } from "vitest";
import { buildToolEvidence, resultText, type ToolEvidenceEntry } from "../../src/agent/tool-evidence.js";

function entry(turnId: string, name: string, status: string, input: string, output: string): ToolEvidenceEntry {
  return { turnId, name, status, input, output, error: status === "failed" ? output : null };
}

describe("tool evidence", () => {
  it("extracts the text of a wrapped tool result", () => {
    const wrapped = JSON.stringify({ content: [{ type: "text", text: "  hello\nworld  " }] });
    expect(resultText(wrapped, 100)).toBe("hello world");
    expect(resultText("plain text", 100)).toBe("plain text");
    expect(resultText("abcdef", 3)).toBe("abc…");
  });

  it("groups tool calls by turn and shows status and results", () => {
    const text = buildToolEvidence([
      entry("turn-1", "create_merge_request", "succeeded", '{"iid":2}', JSON.stringify({ content: [{ type: "text", text: '{"iid":2,"webUrl":"http://gitlab/mr/2"}' }] })),
      entry("turn-1", "post_mr_note", "failed", '{"iid":2}', "403 Forbidden"),
      entry("turn-2", "git_publish", "succeeded", '{"branch":"fix"}', '{"branch":"fix","sha":"abc"}'),
    ]);
    expect(text).toContain("turn turn-1");
    expect(text).toContain("create_merge_request");
    expect(text).toContain("webUrl");
    expect(text).toContain("post_mr_note");
    expect(text).toContain("failed 403 Forbidden");
    expect(text).toContain("git_publish");
  });

  it("marks an empty record explicitly", () => {
    expect(buildToolEvidence([])).toContain("no tool calls are recorded");
  });

  it("caps turns, tools per turn and total characters", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      entry(`turn-${index}`, "read_file", "succeeded", '{"path":"a"}', "x".repeat(500)),
    );
    const text = buildToolEvidence(many, { maxTurns: 3, maxToolsPerTurn: 2, totalChars: 300 });
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(1_400);
    expect((text.match(/turn turn-/g) ?? []).length).toBeLessThanOrEqual(3);
  });
});
