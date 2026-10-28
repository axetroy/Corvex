import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const maxReadBytes = 64 << 10;

// 使用相对路径判断目录边界，避免相邻目录因字符串前缀相同而被误判为子目录。
function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function readAllowedFile(
  requestedPath: string,
  allowedRoots: string[],
  maxBytes = maxReadBytes,
): Promise<string> {
  if (!requestedPath.trim() || requestedPath.includes("\0")) {
    throw new Error("file path is empty or invalid");
  }
  if (maxBytes <= 0 || maxBytes > maxReadBytes) {
    throw new Error(`file read limit must be between 1 and ${maxReadBytes} bytes`);
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
    if (fileInfo.size > maxBytes) {
      throw new Error(`file exceeds the ${maxBytes}-byte read limit`);
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
      description: `Read a UTF-8 text file without modifying it. Relative paths resolve from ${roots[0]}. Absolute paths are allowed only within these roots: ${roots.join(", ")}. Files are limited to ${maxReadBytes} bytes.`,
      promptSnippet: "read_file: Read a UTF-8 text file from the fixed repository worktree or trusted skill roots.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
      }),
      execute: async (_toolCallId, params) => ({
        content: [{ type: "text", text: await readAllowedFile(params.path, roots) }],
        details: {},
      }),
    });
  };
}
