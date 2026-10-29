import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const maxReadBytes = 64 << 10;
const defaultMaxLines = 200;
const maxLinesPerRead = 1000;

interface ReadFileRange {
  startLine?: number;
  maxLines?: number;
}

// 使用相对路径判断目录边界，避免相邻目录因字符串前缀相同而被误判为子目录。
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
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
  if (!requestedPath.trim() || requestedPath.includes("\0")) {
    throw new Error("file path is empty or invalid");
  }
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
  if (allowedRoots.length === 0) throw new Error("no file read roots are configured");

  const roots = await Promise.all(allowedRoots.map((root) => realpath(root)));
  const candidate = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(roots[0]!, requestedPath);
  const canonicalPath = await realpath(candidate);
  if (!roots.some((root) => isWithin(root, canonicalPath))) {
    throw new Error("file path is outside the configured read-only roots");
  }

  const file = await open(canonicalPath, "r");
  let content: Buffer;
  try {
    const fileInfo = await file.stat();
    if (!fileInfo.isFile()) throw new Error("requested path is not a regular file");
    if (hasRange) return await readLineRange(file, startLine, maxLines, maxBytes);
    if (fileInfo.size > maxBytes) {
      throw new Error(`file exceeds the ${maxBytes}-byte read limit; use startLine and maxLines to read it in ranges`);
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
  };
}
