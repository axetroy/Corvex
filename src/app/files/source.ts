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

export type FileSourceKind = "local" | "gitlab";

export interface FileListResult {
  entries: FileEntry[];
  truncated: boolean;
  /** 真正提供这次读取的适配器；回退时反映实际来源，失败占位时为空。 */
  source?: FileSourceKind;
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
  source?: FileSourceKind;
}

/** 图片预览的原始字节；MIME 由适配器按文件头校验，不接受扩展名冒充。 */
export interface FileImageResult {
  path: RepoPath;
  mimeType: string;
  data: Buffer;
  size: number;
  source?: FileSourceKind;
}

/** 预览失败的业务错误，携带直接返回给控制台的 HTTP 状态码。 */
export class FilePreviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FilePreviewError";
  }
}

export interface ConversationFileSource {
  readonly kind: FileSourceKind;
  listDirectory(path: RepoPath, signal?: AbortSignal): Promise<FileListResult>;
  readFile(path: RepoPath, range?: FileRange, signal?: AbortSignal): Promise<FileContentResult>;
  readImage(path: RepoPath, signal?: AbortSignal): Promise<FileImageResult>;
}
