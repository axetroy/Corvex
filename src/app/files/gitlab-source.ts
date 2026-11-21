import type { GitLabClient } from "../../gitlab/client.js";
import { normalizeRepoPath } from "../../gitlab/client.js";
import type {
  ConversationFileSource,
  FileContentResult,
  FileListResult,
  FileRange,
  RepoPath,
} from "./source.js";

/** 单次读取上限：与 Agent 的 read_file 工具一致，避免大文件把界面和上下文撑爆。 */
const MAX_FILE_BYTES = 256 << 10;
const MAX_LINES_PER_READ = 2_000;

/** GitLab API 适配器：所有读取都绑定对话项目和固定提交，和 worktree 快照一致。 */
export class GitLabFileSource implements ConversationFileSource {
  readonly kind = "gitlab" as const;

  constructor(
    private readonly gitlab: GitLabClient,
    private readonly projectId: number,
    private readonly sha: string,
  ) {}

  async listDirectory(path: RepoPath, signal?: AbortSignal): Promise<FileListResult> {
    const relative = normalizeRepoPath(path);
    const result = await this.gitlab.listRepositoryTree(
      this.projectId,
      { path: relative, ref: this.sha },
      signal,
    );
    return { entries: result.entries, truncated: result.truncated };
  }

  async readFile(path: RepoPath, range?: FileRange, signal?: AbortSignal): Promise<FileContentResult> {
    const relative = normalizeRepoPath(path);
    if (!relative) throw new Error("repository file path is required");
    const file = await this.gitlab.getRepositoryFile(this.projectId, relative, this.sha, signal);
    const raw = file.encoding === "base64"
      ? Buffer.from(file.content.replaceAll(/\s/g, ""), "base64")
      : Buffer.from(file.content, "utf8");
    if (raw.includes(0)) {
      return { path: relative, content: "[二进制文件，无法以文本预览]", truncated: false };
    }
    const bytesCapped = raw.length > MAX_FILE_BYTES;
    const text = raw.subarray(0, MAX_FILE_BYTES).toString("utf8");
    const allLines = text.split("\n");
    const totalLines = allLines.length;
    const start = Math.max(1, range?.startLine ?? 1);
    const maxLines = Math.max(1, Math.min(range?.maxLines ?? MAX_LINES_PER_READ, MAX_LINES_PER_READ));
    const selected = allLines.slice(start - 1, start - 1 + maxLines);
    const moreLines = start - 1 + selected.length < totalLines;
    const content = selected.map((line) => line.replace(/\r$/, "")).join("\n");
    return {
      path: relative,
      content,
      truncated: bytesCapped || moreLines,
      ...(bytesCapped || moreLines ? { totalLines } : {}),
    };
  }
}
