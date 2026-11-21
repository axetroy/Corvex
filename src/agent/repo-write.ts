import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 单次写入的内容上限：与仓库只读工具的输出预算保持一致。 */
export const maxWriteBytes = 256 << 10;
/** 单次替换的片段长度上限，避免把整个文件当 old_string 反复传输。 */
export const maxReplaceBytes = 64 << 10;

export interface RepoWriteResult {
  path: string;
  bytes: number;
  replaced?: number;
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

export interface RepoWriter {
  writeFile(path: string, content: string): Promise<RepoWriteResult>;
  editFile(path: string, oldString: string, newString: string, replaceAll: boolean): Promise<RepoWriteResult>;
}

/**
 * 对话场景的本地文件写入工具：只能写该会话绑定的 worktree，
 * 路径与内容限制由传入的 writer 在边界处强制，工具本身不接触文件系统。
 * write_file 用于整文件覆盖，edit_file 用于小而精确的字符串替换。
 */
export function createRepoWriteExtension(writer: RepoWriter): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "write_file",
      label: "Write file",
      executionMode: "sequential",
      description:
        `Create or overwrite a UTF-8 text file inside this conversation's worktree. ` +
        `Use a repository-relative path; absolute paths are rejected. Content is limited to ${maxWriteBytes} bytes. ` +
        "Use edit_file for small changes to existing files instead of rewriting the whole file. " +
        "Changes are saved to this conversation only and are never pushed to GitLab. " +
        "Do not write binary files, build output, or dependency directories.",
      promptSnippet: "write_file: Create or overwrite one UTF-8 text file in the pinned conversation worktree.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        content: Type.String({ maxLength: maxWriteBytes }),
      }),
      execute: async (_toolCallId, params) => {
        const result = await writer.writeFile(params.path, params.content);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      },
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
        path: Type.String({ minLength: 1, maxLength: 4096 }),
        old_string: Type.String({ minLength: 1, maxLength: maxReplaceBytes }),
        new_string: Type.String({ maxLength: maxReplaceBytes }),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      execute: async (_toolCallId, params) => {
        const result = await writer.editFile(
          params.path,
          params.old_string,
          params.new_string,
          params.replace_all ?? false,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      },
    });
  };
}
