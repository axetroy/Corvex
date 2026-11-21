import { lstat, readdir, readFile as readFileFs } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveWorktreePath } from "../../agent/fs-write.js";
import type {
  ConversationFileSource,
  FileContentResult,
  FileImageResult,
  FileListResult,
  FileRange,
  RepoPath,
} from "./source.js";
import { FilePreviewError } from "./source.js";
import { isImagePath } from "./image.js";
import { detectImageMime, MAX_IMAGE_BYTES } from "./image-mime.js";

/** 单次读取上限：与 GitLab 适配器保持一致。 */
const MAX_FILE_BYTES = 256 << 10;
const MAX_LINES_PER_READ = 2_000;
/** 单次目录列举上限，与 GitLab tree 接口一致。 */
const MAX_DIRECTORY_ENTRIES = 200;

/** 本地 worktree 尚未准备或已被回收；调用方可据此回退到 GitLab 源。 */
export class WorkspaceUnavailableError extends Error {
  constructor(readonly path: string) {
    super(`conversation worktree is not available: ${path}`);
    this.name = "WorkspaceUnavailableError";
  }
}

/**
 * 本地 worktree 适配器：读取对话固定快照（含会话本地改动）所在的工作目录。
 * 所有路径都走与写入工具共享的守卫，拒绝绝对路径、上层遍历、.git 与符号链接。
 */
export class LocalFileSource implements ConversationFileSource {
  readonly kind = "local" as const;

  constructor(private readonly workspacePath: string) {}

  private async ensureWorkspace(): Promise<string> {
    let info;
    try {
      info = await lstat(this.workspacePath);
    } catch {
      throw new WorkspaceUnavailableError(this.workspacePath);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new WorkspaceUnavailableError(this.workspacePath);
    return resolve(this.workspacePath);
  }

  private async resolvePath(path: RepoPath) {
    await this.ensureWorkspace();
    return resolveWorktreePath(this.workspacePath, path);
  }

  private async readBytes(target: string): Promise<Buffer> {
    try {
      return await readFileFs(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        throw new FilePreviewError(404, "file not found");
      }
      throw error;
    }
  }

  async listDirectory(path: RepoPath, signal?: AbortSignal): Promise<FileListResult> {
    await this.ensureWorkspace();
    let target = resolve(this.workspacePath);
    let normalized = "";
    if (path) {
      const resolved = await resolveWorktreePath(this.workspacePath, path);
      target = resolved.target;
      normalized = resolved.path;
    }
    if (signal?.aborted) throw signal.reason;
    let names: import("node:fs").Dirent[];
    try {
      names = await readdir(target, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") throw new FilePreviewError(404, "directory not found");
      throw error;
    }
    const entries = names
      .filter((entry) => entry.name !== ".git")
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => ({
        name: entry.name,
        path: normalized ? `${normalized}/${entry.name}` : entry.name,
        type: entry.isDirectory() ? "directory" as const
          : entry.isFile() ? "file" as const
          : entry.isSymbolicLink() ? "symlink" as const
          : "other" as const,
      }));
    return { entries, truncated: names.length > MAX_DIRECTORY_ENTRIES, source: this.kind };
  }

  async readFile(path: RepoPath, range?: FileRange): Promise<FileContentResult> {
    if (!path) throw new FilePreviewError(400, "repository file path is required");
    const { target, path: normalized } = await this.resolvePath(path);
    const raw = await this.readBytes(target);
    if (raw.includes(0)) {
      return { path: normalized, content: "[二进制文件，无法以文本预览]", truncated: false, source: this.kind };
    }
    const bytesCapped = raw.length > MAX_FILE_BYTES;
    const allLines = raw.subarray(0, MAX_FILE_BYTES).toString("utf8").split("\n");
    const totalLines = allLines.length;
    const start = Math.max(1, range?.startLine ?? 1);
    const maxLines = Math.max(1, Math.min(range?.maxLines ?? MAX_LINES_PER_READ, MAX_LINES_PER_READ));
    const selected = allLines.slice(start - 1, start - 1 + maxLines);
    const moreLines = start - 1 + selected.length < totalLines;
    return {
      path: normalized,
      content: selected.map((line) => line.replace(/\r$/, "")).join("\n"),
      truncated: bytesCapped || moreLines,
      ...(bytesCapped || moreLines ? { totalLines } : {}),
      source: this.kind,
    };
  }

  async readImage(path: RepoPath): Promise<FileImageResult> {
    if (!path) throw new FilePreviewError(400, "repository file path is required");
    if (!isImagePath(path)) throw new FilePreviewError(415, "unsupported image format");
    const { target, path: normalized } = await this.resolvePath(path);
    const raw = await this.readBytes(target);
    if (raw.length > MAX_IMAGE_BYTES) {
      throw new FilePreviewError(413, `image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
    }
    const mimeType = detectImageMime(normalized, raw);
    if (!mimeType) throw new FilePreviewError(415, "file is not a supported image");
    return { path: normalized, mimeType, data: raw, size: raw.length, source: this.kind };
  }
}
