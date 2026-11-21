/**
 * 分支选择器的纯逻辑：把 `GET /api/ops/projects/<id>/branches` 的响应归一化为
 * 下拉选项（分支名 + 最近提交），并处理无限滚动的合并去重。与 React 解耦，便于单独测试。
 */

/** 分支最近一次提交；除 `id` 外其余字段可能缺失。 */
export interface BranchCommit {
  id: string;
  short_id?: string;
  title?: string;
  committed_date?: string;
}

/** Agent 控制台可见的分支摘要，字段与 `GitLabClient.listBranches` 保持一致。 */
export interface BranchOption {
  name: string;
  commit: BranchCommit;
}

/** 下拉选项：`title` 为分支名，`subtitle` 为短 SHA 与提交标题，`meta` 为提交时间的相对描述。 */
export interface BranchSelectOption {
  value: string;
  title: string;
  subtitle: string;
  meta: string;
  branch: BranchOption;
}

/** 下拉列表页大小，与服务端 `per_page` 保持一致，用于判断是否还有下一页。 */
export const branchPageSize = 50;

/** 提交标题超长时截断，避免撑高列表项。 */
const maxTitleLength = 200;

/** 把文本压缩成单行。 */
function collapseText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** 短 SHA：优先使用 GitLab 返回的 `short_id`，否则截取完整 SHA 的前 8 位。 */
export function branchShortSha(commit: BranchCommit): string {
  const shortId = collapseText(commit.short_id);
  if (shortId) return shortId;
  return commit.id.slice(0, 8);
}

/** 提交标题；缺失或超长时返回截断后的单行文本。 */
export function branchCommitTitle(commit: BranchCommit): string {
  const title = collapseText(commit.title);
  return title.length > maxTitleLength ? `${title.slice(0, maxTitleLength)}…` : title;
}

/** 选项副标题：`短 SHA · 提交标题`，没有标题时只显示短 SHA。 */
export function branchSubtitle(branch: BranchOption): string {
  const shortSha = branchShortSha(branch.commit);
  const title = branchCommitTitle(branch.commit);
  return title ? `${shortSha} · ${title}` : shortSha;
}

/** 组装下拉选项；`meta` 由调用方按当前语言格式化提交时间后传入。 */
export function toBranchSelectOption(branch: BranchOption, relativeTime: string): BranchSelectOption {
  return {
    value: branch.name,
    title: branch.name,
    subtitle: branchSubtitle(branch),
    meta: relativeTime,
    branch,
  };
}

/** 追加新一页时合并去重：以分支名为准，已存在的分支不会重复出现。 */
export function mergeBranches(current: BranchOption[], incoming: BranchOption[]): BranchOption[] {
  const seen = new Set<string>();
  const merged: BranchOption[] = [];
  for (const branch of [...current, ...incoming]) {
    if (seen.has(branch.name)) continue;
    seen.add(branch.name);
    merged.push(branch);
  }
  return merged;
}
