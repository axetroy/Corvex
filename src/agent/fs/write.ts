import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toWorktreeRelative, virtualizeError } from "./virtual-path.js";

/** 单次写入的内容上限：与仓库只读工具的输出预算保持一致。 */
export const maxWriteBytes = 256 << 10;
/** 单次替换的片段长度上限，避免把整个文件当 old_string 反复传输。 */
export const maxReplaceBytes = 64 << 10;

export interface FsWriteResult {
  path: string;
  bytes: number;
  replaced?: number;
}

/** 会话文件系统的全部写入能力，由 Runner 绑定到当前 worktree 后提供。 */
export interface WorkspaceFs {
  writeFile(path: string, content: string): Promise<FsWriteResult>;
  editFile(path: string, oldString: string, newString: string, replaceAll: boolean): Promise<FsWriteResult>;
  deleteFile(path: string): Promise<FsWriteResult>;
  moveFile(from: string, to: string, overwrite: boolean): Promise<FsWriteResult>;
  copyFile(from: string, to: string, overwrite: boolean): Promise<FsWriteResult>;
}

/**
 * 写入路径守卫：与读取工具共用虚拟协议，接受 worktree:// 或纯相对路径，
 * 拒绝宿主绝对路径、其它协议、上层遍历、.git 与符号链接。
 * Runner 与工具共用同一份实现，避免新增工具时漏掉校验。
 */
export async function resolveWorktreePath(
  workspacePath: string,
  requested: string,
): Promise<{ root: string; target: string; path: string }> {
  const relativePath = toWorktreeRelative(requested);
  if ([...relativePath].length > 4096) throw new Error("invalid file path");
  const parts = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid repository-relative path");
  }
  if (parts[0] === ".git") throw new Error("writing .git is not allowed");
  // realpath 的异常信息会带 cwd 绝对路径，统一改成不含宿主机路径的文案。
  const root = await realpath(workspacePath).catch((error: unknown) => {
    throw new Error("conversation worktree is unavailable", { cause: error });
  });
  const target = resolve(root, ...parts);
  const parent = await realpath(dirname(target)).catch(() => dirname(target));
  const inside = relative(root, parent);
  if (inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error("file path escapes the conversation worktree");
  }
  const existing = await lstat(target).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new Error("cannot write through a symbolic link");
  return { root, target, path: parts.join("/") };
}

/** 精确替换文本：默认要求唯一匹配，replace_all 时替换全部。 */
export function replaceTextExactly(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { updated: string; replaced: number } {
  if (!oldString || Buffer.byteLength(oldString) > maxReplaceBytes) {
    throw new Error(`old_string must be 1-${maxReplaceBytes} bytes`);
  }
  if (Buffer.byteLength(newString) > maxReplaceBytes) {
    throw new Error(`new_string exceeds the ${maxReplaceBytes}-byte limit`);
  }
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) throw new Error("old_string was not found in the file");
  if (!replaceAll && occurrences > 1) {
    throw new Error(`old_string matched ${occurrences} times; add surrounding context or set replace_all`);
  }
  return {
    updated: replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString),
    replaced: replaceAll ? occurrences : 1,
  };
}

const pathField = Type.String({ minLength: 1, maxLength: 4096 });

/** 对话场景的文件写入工具集：路径与内容限制由 WorkspaceFs 在边界处强制。 */
export function createFsWriteExtension(fs: WorkspaceFs): (pi: ExtensionAPI) => void {
  // 写工具统一在错误出口脱敏，避免底层 fs/git 异常把宿主机路径带进模型上下文。
  const result = async (action: Promise<FsWriteResult>) => {
    try {
      return textResult(await action);
    } catch (error) {
      throw new Error(virtualizeError(error, []), { cause: error });
    }
  };
  return (pi) => {
    pi.registerTool({
      name: "write_file",
      label: "Write file",
      executionMode: "sequential",
      description:
        `Create or overwrite a UTF-8 text file inside this conversation's worktree. ` +
        `Use a worktree:// URI (or a plain worktree-relative path); host absolute paths are rejected. Content is limited to ${maxWriteBytes} bytes. ` +
        "Use edit_file for small changes to existing files instead of rewriting the whole file. " +
        "Changes are saved to this conversation only and are never pushed to GitLab. " +
        "Do not write binary files, build output, or dependency directories.",
      promptSnippet: "write_file: Create or overwrite one UTF-8 text file via worktree:// URI in the pinned conversation worktree.",
      parameters: Type.Object({ path: pathField, content: Type.String({ maxLength: maxWriteBytes }) }),
      execute: async (_id, params) => result(fs.writeFile(params.path, params.content)),
    });
    pi.registerTool({
      name: "edit_file",
      label: "Edit file",
      executionMode: "sequential",
      description:
        `Replace an exact string in an existing UTF-8 text file in this conversation's worktree. ` +
        `old_string must match the file content exactly (including whitespace) and is limited to ${maxReplaceBytes} bytes. ` +
        "By default it must match exactly once; set replace_all to replace every occurrence. " +
        "Use a few surrounding lines in old_string to make the match unique. " +
        "Use write_file only for new files or full rewrites.",
      promptSnippet: "edit_file: Replace an exact old_string with new_string in one worktree file.",
      parameters: Type.Object({
        path: pathField,
        old_string: Type.String({ minLength: 1, maxLength: maxReplaceBytes }),
        new_string: Type.String({ maxLength: maxReplaceBytes }),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => result(fs.editFile(
        params.path, params.old_string, params.new_string, params.replace_all ?? false,
      )),
    });
    pi.registerTool({
      name: "delete_file",
      label: "Delete file",
      executionMode: "sequential",
      description:
        "Delete one file in the conversation worktree. The path must be a worktree:// URI or worktree-relative; " +
        "symlinks and .git paths are rejected. Use it to remove files you created or obsolete files.",
      promptSnippet: "delete_file: Remove one worktree file by worktree:// URI or relative path.",
      parameters: Type.Object({ path: pathField }),
      execute: async (_id, params) => result(fs.deleteFile(params.path)),
    });
    pi.registerTool({
      name: "move_file",
      label: "Move file",
      executionMode: "sequential",
      description:
        "Move or rename one file in the conversation worktree. Both paths must use worktree:// URIs or be worktree-relative. " +
        "If the destination exists, the move fails; use overwrite only when you intend to replace it. " +
        "The file content is never read into the conversation context.",
      promptSnippet: "move_file: Rename or move one worktree file between worktree:// URIs or relative paths.",
      parameters: Type.Object({
        from: pathField,
        to: pathField,
        overwrite: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => result(fs.moveFile(params.from, params.to, params.overwrite ?? false)),
    });
    pi.registerTool({
      name: "copy_file",
      label: "Copy file",
      executionMode: "sequential",
      description:
        "Copy one file in the conversation worktree to another worktree:// URI or relative path. " +
        "If the destination exists, the copy fails; set overwrite only when you intend to replace it. " +
        "The file content is never read into the conversation context.",
      promptSnippet: "copy_file: Copy one worktree file to another worktree:// URI or relative path.",
      parameters: Type.Object({
        from: pathField,
        to: pathField,
        overwrite: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, params) => result(fs.copyFile(params.from, params.to, params.overwrite ?? false)),
    });
  };
}

function textResult(result: FsWriteResult) {
  // 返回值统一用虚拟路径，与读取工具保持同一协议。
  const displayed = { ...result, path: `worktree://${result.path}` };
  return { content: [{ type: "text" as const, text: JSON.stringify(displayed) }], details: {} };
}
