import type { GitLabClient } from "../../gitlab/client.js";
import { normalizeRepoPath } from "../../gitlab/client.js";
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

/** 单次读取上限：与 Agent 的 read_file 工具一致，避免大文件把界面和上下文撑爆。 */
const MAX_FILE_BYTES = 256 << 10;
const MAX_LINES_PER_READ = 2_000;
/** 图片预览上限：GitLab 的 base64 响应仍受 20 MiB 的 HTTP 响应上限保护。 */
const MAX_IMAGE_BYTES = 12 << 20;

/** 各 MIME 允许的扩展名；检测出的文件头必须与扩展名一致，避免伪装成图片的任意文件。 */
const imageExtensionsByMime: Record<string, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/bmp": [".bmp"],
  "image/avif": [".avif"],
  "image/svg+xml": [".svg"],
};

/** 按文件头识别图片，并要求扩展名与真实格式一致；非图片或伪装文件返回 null。 */
function detectImageMime(path: string, bytes: Buffer): string | null {
  const matches = (offset: number, ...expected: number[]): boolean =>
    expected.every((value, index) => bytes[offset + index] === value);
  let mime: string | null = null;
  if (matches(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) mime = "image/png";
  else if (matches(0, 0xff, 0xd8, 0xff)) mime = "image/jpeg";
  else if (matches(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || matches(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) mime = "image/gif";
  else if (matches(0, 0x52, 0x49, 0x46, 0x46) && matches(8, 0x57, 0x45, 0x42, 0x50)) mime = "image/webp";
  else if (matches(0, 0x42, 0x4d)) mime = "image/bmp";
  else if (matches(4, 0x66, 0x74, 0x79, 0x70) && matches(8, 0x61, 0x76, 0x69, 0x66)) mime = "image/avif";
  else {
    const head = bytes.subarray(0, 1_024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("<svg") || /^<\?xml[\s\S]{0,512}\?>\s*<svg/.test(head)) mime = "image/svg+xml";
  }
  if (!mime) return null;
  const lower = path.toLowerCase();
  return imageExtensionsByMime[mime]?.some((extension) => lower.endsWith(extension)) ? mime : null;
}

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

  async readImage(path: RepoPath, signal?: AbortSignal): Promise<FileImageResult> {
    const relative = normalizeRepoPath(path);
    if (!relative) throw new FilePreviewError(400, "repository file path is required");
    if (!isImagePath(relative)) throw new FilePreviewError(415, "unsupported image format");
    const file = await this.gitlab.getRepositoryFile(this.projectId, relative, this.sha, signal);
    const raw = file.encoding === "base64"
      ? Buffer.from(file.content.replaceAll(/\s/g, ""), "base64")
      : Buffer.from(file.content, "utf8");
    if (raw.length > MAX_IMAGE_BYTES) {
      throw new FilePreviewError(413, `image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
    }
    const mimeType = detectImageMime(relative, raw);
    if (!mimeType) throw new FilePreviewError(415, "file is not a supported image");
    return { path: relative, mimeType, data: raw, size: raw.length };
  }
}
