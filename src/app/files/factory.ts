import type { GitLabClient } from "../../gitlab/client.js";
import { GitLabFileSource } from "./gitlab-source.js";
import { LocalFileSource, WorkspaceUnavailableError } from "./local-source.js";
import type {
  ConversationFileSource,
  FileContentResult,
  FileImageResult,
  FileListResult,
  FileRange,
  FileSourceKind,
  RepoPath,
} from "./source.js";

export interface FileSourceOptions {
  /** 默认读本地 worktree；只有显式指定 `gitlab` 时才走远端 API。 */
  kind?: FileSourceKind;
  gitlab?: GitLabClient;
  projectId: number;
  sha: string;
  /** 本地 worktree 的绝对路径；默认 `local` 时必填。 */
  workspacePath?: string;
  /** 本地 worktree 不可用时是否回退到 GitLab 源。 */
  fallbackToGitLab?: boolean;
}

/** worktree 被 TTL 淘汰或首轮尚未执行时，用 GitLab 源兜底，保证文件面板始终可用。 */
class FallbackFileSource implements ConversationFileSource {
  readonly kind: FileSourceKind = "local";

  constructor(private readonly primary: ConversationFileSource, private readonly fallback: ConversationFileSource) {}

  private withFallback<T>(read: (source: ConversationFileSource) => Promise<T>): Promise<T> {
    return read(this.primary).catch((error: unknown) => {
      if (error instanceof WorkspaceUnavailableError) return read(this.fallback);
      throw error;
    });
  }

  listDirectory(path: RepoPath, signal?: AbortSignal): Promise<FileListResult> {
    return this.withFallback((source) => source.listDirectory(path, signal));
  }

  readFile(path: RepoPath, range?: FileRange, signal?: AbortSignal): Promise<FileContentResult> {
    return this.withFallback((source) => source.readFile(path, range, signal));
  }

  readImage(path: RepoPath, signal?: AbortSignal): Promise<FileImageResult> {
    return this.withFallback((source) => source.readImage(path, signal));
  }
}

/** 会话文件源工厂：UI 与路由只依赖 ConversationFileSource，替换实现不影响调用方。 */
export function createConversationFileSource(options: FileSourceOptions): ConversationFileSource {
  const kind = options.kind ?? "local";
  if (kind === "gitlab") {
    if (!options.gitlab) throw new Error("gitlab file source requires a GitLab client");
    return new GitLabFileSource(options.gitlab, options.projectId, options.sha);
  }
  if (!options.workspacePath) throw new Error("local file source requires a workspace path");
  const primary = new LocalFileSource(options.workspacePath);
  if (!options.fallbackToGitLab || !options.gitlab) return primary;
  return new FallbackFileSource(primary, new GitLabFileSource(options.gitlab, options.projectId, options.sha));
}
