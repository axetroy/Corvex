import { LocalFileSource } from "./local-source.js";
import type { ConversationFileSource } from "./source.js";

export interface FileSourceOptions {
  /** 本地 worktree 的绝对路径。 */
  workspacePath: string;
}

/** 会话文件浏览只读取当前 worktree，保证看到的是本会话实际改动过的文件。 */
export function createConversationFileSource(options: FileSourceOptions): ConversationFileSource {
  return new LocalFileSource(options.workspacePath);
}
