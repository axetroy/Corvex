export interface Change {
  path: string;
  status: string;
  addedLines: number;
  removedLines: number;
  patch: string;
  skipped: string;
}

export interface DiffResult {
  baseSha: string;
  headSha: string;
  changes: Change[];
  skippedFiles: number;
}

export interface Workspace {
  projectId: number;
  jobId: string;
  path: string;
  headSha: string;
}
