import type { GitGraphNode } from "../../git/types.js";

export const graphRowHeight = 34;
export const graphLaneWidth = 18;
export const graphPadding = 16;

export interface GraphLaneNode extends GitGraphNode {
  lane: number;
  row: number;
  isPinned: boolean;
  hasLocalRef: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  lane: number;
  targetLane: number;
  row: number;
}

export interface GitGraphLayout {
  nodes: GraphLaneNode[];
  edges: GraphEdge[];
  laneCount: number;
  width: number;
  height: number;
}

/**
 * 提交图谱布局：按 rev-list 给出的拓扑顺序分配泳道。
 * 当前节点复用已分配泳道，第一父提交继承该泳道，其余父提交分配新泳道；
 * 不在本页的节点不连线，由上层分页继续获取。
 */
export function buildGitGraphLayout(nodes: readonly GitGraphNode[], pinnedSha = ""): GitGraphLayout {
  const present = new Set(nodes.map((node) => node.sha));
  const laneOf = new Map<string, number>();
  let nextLane = 0;

  const laidOut = nodes.map((node, row) => {
    let lane = laneOf.get(node.sha);
    if (lane === undefined) {
      lane = nextLane++;
      laneOf.set(node.sha, lane);
    }
    node.parents.forEach((parent, index) => {
      if (!present.has(parent) || laneOf.has(parent)) return;
      laneOf.set(parent, index === 0 ? lane! : nextLane++);
    });
    return {
      ...node,
      lane: lane!,
      row,
      isPinned: Boolean(pinnedSha) && node.sha === pinnedSha,
      hasLocalRef: node.refs.some((ref) => ref.startsWith("conversations/")),
    };
  });

  const edges: GraphEdge[] = [];
  for (const node of laidOut) {
    for (const parent of node.parents) {
      const targetLane = laneOf.get(parent);
      if (targetLane === undefined) continue;
      edges.push({ from: node.sha, to: parent, lane: node.lane, targetLane, row: node.row });
    }
  }

  return {
    nodes: laidOut,
    edges,
    laneCount: Math.max(1, nextLane),
    width: graphPadding * 2 + Math.max(1, nextLane) * graphLaneWidth,
    height: graphPadding * 2 + nodes.length * graphRowHeight,
  };
}

/** 节点所在行的纵坐标（圆心）。 */
export function graphNodeY(row: number): number {
  return graphPadding + row * graphRowHeight + graphRowHeight / 2;
}

/** 泳道对应的横坐标（圆心）。 */
export function graphLaneX(lane: number): number {
  return graphPadding + lane * graphLaneWidth + graphLaneWidth / 2;
}
