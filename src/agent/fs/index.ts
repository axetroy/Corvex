/** 对话 worktree 的受约束文件读写工具：只读工具与写入工具共用同一路径边界。 */
export {
  requireRelativeRepoPath,
  readAllowedDirectory,
  readAllowedTree,
  renderDirectoryTree,
  statAllowedPath,
  searchAllowedFiles,
  findAllowedFiles,
  readAllowedFile,
  createFsReadExtension,
  type TreeEntry,
  type TreeResult,
  type SearchMatch,
  type SearchResult,
  type GlobResult,
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
