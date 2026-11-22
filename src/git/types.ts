export interface Change {
  path: string;
  status: string;
  addedLines: number;
  removedLines: number;
  patch: string;
  skipped: string;
}

export interface DiffResult {
  baseSha: string;
  headSha: string;
  changes: Change[];
  skippedFiles: number;
}

export interface Workspace {
  projectId: number;
  eventId: string;
  path: string;
  headSha: string;
}

/** 提交图谱中的一个节点：父提交用于连线，refs 用于标出分支与会话改动。 */
export interface GitGraphNode {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  authoredAt: string;
  refs: string[];
  /** 指向该提交的 tag 名称（已解引用 annotated tag）。 */
  tags: string[];
}

export interface GitGraphOptions {
  limit: number;
  offset?: number;
  /** 按作者名过滤（GitLab 作者字段的子串匹配）。 */
  author?: string;
}

export interface GitGraphResult {
  nodes: GitGraphNode[];
  /** 是否还有更早的提交可以分页拉取。 */
  truncated: boolean;
  /** 本次返回之前已跳过的提交数，便于界面显示与继续翻页。 */
  offset: number;
}
