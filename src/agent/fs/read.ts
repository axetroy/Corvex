import { opendir, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 目录树默认最大深度；只展示骨架，避免把整个仓库铺进上下文。 */
const maxTreeDepth = 4;
/** 目录树最多节点数。 */
const maxTreeNodes = 300;
/** 目录树文本输出上限。 */
const maxTreeBytes = 24 << 10;
/** 单次 read_file 返回内容的 UTF-8 字节上限。 */
const maxReadBytes = 256 << 10;
/** read_file 未指定行范围时默认返回的行数。 */
const defaultMaxLines = 200;
/** read_file 单次请求允许的最大行数。 */
const maxLinesPerRead = 1000;
/** read_file 单行输出的 UTF-8 字节上限；压缩/混淆文件的单行可能远大于整次读取预算。 */
const maxLineBytes = 4 << 10;
/** read_dir 单次最多返回的直接子项数量。 */
const maxDirectoryEntries = 200;
/** search_text 查询字符串允许的最大字符数。 */
const maxSearchQueryCharacters = 256;
/** 单次 search_text 最多扫描的文件数。 */
const maxSearchFiles = 1000;
/** 单次 search_text 遍历目录时最多访问的条目数。 */
const maxSearchDirectoryEntries = 10_000;
/** search_text 从单个文件读取的最大字节数。 */
const maxSearchFileBytes = 256 << 10;
/** 单次 search_text 跨所有文件读取的总字节上限。 */
const maxSearchTotalBytes = 16 << 20;
/** 单次 search_text 最多返回的匹配数量。 */
const maxSearchResults = 50;
/** search_text 每条匹配结果最多保留的行文本字符数。 */
const maxSearchLineCharacters = 400;
/** search_text 递归搜索时跳过的 Git、依赖和生成目录。 */
const ignoredSearchDirectories = new Set([".git", ".next", ".turbo", "coverage", "dist", "node_modules"]);

interface ReadFileRange {
  startLine?: number;
  maxLines?: number;
}

// 使用相对路径判断目录边界，避免相邻目录因字符串前缀相同而被误判为子目录。
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function toForwardSlashPath(path: string): string {
  return path.split(sep).join("/");
}

interface ResolvedAllowedPath {
  path: string;
  root: string;
}

/**
 * 工具入口的仓库路径校验：worktree 内必须使用相对路径，绝对路径仅允许指向可信 Skill 根目录。
 * 放在工具边界而不是 `resolveAllowedPath`，避免破坏内部以绝对路径递归搜索的实现。
 */
export async function requireRelativeRepoPath(requestedPath: string, roots: string[]): Promise<string> {
  if (!isAbsolute(requestedPath) || roots.length === 0) return requestedPath;
  const candidate = resolve(requestedPath);
  const worktree = await realpath(roots[0]!);
  const worktreeRaw = resolve(roots[0]!);
  if (isWithin(worktree, candidate) || isWithin(worktreeRaw, candidate)) {
    const relativePath = relative(worktree, candidate);
    throw new Error(
      `use a repository-relative path ("${relativePath}") instead of an absolute path for repository files`,
    );
  }
  return requestedPath;
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
  const directory = await opendir(resolvedPath.path);
  const allEntries = [];
  let truncated = false;
  for await (const entry of directory) {
    if (allEntries.length >= maxDirectoryEntries) {
      truncated = true;
      break;
    }
    allEntries.push(entry);
  }
  allEntries.sort((left, right) => left.name.localeCompare(right.name));
  const entries = allEntries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
  }));
  return {
    path: toForwardSlashPath(relative(resolvedPath.root, resolvedPath.path) || "."),
    entries,
    truncated,
  };
}

export interface TreeEntry {
  /** 相对请求目录的层级深度，从 1 开始。 */
  depth: number;
  name: string;
  type: "directory" | "file" | "symlink" | "other";
}

