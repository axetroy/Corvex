import type { GitLabBranch } from "../../../gitlab/client.js";
import { conversationScore, timeDecay } from "./project-ranking.js";

export interface BranchActivity {
  lastConversationAt: string;
  conversationCount: number;
}

export interface RankedBranch extends GitLabBranch {
  /** 0–100 的综合分，仅用于排序，不回显给前端。 */
  score: number;
}

function startsAtWordBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(haystack);
}

/** 分支名命中优先于提交标题；词边界优先于普通子串。 */
function similarityScore(branch: GitLabBranch, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const name = branch.name.toLowerCase();
  const title = (branch.commit.title ?? "").toLowerCase();
  let score: number;
  if (name === needle) score = 1;
  else if (name.startsWith(needle)) score = 0.9;
  else if (startsAtWordBoundary(name, needle)) score = 0.8;
  else if (name.includes(needle)) score = 0.65;
  else if (title.includes(needle)) score = 0.35;
  else score = 0;

  const tokens = needle.split(/[^a-z0-9\u0080-\uFFFF]+/).filter(Boolean);
  if (tokens.length > 1) {
    const matched = tokens.filter((token) => name.includes(token) || title.includes(token)).length;
    score = Math.min(1, score + 0.15 * matched);
  }
  return score;
}

/**
 * 分支排序：与仓库搜索同权重骨架——相似度主导，提交新鲜度与最近会话微调。
 * 同分按分支名稳定排序；分数不回显给前端。
 */
export function rankBranches(
  branches: readonly GitLabBranch[],
  query: string,
  activity: ReadonlyMap<string, BranchActivity>,
  now: number = Date.now(),
): RankedBranch[] {
  return branches
    .map((branch) => {
      const similarity = similarityScore(branch, query);
      const recency = timeDecay(branch.commit.committed_date, now);
      const conversations = conversationScore(activity.get(branch.name), now);
      const score = 55 * similarity + 25 * recency + 20 * conversations;
      return { ...branch, score: Math.round(score * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
