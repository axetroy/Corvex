/**
 * 会话文件浏览的数据源适配器。
 *
 * 目前只有 GitLab API 实现；以后要改成本地磁盘读取，只需新增一个实现
 * `ConversationFileSource` 的适配器并在工厂里切换，UI 与路由都不用改。
 */

/** 仓库相对路径（正斜杠），永远不接受绝对路径或 `..`。 */
export type RepoPath = string;

export interface FileEntry {
  name: string;
  path: RepoPath;
  type: "directory" | "file" | "symlink" | "other";
}

export interface FileListResult {
  entries: FileEntry[];
  truncated: boolean;
}

export interface FileRange {
  startLine?: number;
  maxLines?: number;
}

export interface FileContentResult {
  path: RepoPath;
  content: string;
  truncated: boolean;
  totalLines?: number;
}

export interface ConversationFileSource {
  readonly kind: "gitlab";
  listDirectory(path: RepoPath, signal?: AbortSignal): Promise<FileListResult>;
  readFile(path: RepoPath, range?: FileRange, signal?: AbortSignal): Promise<FileContentResult>;
}
