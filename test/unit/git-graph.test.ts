import { describe, expect, it } from "vitest";
import { buildGitGraphLayout, graphLaneX, graphNodeY } from "../../src/app/ui/gitGraph.ts";
import type { GitGraphNode } from "../../src/git/types.ts";

function node(sha: string, parents: string[] = [], refs: string[] = []): GitGraphNode {
  return { sha, parents, refs, tags: [], subject: sha.slice(0, 8), author: "dev", authoredAt: "2026-01-01T00:00:00Z" };
}

describe("git graph layout", () => {
  it("keeps a linear history in one lane", () => {
    const layout = buildGitGraphLayout([node("c", ["b"]), node("b", ["a"]), node("a")]);
    expect(layout.nodes.map((item) => item.lane)).toEqual([0, 0, 0]);
    expect(layout.edges).toHaveLength(2);
    expect(layout.laneCount).toBe(1);
  });

  it("gives merge parents their own lanes and draws edges to them", () => {
    const layout = buildGitGraphLayout([
      node("merge", ["base", "feature"]),
      node("feature", ["base"]),
      node("base"),
    ]);
    expect(layout.nodes[0]?.lane).toBe(0);
    expect(layout.nodes[1]?.lane).toBe(1);
    expect(layout.edges).toContainEqual({ from: "merge", to: "feature", lane: 0, targetLane: 1, row: 0 });
    expect(layout.edges).toContainEqual({ from: "feature", to: "base", lane: 1, targetLane: 0, row: 1 });
    expect(layout.laneCount).toBe(2);
  });

  it("keeps the busiest branch continuous through a convergence", () => {
    const layout = buildGitGraphLayout([
      node("side2", ["side1"]),
      node("side1", ["join"]),
      node("main3", ["main2"]),
      node("main2", ["main1"]),
      node("main1", ["join"]),
      node("join", ["root"]),
      node("root"),
    ]);
    const bySha = new Map(layout.nodes.map((item) => [item.sha, item]));
    // 主线在汇合点保持同一条泳道，并且排在最左侧。
    expect(bySha.get("main3")?.lane).toBe(0);
    expect(bySha.get("main1")?.lane).toBe(0);
    expect(bySha.get("join")?.lane).toBe(0);
    expect(bySha.get("root")?.lane).toBe(0);
    // 先出现但较短的侧支移到右侧，汇入主线。
    expect(bySha.get("side1")?.lane).toBe(1);
    expect(layout.edges).toContainEqual({ from: "side1", to: "join", lane: 1, targetLane: 0, row: 1 });
  });

  it("marks the pinned snapshot and conversation-only refs", () => {
    const layout = buildGitGraphLayout([
      node("a".repeat(40), [], ["conversations/c1"]),
      node("b".repeat(40)),
    ], "a".repeat(40));
    expect(layout.nodes[0]?.isPinned).toBe(true);
    expect(layout.nodes[0]?.hasLocalRef).toBe(true);
    expect(layout.nodes[1]?.isPinned).toBe(false);
  });

  it("ignores parents outside the current page unless another commit follows", () => {
    const layout = buildGitGraphLayout([node("new", ["missing"])]);
    expect(layout.edges).toEqual([]);
    expect(layout.laneCount).toBe(1);
  });

  it("connects filtered-out parents with a dashed edge to the next visible commit", () => {
    const layout = buildGitGraphLayout([node("a", ["hidden-a"]), node("b", ["hidden-b"]), node("c")]);
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges[0]).toMatchObject({ from: "a", to: "b", implicit: true });
    expect(layout.edges[1]).toMatchObject({ from: "b", to: "c", implicit: true });
  });

  it("provides stable coordinates", () => {
    expect(graphLaneX(0)).toBeLessThan(graphLaneX(1));
    expect(graphNodeY(0)).toBeLessThan(graphNodeY(1));
  });
});
