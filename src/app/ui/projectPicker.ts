/**
 * 仓库选择器的纯逻辑：把 `GET /api/ops/projects` 的响应归一化为下拉选项，
 * 并处理无限滚动的合并去重。与 React 解耦，便于单独测试。
 */

/** 运维台可见的仓库摘要，字段与 `GitLabClient.listProjects` 保持一致。 */
export interface ProjectOption {
  id: number;
  name?: string;
  path_with_namespace?: string;
  description?: string;
  default_branch?: string;
}

/** 下拉选项：`title` 为仓库全路径，`subtitle` 为描述或回退文案。 */
export interface ProjectSelectOption {
  value: number;
  title: string;
  subtitle: string;
  project: ProjectOption;
}

/** 下拉列表页大小，与服务端 `per_page` 保持一致，用于判断是否还有下一页。 */
export const projectPageSize = 50;

/** 把描述压缩成单行，避免多行描述撑高列表项。 */
function collapseText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** 选项标题：优先仓库全路径，其次名称，最后退化为 ID。 */
export function projectTitle(project: ProjectOption): string {
  const path = collapseText(project.path_with_namespace);
  if (path) return path;
  const name = collapseText(project.name);
  return name || `#${project.id}`;
}

/**
 * 选项副标题：优先项目描述；没有描述时回退到与全路径不同的名称；
 * 两者都不可用时显示 ID，保证列表始终是两行结构。
 */
export function projectSubtitle(project: ProjectOption): string {
  const description = collapseText(project.description);
  if (description) return description;
  const name = collapseText(project.name);
  if (name && name !== projectTitle(project)) return name;
  return `#${project.id}`;
}

/** 组装下拉选项，供 `Select` 的 `options` 使用。 */
export function toProjectSelectOption(project: ProjectOption): ProjectSelectOption {
  return {
    value: project.id,
    title: projectTitle(project),
    subtitle: projectSubtitle(project),
    project,
  };
}

/** 追加新一页时合并去重：以 ID 为准，已存在的仓库不会重复出现。 */
export function mergeProjects(current: ProjectOption[], incoming: ProjectOption[]): ProjectOption[] {
  const seen = new Set<number>();
  const merged: ProjectOption[] = [];
  for (const project of [...current, ...incoming]) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    merged.push(project);
  }
  return merged;
}
