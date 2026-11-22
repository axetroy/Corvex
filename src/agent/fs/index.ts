/** 对话 worktree 的受约束文件读写工具：只读工具与写入工具共用同一路径边界。 */
export {
  requireRelativeRepoPath,
  readAllowedDirectory,
  statAllowedPath,
  searchAllowedFiles,
  readAllowedFile,
  createFsReadExtension,
  type SearchMatch,
  type SearchResult,
  type GitGrepResult,
  type GitGrep,
} from "./read.js";

export {
  maxWriteBytes,
  maxReplaceBytes,
  resolveWorktreePath,
  replaceTextExactly,
  createFsWriteExtension,
  type FsWriteResult,
  type WorkspaceFs,
} from "./write.js";