export interface TreeResult {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

/**
 * 有界目录树：只沿普通目录递归，不跟随符号链接，跳过依赖/生成目录，
 * 深度、节点数与输出字节三重上限，任何触顶都置 truncated，让调用方知道结果不完整。
 */
export async function readAllowedTree(
  requestedPath: string,
  allowedRoots: string[],
  options: { maxDepth?: number; maxNodes?: number; maxBytes?: number } = {},
): Promise<TreeResult> {
  const resolvedPath = await resolveAllowedPath(requestedPath, allowedRoots);
  const info = await stat(resolvedPath.path);
  if (!info.isDirectory()) throw new Error("requested path is not a directory; provide a directory path");

  const depthLimit = options.maxDepth ?? maxTreeDepth;
  const nodeLimit = options.maxNodes ?? maxTreeNodes;
  const byteLimit = options.maxBytes ?? maxTreeBytes;
  const entries: TreeEntry[] = [];
  let bytes = 0;
  let truncated = false;
  // 显式栈保持深度优先且顺序确定；每层先按名字排序后再压栈。
  const stack: Array<{ path: string; depth: number }> = [{ path: resolvedPath.path, depth: 0 }];
  while (stack.length > 0 && !truncated) {
    const current = stack.pop()!;
    const directory = await opendir(current.path);
    const children: Array<{ name: string; kind: string }> = [];
    for await (const child of directory) {
      if (child.isDirectory() && ignoredSearchDirectories.has(child.name)) continue;
      children.push({
        name: child.name,
        kind: child.isDirectory() ? "directory" : child.isFile() ? "file" : child.isSymbolicLink() ? "symlink" : "other",
      });
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    const directories: Array<{ path: string; depth: number }> = [];
    for (const child of children) {
      if (entries.length >= nodeLimit) {
        truncated = true;
        break;
      }
      const depth = current.depth + 1;
      const line = `${"  ".repeat(depth - 1)}${child.name}${child.kind === "directory" ? "/" : ""}\n`;
      if (bytes + Buffer.byteLength(line) > byteLimit) {
        truncated = true;
        break;
      }
      entries.push({ depth, name: child.name, type: child.kind as TreeEntry["type"] });
      bytes += Buffer.byteLength(line);
      // 到达深度上限时可能有未展示的子项；不递归，但标记结果不完整。
      if (child.kind === "directory") {
        if (depth >= depthLimit) truncated = true;
        else directories.push({ path: resolve(current.path, child.name), depth });
      }
    }
    // 子目录倒序压栈，弹出顺序与排序后的兄弟顺序一致。
    for (let index = directories.length - 1; index >= 0; index -= 1) stack.push(directories[index]!);
  }
  return {
    path: toForwardSlashPath(relative(resolvedPath.root, resolvedPath.path) || "."),
    entries,
    truncated,
  };
}

/** 把有界树渲染为缩进文本；行宽已在采集时按字节计数，这里只做拼接。 */
export function renderDirectoryTree(result: TreeResult): string {
  const lines = result.entries.map((entry) =>
    `${"  ".repeat(entry.depth - 1)}${entry.name}${entry.type === "directory" ? "/" : ""}`,
  );
  return [
    `${result.path}${result.path === "." ? "" : "/"}`,
    ...lines,
    result.truncated
      ? `[truncated: depth/node/byte limit reached; use a narrower path or read_dir to explore]`
      : "",
  ].filter(Boolean).join("\n");
}

export async function statAllowedPath(
  requestedPath: string,
  allowedRoots: string[],
): Promise<{ path: string; type: "file" | "directory" | "other"; size: number; modifiedAt: string }> {
  const resolvedPath = await resolveAllowedPath(requestedPath, allowedRoots);
  const info = await stat(resolvedPath.path);
  return {
    path: toForwardSlashPath(relative(resolvedPath.root, resolvedPath.path) || "."),
    type: pathType(info),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  scannedFiles: number;
  truncated: boolean;
}

export interface GitGrepResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export type GitGrep = (query: string, path: string) => Promise<GitGrepResult>;

export async function searchAllowedFiles(
  query: string,
  requestedPath: string,
  allowedRoots: string[],
  caseSensitive = false,
): Promise<SearchResult> {
  const searchTerm = query.trim();
  if (!searchTerm || searchTerm.includes("\0") || searchTerm.length > maxSearchQueryCharacters) {
    throw new Error(`search query must contain 1 to ${maxSearchQueryCharacters} characters`);
  }

  const start = await resolveAllowedPath(requestedPath, allowedRoots);
  const startInfo = await stat(start.path);
  if (!startInfo.isFile() && !startInfo.isDirectory()) {
    throw new Error("search path must be a regular file or directory");
  }

  const matches: SearchMatch[] = [];
  const directories = startInfo.isDirectory() ? [start.path] : [];
  const candidates = startInfo.isFile() ? [start.path] : [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncated = false;
  let stopSearching = false;
  let entriesVisited = 0;
  const needle = caseSensitive ? searchTerm : searchTerm.toLowerCase();

  const searchFile = async (candidate: string): Promise<boolean> => {
    const resolved = await resolveAllowedPath(candidate, allowedRoots);
    scannedFiles++;
    const file = await open(resolved.path, "r");
    let content: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile()) return true;
      const remainingBytes = maxSearchTotalBytes - scannedBytes;
      if (info.size > maxSearchFileBytes || info.size > remainingBytes) {
        truncated = true;
        return true;
      }
      const readLimit = Math.min(maxSearchFileBytes, remainingBytes);
      const buffer = Buffer.alloc(readLimit + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.byteLength) {
        const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, null);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > readLimit) {
        truncated = true;
        return true;
      }
      content = buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
    scannedBytes += content.byteLength;
    if (content.includes(0)) return true;

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return true;
    }
    const relativePath = toForwardSlashPath(relative(resolved.root, resolved.path) || ".");
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.replace(/\r$/, "");
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) continue;
      if (matches.length >= maxSearchResults) {
        truncated = true;
        return false;
      }
      matches.push({
        path: relativePath,
        line: index + 1,
        text: line.slice(0, maxSearchLineCharacters),
      });
    }
    return true;
  };

  for (const candidate of candidates) {
    if (scannedFiles >= maxSearchFiles) {
      truncated = true;
      break;
    }
    if (!(await searchFile(candidate))) {
      stopSearching = true;
      break;
    }
  }

  while (directories.length > 0 && !stopSearching && matches.length < maxSearchResults) {
    const directoryPath = directories.shift()!;
    const directory = await opendir(directoryPath);
    const entries: { name: string; path: string; type: "directory" | "file" }[] = [];
    for await (const entry of directory) {
      entriesVisited++;
      if (entriesVisited > maxSearchDirectoryEntries) {
        truncated = true;
        stopSearching = true;
        break;
      }
      if (entry.isDirectory()) {
        if (!ignoredSearchDirectories.has(entry.name)) {
          entries.push({ name: entry.name, path: resolve(directoryPath, entry.name), type: "directory" });
        }
      } else if (entry.isFile()) {
        entries.push({ name: entry.name, path: resolve(directoryPath, entry.name), type: "file" });
      }
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.type === "directory") {
        directories.push(entry.path);
        continue;
      }
      if (scannedFiles >= maxSearchFiles) {
        truncated = true;
        stopSearching = true;
        break;
      }
      if (!(await searchFile(entry.path))) {
        stopSearching = true;
        break;
      }
    }
  }

  return { matches, scannedFiles, truncated };
}

