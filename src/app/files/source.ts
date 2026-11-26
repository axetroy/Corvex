/** 会话文件浏览统一读取当前 worktree，保证看到的是本会话实际改动过的文件。 */

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
  /** 代码查看器需要一次拿到整文件（仍受字节上限约束），跳过按行切片。 */
  full?: boolean;
}

export interface FileContentResult {
  path: RepoPath;
  content: string;
  truncated: boolean;
  totalLines?: number;
}

/** 图片预览的原始字节；MIME 由适配器按文件头校验，不接受扩展名冒充。 */
export interface FileImageResult {
  path: RepoPath;
  mimeType: string;
  data: Buffer;
  size: number;
}

/** 预览失败的业务错误，携带直接返回给控制台的 HTTP 状态码。 */
export class FilePreviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FilePreviewError";
  }
}

export interface ConversationFileSource {
  listDirectory(path: RepoPath, signal?: AbortSignal): Promise<FileListResult>;
  readFile(path: RepoPath, range?: FileRange, signal?: AbortSignal): Promise<FileContentResult>;
  readImage(path: RepoPath, signal?: AbortSignal): Promise<FileImageResult>;
}
