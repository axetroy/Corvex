import type { Project } from "../../../gitlab/client.js";

export interface ProjectActivity {
  lastConversationAt: string;
  conversationCount: number;
}

export interface RankedProject extends Project {
  /** 0–100 的综合分，仅用于排序，不回显给用户。 */
  score: number;
}

/** 把搜索词与路径里的分隔符都当作词边界。 */
function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9\u0080-\uFFFF]+/).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 查询词出现在词边界（如 cloudoc_im_pc 里的 im）时关联度比普通子串更高。 */
function startsAtWordBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}`, "i").test(haystack);
}

function similarityScore(project: Project, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const name = (project.name ?? "").toLowerCase();
  const path = (project.path_with_namespace ?? "").toLowerCase();
  const description = (project.description ?? "").toLowerCase();

  let score: number;
  if (path === needle || name === needle) score = 1;
  else if (path.startsWith(needle) || name.startsWith(needle)) score = 0.9;
  else if (startsAtWordBoundary(path, needle) || startsAtWordBoundary(name, needle)) score = 0.8;
  else if (path.includes(needle) || name.includes(needle)) score = 0.65;
  else if (description.includes(needle)) score = 0.35;
  else score = 0;

  // 多词查询（如 "cloudoc im"）按命中比例加分，避免只匹配其中一个词的项目排太前。
  const tokens = tokenize(needle);
  if (tokens.length > 1) {
    const matched = tokens.filter((token) => path.includes(token) || name.includes(token) || description.includes(token)).length;
    score = Math.min(1, score + 0.15 * matched);
  }
  return score;
}

function timeDecay(iso: string | undefined, now: number, halfLifeDays = 30): number {
  if (!iso) return 0;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return 0;
  const days = (now - timestamp) / 86_400_000;
  if (days < 0) return 0;
  if (days <= 7) return 1;
  if (days <= 30) return 0.8;
  if (days <= 90) return 0.5;
  if (days <= 365) return 0.2;
  // 一年以上按半衰期平滑衰减，最低保留一点区分度。
  return Math.max(0.02, 0.2 * Math.exp(-(days - 365) / (halfLifeDays * 10)));
}

function conversationScore(activity: ProjectActivity | undefined, now: number): number {
  if (!activity) return 0;
  const recency = timeDecay(activity.lastConversationAt, now);
  const volume = Math.min(activity.conversationCount / 10, 1);
  return 0.7 * recency + 0.3 * volume;
}

/**
 * 搜索结果排序：相似度主导，项目活跃度与最近会话只做微调。
 * 归档项目降到末尾；同分时按仓库路径稳定排序。
 */
export function rankProjects(
  projects: readonly Project[],
  query: string,
  activity: ReadonlyMap<number, ProjectActivity>,
  now: number = Date.now(),
): RankedProject[] {
  return projects
    .map((project) => {
      const similarity = similarityScore(project, query);
      const recency = timeDecay(project.last_activity_at, now);
      const conversations = conversationScore(activity.get(project.id), now);
      let score = 55 * similarity + 25 * recency + 20 * conversations;
      if (project.archived) score *= 0.15;
      return { ...project, score: Math.round(score * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score ||
      (a.path_with_namespace ?? "").localeCompare(b.path_with_namespace ?? ""));
}
