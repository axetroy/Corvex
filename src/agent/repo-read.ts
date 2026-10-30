import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const maxReadBytes = 64 << 10;
const defaultMaxLines = 200;
const maxLinesPerRead = 1000;
const maxDirectoryEntries = 200;

interface ReadFileRange {
  startLine?: number;
  maxLines?: number;
}

// 使用相对路径判断目录边界，避免相邻目录因字符串前缀相同而被误判为子目录。
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

interface ResolvedAllowedPath {
  path: string;
  root: string;
}

async function resolveAllowedPath(requestedPath: string, allowedRoots: string[]): Promise<ResolvedAllowedPath> {
  if (!requestedPath.trim() || requestedPath.includes("\0")) {
    throw new Error("file path is empty or invalid");
  }
  if (allowedRoots.length === 0) throw new Error("no file read roots are configured");

  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(roots[0]!, requestedPath);
  const hasParentSegment = requestedPath.split(/[\\/]+/).includes("..");
  if (hasParentSegment && !roots.some((root) => isWithin(root, candidate))) {
    throw new Error(
      "file path is outside the configured read-only roots; use a repository-relative path without '..' segments",
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // 不猜测文件命名规则，引导模型先核对父目录条目和候选路径状态。
      throw new Error(
        `${error.message}; inspect the parent directory with read_dir and verify the intended path with stat before retrying`,
        { cause: error },
      );
    }
    throw error;
  }
  const root = roots.find((allowedRoot) => isWithin(allowedRoot, canonicalPath));
  if (!root) throw new Error("file path is outside the configured read-only roots");
  return { path: canonicalPath, root };
}

function pathType(info: Awaited<ReturnType<typeof stat>>): "file" | "directory" | "other" {
  if (!info) return "other";
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  return "other";
}

export async function readAllowedDirectory(
  requestedPath: string,
  allowedRoots: string[],
): Promise<{ path: string; entries: { name: string; type: string }[]; truncated: boolean }> {
  const resolvedPath = await resolveAllowedPath(requestedPath, allowedRoots);
  const info = await stat(resolvedPath.path);
  if (!info.isDirectory()) {
    throw new Error("requested path is not a directory; provide a directory path");
  }

  // 限制目录结果数量，避免仓库根目录或生成目录导致工具输出过大。
  const allEntries = await readdir(resolvedPath.path, { withFileTypes: true });
  allEntries.sort((left, right) => left.name.localeCompare(right.name));
  const entries = allEntries.slice(0, maxDirectoryEntries).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
  }));
  return {
    path: relative(resolvedPath.root, resolvedPath.path) || ".",
    entries,
    truncated: allEntries.length > maxDirectoryEntries,
  };
}

export async function statAllowedPath(
  requestedPath: string,
  allowedRoots: string[],
): Promise<{ path: string; type: "file" | "directory" | "other"; size: number; modifiedAt: string }> {
  const resolvedPath = await resolveAllowedPath(requestedPath, allowedRoots);
  const info = await stat(resolvedPath.path);
  return {
    path: relative(resolvedPath.root, resolvedPath.path) || ".",
    type: pathType(info),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

async function readLineRange(
  file: FileHandle,
  startLine: number,
  maxLines: number,
  maxBytes: number,
): Promise<string> {
  const endExclusive = startLine + maxLines;
  const output: Buffer[] = [];
  const chunk = Buffer.alloc(8192);
  let outputBytes = 0;
  let lineNumber = 1;
  let completedLines = 0;
  let currentLineHasBytes = false;
  let hasMore = false;

  const append = (value: Buffer): void => {
    if (value.includes(0)) throw new Error("binary files are not supported");
    outputBytes += value.byteLength;
    if (outputBytes > maxBytes) {
      throw new Error(`selected lines exceed the ${maxBytes}-byte read limit`);
    }
    output.push(Buffer.from(value));
  };

  while (true) {
    const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, null);
    if (bytesRead === 0) break;
    if (lineNumber >= endExclusive) {
      hasMore = true;
      break;
    }

    let segmentStart = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(segmentStart, index);
      if (lineNumber >= startLine) {
        append(segment);
        append(Buffer.from("\n"));
        completedLines++;
      }
      lineNumber++;
      currentLineHasBytes = false;
      segmentStart = index + 1;
      if (lineNumber >= endExclusive) {
        hasMore = segmentStart < bytesRead;
        break;
      }
    }

    if (lineNumber >= endExclusive) {
      if (hasMore) break;
      continue;
    }
    const segment = chunk.subarray(segmentStart, bytesRead);
    if (segment.byteLength > 0) {
      currentLineHasBytes = true;
      if (lineNumber >= startLine) {
        append(segment);
      }
    }
  }

  if (lineNumber >= startLine && lineNumber < endExclusive && currentLineHasBytes) {
    completedLines++;
  }
  const totalLines = lineNumber - 1 + (currentLineHasBytes ? 1 : 0);
  if (startLine > totalLines) {
    throw new Error(`startLine ${startLine} exceeds the file length of ${totalLines} lines`);
  }
  if (completedLines === 0) throw new Error(`no lines were read starting at line ${startLine}`);

  const content = Buffer.concat(output, outputBytes);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error("file is not valid UTF-8", { cause: error });
  }
  const lastLine = startLine + completedLines - 1;
  const rangeInfo = `[Lines ${startLine}-${lastLine}${hasMore ? `; more lines available from ${lastLine + 1}` : ""}]\n`;
  if (Buffer.byteLength(rangeInfo) + outputBytes > maxBytes) {
    throw new Error(`selected lines exceed the ${maxBytes}-byte read limit`);
  }
  return rangeInfo + decoded;
}