async function readLineRange(
  file: FileHandle,
  startLine: number,
  maxLines: number,
  maxBytes: number,
  startOffset = 0,
): Promise<{ text: string; nextOffset: number; nextLine: number; hasMore: boolean }> {
  const endExclusive = startLine + maxLines;
  const output: Buffer[] = [];
  const chunk = Buffer.alloc(8192);
  let outputBytes = 0;
  let lineNumber = startOffset === 0 ? 1 : startLine;
  let completedLines = 0;
  let currentLineHasBytes = false;
  let hasMore = false;
  let readOffset = startOffset;
  let nextOffset = startOffset;
  let lineStartOffset = startOffset;
  let lineBuffers: Buffer[] = [];
  let lineBufferedBytes = 0;
  let lineSeenBytes = 0;
  let lineTruncated = false;
  let stoppedForBudget = false;

  const append = (value: Buffer): void => {
    if (value.includes(0)) throw new Error("binary files are not supported");
    outputBytes += value.byteLength;
    if (outputBytes > maxBytes) {
      throw new Error(`selected lines exceed the ${maxBytes}-byte read limit`);
    }
    output.push(Buffer.from(value));
  };

  const resetLine = (): void => {
    lineBuffers = [];
    lineBufferedBytes = 0;
    lineSeenBytes = 0;
    lineTruncated = false;
    currentLineHasBytes = false;
  };

  // 按行缓冲：正常行完整输出；超长行只保留前 maxLineBytes 字节并标记省略的字节数，
  // 避免压缩/混淆文件里的单个超长行把整次读取撑爆。
  const bufferLineSegment = (segment: Buffer): void => {
    if (segment.byteLength === 0) return;
    currentLineHasBytes = true;
    if (lineNumber < startLine) return;
    lineSeenBytes += segment.byteLength;
    const remaining = maxLineBytes - lineBufferedBytes;
    if (remaining <= 0) {
      lineTruncated = true;
      return;
    }
    if (segment.byteLength <= remaining) {
      lineBuffers.push(Buffer.from(segment));
      lineBufferedBytes += segment.byteLength;
      return;
    }
    lineBuffers.push(Buffer.from(segment.subarray(0, remaining)));
    lineBufferedBytes += remaining;
    lineTruncated = true;
  };

  const rangeHeaderBytes = (lastLine: number): number =>
    Buffer.byteLength(
      `[Lines ${startLine}-${lastLine}; more lines available from ${lastLine + 1}]\n`,
    );

  // 返回 true 表示当前行放不进本次输出预算，已在行边界停止，交由调用方从该行继续。
  const flushLine = (withNewline: boolean): boolean => {
    if (lineNumber < startLine) {
      resetLine();
      return false;
    }
    if (!currentLineHasBytes && !withNewline) return false;
    const parts = lineTruncated
      ? [
          Buffer.from(new TextDecoder("utf-8").decode(Buffer.concat(lineBuffers, lineBufferedBytes))),
          Buffer.from(` … [line truncated, ${lineSeenBytes - lineBufferedBytes} bytes omitted]`),
        ]
      : [Buffer.concat(lineBuffers, lineBufferedBytes)];
    const lineBytes = parts.reduce((total, part) => total + part.byteLength, 0) + (withNewline ? 1 : 0);
    // 预留范围头（按其可能的最长形式），避免内容刚好占满预算后头信息把它撑爆。
    const projectedHeaderBytes = rangeHeaderBytes(startLine + completedLines);
    if (outputBytes + lineBytes + projectedHeaderBytes > maxBytes) {
      if (completedLines === 0) {
        throw new Error(`selected lines exceed the ${maxBytes}-byte read limit`);
      }
      hasMore = true;
      nextOffset = lineStartOffset;
      stoppedForBudget = true;
      return true;
    }
    for (const part of parts) append(part);
    if (withNewline) append(Buffer.from("\n"));
    completedLines++;
    resetLine();
    return false;
  };

  while (!stoppedForBudget) {
    const chunkStart = readOffset;
    const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, readOffset);
    if (bytesRead === 0) break;
    readOffset += bytesRead;
    nextOffset = readOffset;
    if (lineNumber >= endExclusive) {
      hasMore = true;
      nextOffset = chunkStart;
      break;
    }

    let segmentStart = 0;
    for (let index = 0; index < bytesRead; index++) {
      if (chunk[index] !== 0x0a) continue;
      bufferLineSegment(chunk.subarray(segmentStart, index));
      if (flushLine(true)) break;
      lineNumber++;
      lineStartOffset = chunkStart + index + 1;
      segmentStart = index + 1;
      if (lineNumber >= endExclusive) {
        hasMore = segmentStart < bytesRead;
        if (hasMore) nextOffset = chunkStart + segmentStart;
        break;
      }
    }

    if (stoppedForBudget) break;
    if (lineNumber >= endExclusive) {
      if (hasMore) break;
      continue;
    }
    bufferLineSegment(chunk.subarray(segmentStart, bytesRead));
  }

  if (!stoppedForBudget && lineNumber >= startLine && lineNumber < endExclusive && currentLineHasBytes) {
    flushLine(false);
  }
  const totalLines = lineNumber - 1 + (currentLineHasBytes ? 1 : 0);
  if (startOffset === 0 && startLine > totalLines) {
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
  return {
    text: rangeInfo + decoded,
    nextOffset,
    nextLine: lastLine + 1,
    hasMore,
  };
}

