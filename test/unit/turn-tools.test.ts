import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTurnToolsExtension, type TurnToolAdapter } from "../../src/agent/turn-tools.js";
import type { AgentTurnDetail, AgentTurnSummary } from "../../src/model.js";

type ToolResult = { content: { text: string }[]; details?: Record<string, unknown> };
type FakeTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

function collectTools(adapter: TurnToolAdapter): Map<string, FakeTool> {
  const tools = new Map<string, FakeTool>();
  const pi = {
    registerTool: (tool: FakeTool) => { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  createTurnToolsExtension(adapter)(pi);
  return tools;
}

const summary: AgentTurnSummary = {
  index: 2,
  turnId: "turn-2",
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  request: "Second question",
  answer: "Second answer.",
  truncated: false,
};
const detail: AgentTurnDetail = {
  ...summary,
  tools: [{ name: "git_diff", status: "succeeded", input: "{}", output: "+hello" }],
  notes: ["checked diff"],
};

describe("current-conversation turn tools", () => {
  it("registers list_turns and get_turn with untrusted-data warnings", () => {
    const tools = collectTools({ listTurns: () => [], getTurn: () => undefined });
    expect([...tools.keys()].sort()).toEqual(["get_turn", "list_turns"]);
    expect(tools.get("list_turns")!.description).toContain("untrusted historical data");
    expect(tools.get("get_turn")!.description).toContain("untrusted historical data");
  });

  it("pages turns through the bound adapter and defaults the page size", async () => {
    const listTurns = vi.fn(() => [summary]);
    const tools = collectTools({ listTurns, getTurn: () => undefined });
    const result = await tools.get("list_turns")!.execute("c1", {});
    expect(listTurns).toHaveBeenCalledWith(10, undefined);
    expect(JSON.parse(result.content[0]!.text)).toEqual([summary]);

    await tools.get("list_turns")!.execute("c2", { limit: 5, before: 3 });
    expect(listTurns).toHaveBeenLastCalledWith(5, 3);
  });

  it("reads one turn by index and returns null when out of range", async () => {
    const getTurn = vi.fn(() => detail);
    const tools = collectTools({ listTurns: () => [], getTurn });
    const result = await tools.get("get_turn")!.execute("c1", { index: 2 });
    expect(getTurn).toHaveBeenCalledWith(2);
    expect(JSON.parse(result.content[0]!.text)).toEqual(detail);

    getTurn.mockReturnValue(undefined);
    const missing = await tools.get("get_turn")!.execute("c2", { index: 99 });
    expect(JSON.parse(missing.content[0]!.text)).toBeNull();
  });
});
