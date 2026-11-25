import type { GitGraphNode } from "../../../git/types.js";

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
  /** 父提交被筛选掉时，连到下一个可见提交的「省略连线」。 */
  implicit?: boolean;
}

export interface GitGraphLayout {
  nodes: GraphLaneNode[];
  edges: GraphEdge[];
  laneCount: number;
  width: number;
  height: number;
}

/**
 * 提交图谱布局：按 rev-list 的拓扑顺序分配泳道。
 *
 * 一个提交可能同时被多条分支当作父提交；先遇到的分支会先给它分配泳道，这会让
 * 侧支「抢走」主线的延续，视觉上表现为汇合点处主线跳到旁边、侧支反而留在中间。
 * 因此这里记录每条分支已落位的提交数作为权重：提交数更多的分支在争夺同一个父
 * 提交时获胜，保证主线连续。最后按权重重排泳道编号，让主线始终排在最左侧。
 */
export function buildGitGraphLayout(nodes: readonly GitGraphNode[], pinnedSha = ""): GitGraphLayout {
  const present = new Set(nodes.map((node) => node.sha));
  const laneOf = new Map<string, number>();
  const claimWeight = new Map<string, number>();
  const laneWeight: number[] = [];
  let nextLane = 0;
  const newLane = () => {
    const lane = nextLane++;
    laneWeight[lane] = 0;
    return lane;
  };

  const laidOut = nodes.map((node, row) => {
    let lane = laneOf.get(node.sha);
    if (lane === undefined) lane = newLane();
    laneWeight[lane] = (laneWeight[lane] ?? 0) + 1;
    const ownWeight = laneWeight[lane];

    node.parents.forEach((parent, index) => {
      if (!present.has(parent)) return;
      // 第二父提交已有泳道时沿用，不另开泳道。
      if (index > 0 && laneOf.has(parent)) return;
      const proposed = index === 0 ? lane! : newLane();
      const weight = index === 0 ? ownWeight : 0;
      const previous = claimWeight.get(parent);
      if (previous === undefined || weight > previous) {
        laneOf.set(parent, proposed);
        claimWeight.set(parent, weight);
      }
    });

    return {
      ...node,
      lane: lane!,
      row,
      isPinned: Boolean(pinnedSha) && node.sha === pinnedSha,
      hasLocalRef: node.refs.some((ref) => ref.startsWith("conversations/")),
    };
  });

  // 主线（权重最高的泳道）排在最左，侧支依次向右。
  const orderedLanes = laneWeight
    .map((weight, lane) => ({ lane, weight }))
    .sort((a, b) => b.weight - a.weight || a.lane - b.lane)
    .map(({ lane }) => lane);
  const laneIndex = new Map(orderedLanes.map((lane, index) => [lane, index]));
  const remap = (lane: number) => laneIndex.get(lane) ?? lane;
  for (const node of laidOut) node.lane = remap(node.lane);

  const edges: GraphEdge[] = [];
  for (const node of laidOut) {
    const visibleParents = node.parents.filter((parent) => laneOf.has(parent));
    if (visibleParents.length) {
      for (const parent of visibleParents) {
        edges.push({
          from: node.sha,
          to: parent,
          lane: node.lane,
          targetLane: remap(laneOf.get(parent)!),
          row: node.row,
        });
      }
      continue;
    }
    // 全部父提交都被筛选掉时，连到下一个可见提交，用虚线表示中间省略的历史。
    const next = laidOut[node.row + 1];
    if (next) {
      edges.push({
        from: node.sha,
        to: next.sha,
        lane: node.lane,
        targetLane: next.lane,
        row: node.row,
        implicit: true,
      });
    }
  }

  const laneCount = Math.max(1, orderedLanes.length);
  return {
    nodes: laidOut,
    edges,
    laneCount,
    width: graphPadding * 2 + laneCount * graphLaneWidth,
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