interface ReadFileCursor {
  nextLine: number;
  nextOffset: number;
  size: number;
  modifiedAt: number;
}

interface ReadFileChunk extends ReadFileCursor {
  path: string;
  text: string;
  hasMore: boolean;
}

async function readAllowedFileChunk(
  requestedPath: string,
  allowedRoots: string[],
  maxBytes = maxReadBytes,
  range?: ReadFileRange,
  cursor?: ReadFileCursor,
): Promise<ReadFileChunk> {
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
    if (hasRange) {
      let startOffset = 0;
      let effectiveStartLine = startLine;
      if (
        cursor && cursor.nextLine === startLine && cursor.size === fileInfo.size &&
        cursor.modifiedAt === fileInfo.mtimeMs && cursor.nextOffset <= fileInfo.size
      ) {
        let lineBoundary = cursor.nextOffset === 0;
        if (cursor.nextOffset > 0) {
          const previousByte = Buffer.alloc(1);
          const result = await file.read(previousByte, 0, 1, cursor.nextOffset - 1);
          lineBoundary = result.bytesRead === 1 && previousByte[0] === 0x0a;
        }
        if (lineBoundary) {
          startOffset = cursor.nextOffset;
          effectiveStartLine = cursor.nextLine;
        }
      }
      const result = await readLineRange(file, effectiveStartLine, maxLines, maxBytes, startOffset);
      return {
        path: canonicalPath,
        text: result.text,
        nextLine: result.nextLine,
        nextOffset: result.nextOffset,
        size: fileInfo.size,
        modifiedAt: fileInfo.mtimeMs,
        hasMore: result.hasMore,
      };
    }
    if (fileInfo.size > maxBytes) {
      throw new Error(
        `file exceeds the ${maxBytes}-byte read limit; retry with startLine: 1 and maxLines up to ${maxLinesPerRead} (long lines are truncated automatically), then continue at the next line reported in the range header`,
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
    if (content.includes(0)) throw new Error("binary files are not supported");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch (error) {
      throw new Error("file is not valid UTF-8", { cause: error });
    }
    return {
      path: canonicalPath,
      text,
      nextLine: 1,
      nextOffset: content.byteLength,
      size: fileInfo.size,
      modifiedAt: fileInfo.mtimeMs,
      hasMore: false,
    };
  } finally {
    await file.close();
  }
}

export async function readAllowedFile(
  requestedPath: string,
  allowedRoots: string[],
  maxBytes = maxReadBytes,
  range?: ReadFileRange,
): Promise<string> {
  const result = await readAllowedFileChunk(requestedPath, allowedRoots, maxBytes, range);
  return result.text;
}

export function createFsReadExtension(
  allowedRoots: string[],
  gitGrep?: GitGrep,
  gitDiff?: (path?: string) => Promise<{ diff: string; truncated: boolean }>,
  repeatReadHintAfter = 5,
): (pi: ExtensionAPI) => void {
  const roots = allowedRoots.map((root) => resolve(root));
  return (pi) => {
    const fileCursors = new Map<string, ReadFileCursor>();
    /** 同一轮内按规范化路径累计读取次数，避免模型因上下文裁剪反复重读同一文件。 */
    const readCounts = new Map<string, number>();
    pi.registerTool({
      name: "read_file",
      label: "Read file",
      executionMode: "parallel",
      description: `Read a UTF-8 text file without modifying it. Use repository-relative paths for repository files; absolute paths are rejected for the worktree and are only accepted for trusted skill roots: ${roots.slice(1).join(", ") || "(none)"}. Files are limited to ${maxReadBytes} output bytes per call and each line is capped at ${maxLineBytes} bytes (longer lines are truncated with a marker, which is normal for minified bundles). For large files, set startLine and maxLines (up to ${maxLinesPerRead}) and request subsequent ranges as needed.`,
      promptSnippet: "read_file: Read a UTF-8 text file from the fixed repository worktree or trusted skill roots. Use startLine and maxLines to read large files in bounded ranges.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: maxLinesPerRead })),
      }),
      execute: async (_toolCallId, params) => {
        const path = await requireRelativeRepoPath(params.path, roots);
        const range = {
          startLine: params.startLine,
          maxLines: params.maxLines,
        };
        const hasRange = range.startLine !== undefined || range.maxLines !== undefined;
        const cached = hasRange ? fileCursors.get(path) : undefined;
        const result = await readAllowedFileChunk(path, roots, maxReadBytes, range, cached);
        if (hasRange && result.hasMore) {
          fileCursors.set(path, {
            nextLine: result.nextLine,
            nextOffset: result.nextOffset,
            size: result.size,
            modifiedAt: result.modifiedAt,
          });
        } else {
          fileCursors.delete(path);
        }
        const count = (readCounts.get(path) ?? 0) + 1;
        readCounts.set(path, count);
        // 只追加短提示，不截断结果本身：模型仍能看到所需内容，但会被引导换更窄的范围。
        const hint = repeatReadHintAfter > 0 && count >= repeatReadHintAfter
          ? `\n\n[Corvex: "${params.path}" has been read ${count} times in this turn. If the needed content is already in context, use a narrower startLine/maxLines range or search_text instead of re-reading the whole file.]`
          : "";
        return {
          content: [{ type: "text", text: `${result.text}${hint}` }],
          details: {},
        };
      },
    });
    pi.registerTool({
      name: "read_dir",
      label: "List directory",
      executionMode: "parallel",
      description: `List up to ${maxDirectoryEntries} immediate entries in a directory under the fixed repository worktree or trusted skill roots. Use this to inspect actual names after a read_file ENOENT; entries are not followed recursively.`,
      promptSnippet: "read_dir: List immediate directory entries when a requested path is missing or its actual name is uncertain.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await readAllowedDirectory(await requireRelativeRepoPath(params.path, roots), roots)) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "tree",
      label: "List bounded directory tree",
      executionMode: "parallel",
      description: `Show a bounded directory skeleton under a repository-relative path to understand the layout before reading files. Depth is limited to ${maxTreeDepth} levels, ${maxTreeNodes} nodes and ${maxTreeBytes} output bytes; .git, node_modules, dist, coverage, .next and .turbo are skipped and symlinks are never followed. Results are sorted and marked truncated when a limit is hit, so narrow the path or use read_dir for the rest.`,
      promptSnippet: "tree: Get a bounded directory skeleton once to orient, then read only the files you need.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTreeDepth })),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{
          type: "text",
          text: renderDirectoryTree(await readAllowedTree(
            await requireRelativeRepoPath(params.path ?? ".", roots), roots, { maxDepth: params.maxDepth },
          )),
        }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "stat",
      label: "Inspect path",
      executionMode: "parallel",
      description: "Inspect a file or directory under the fixed repository worktree or trusted skill roots. Returns the canonical repository-relative path and whether it is a file, directory, or other entry.",
      promptSnippet: "stat: Verify an exact candidate path and determine whether it is a file or directory before retrying read_file.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: JSON.stringify(await statAllowedPath(await requireRelativeRepoPath(params.path, roots), roots)) }],
        details: {},
      }),
    });
    pi.registerTool({
      name: "search_text",
      label: "Search repository text",
      executionMode: "parallel",
      description: `Search for a literal text string in UTF-8 files under the fixed repository worktree or trusted skill roots. Search skips .git, node_modules, dist, coverage, .next, and .turbo. Each call scans at most ${maxSearchFiles} files and ${maxSearchTotalBytes} bytes, reads at most ${maxSearchFileBytes} bytes per file, and returns at most ${maxSearchResults} matches with bounded line text. Use path to narrow the search and treat truncated results as incomplete.`,
      promptSnippet: "search_text: Find a literal string in bounded repository files; narrow with path and inspect matching files with read_file.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: maxSearchQueryCharacters }),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        caseSensitive: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{
          type: "text",
          text: JSON.stringify(await searchAllowedFiles(params.query, await requireRelativeRepoPath(params.path ?? ".", roots), roots, params.caseSensitive)),
        }],
        details: {},
      }),
    });
    if (gitGrep) {
      pi.registerTool({
        name: "git_grep",
        label: "Search pinned Git tree",
        executionMode: "parallel",
        description: "Search tracked files in the exact pinned workspace HEAD using a bounded literal query. This does not inspect working-tree or untracked content. Narrow the search with a repository-relative path and inspect results with read_file.",
        promptSnippet: "git_grep: Search tracked files at the pinned HEAD with a literal query; use path to narrow results and read_file to inspect matches.",
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: maxSearchQueryCharacters }),
          path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        }),
        execute: async (_toolCallId, params) => ({
          content: [{
            type: "text",
            text: JSON.stringify(await gitGrep(params.query, params.path ?? ".")),
          }],
          details: {},
        }),
      });
    }
    if (gitDiff) {
      pi.registerTool({
        name: "git_diff",
        label: "Inspect workspace diff",
        executionMode: "sequential",
        description: "Read staged and unstaged changes in the current isolated Git worktree compared with HEAD. Output is capped at 32 KiB; provide a repository-relative path to narrow a large diff.",
        promptSnippet: "git_diff: Inspect current staged and unstaged worktree changes. If truncated, request a narrower path.",
        parameters: Type.Object({
          path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        }),
        execute: async (_toolCallId, params) => ({
          content: [{ type: "text", text: JSON.stringify(await gitDiff(params.path)) }],
          details: {},
        }),
      });
    }
  };
}