export async function readAllowedFile(
  requestedPath: string,
  allowedRoots: string[],
  maxBytes = maxReadBytes,
  range?: ReadFileRange,
): Promise<string> {
  if (maxBytes <= 0 || maxBytes > maxReadBytes) {
    throw new Error(`file read limit must be between 1 and ${maxReadBytes} bytes`);
  }
  const hasRange = range?.startLine !== undefined || range?.maxLines !== undefined;
  const startLine = range?.startLine ?? 1;
  const maxLines = range?.maxLines ?? defaultMaxLines;
  if (
    hasRange &&
    (!Number.isSafeInteger(startLine) || startLine <= 0 ||
      !Number.isSafeInteger(maxLines) || maxLines <= 0 || maxLines > maxLinesPerRead ||
      !Number.isSafeInteger(startLine + maxLines))
  ) {
    throw new Error(`line range must use a positive startLine and maxLines between 1 and ${maxLinesPerRead}`);
  }
  const { path: canonicalPath } = await resolveAllowedPath(requestedPath, allowedRoots);

  const file = await open(canonicalPath, "r");
  let content: Buffer;
  try {
    const fileInfo = await file.stat();
    if (!fileInfo.isFile()) {
      throw new Error("requested path is not a regular file; provide a file path, not a directory");
    }
    if (hasRange) return await readLineRange(file, startLine, maxLines, maxBytes);
    if (fileInfo.size > maxBytes) {
      throw new Error(
        `file exceeds the ${maxBytes}-byte read limit; retry with startLine: 1 and maxLines up to ${maxLinesPerRead}, then continue at the next line reported in the range header`,
      );
    }
    // 多读一个字节，捕捉 stat 之后文件变大导致的限额绕过。
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte read limit`);
    content = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  if (content.includes(0)) throw new Error("binary files are not supported");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error("file is not valid UTF-8", { cause: error });
  }
}

export function createReadOnlyFileExtension(allowedRoots: string[]): (pi: ExtensionAPI) => void {
  const roots = allowedRoots.map((root) => resolve(root));
  return (pi) => {
    pi.registerTool({
      name: "read_file",
      label: "Read file",
      description: `Read a UTF-8 text file without modifying it. Relative paths resolve from ${roots[0]}. Absolute paths are allowed only within these roots: ${roots.join(", ")}. Files are limited to ${maxReadBytes} output bytes per call. For large files, set startLine and maxLines (up to ${maxLinesPerRead}) and request subsequent ranges as needed.`,
      promptSnippet: "read_file: Read a UTF-8 text file from the fixed repository worktree or trusted skill roots. Use startLine and maxLines to read large files in bounded ranges.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLinesPerRead })),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{
          type: "text",
          text: await readAllowedFile(params.path, roots, maxReadBytes, {
            startLine: params.startLine,
            maxLines: params.maxLines,
          }),
        }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "read_dir",
      label: "List directory",
      description: `List up to ${maxDirectoryEntries} immediate entries in a directory under the fixed repository worktree or trusted skill roots. Use this to inspect actual names after a read_file ENOENT; entries are not followed recursively.`,
      promptSnippet: "read_dir: List immediate directory entries when a requested path is missing or its actual name is uncertain.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await readAllowedDirectory(params.path, roots)) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "stat",
      label: "Inspect path",
      description: "Inspect a file or directory under the fixed repository worktree or trusted skill roots. Returns the canonical repository-relative path and whether it is a file, directory, or other entry.",
      promptSnippet: "stat: Verify an exact candidate path and determine whether it is a file or directory before retrying read_file.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await statAllowedPath(params.path, roots)) }],
        details: {},
      }),
    });
  };
}
