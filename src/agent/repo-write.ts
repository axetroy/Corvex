import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 单次写入的内容上限：与仓库只读工具的输出预算保持一致。 */
export const maxWriteBytes = 256 << 10;

export interface RepoWriteResult {
  path: string;
  bytes: number;
}

export interface RepoWriter {
  writeFile(path: string, content: string): Promise<RepoWriteResult>;
}

/**
 * 对话场景的本地文件写入工具：只能写该会话绑定的 worktree，
 * 路径与内容限制由传入的 writer 在边界处强制，工具本身不接触文件系统。
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
  };
}
