export const jobTypes = ["review", "fix", "explain"] as const;
export type JobType = (typeof jobTypes)[number];

export const jobStatuses = [
  "queued",
  "preparing",
  "analyzing",
  "fixing",
  "verifying",
  "publishing",
  "completed",
  "failed",
  "stale",
  "cancelled",
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  projectId: number;
  mrIid: number;
  headSha: string;
  actorId: number;
  request: string;
  createdAt: string;
  attemptCount: number;
  lastError: string;
  cancellationRequested: boolean;
  leaseToken: string;
  failureStage: JobStatus | "";
}

export interface JobSummary extends Omit<Job, "leaseToken"> {
  updatedAt: string;
}

export interface EventResult {
  response: string;
  delivered: boolean;
}

export interface ModelCallMetric {
  taskType: JobType;
  outcome: "success" | "failure";
  calls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}
