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

export interface JobListQuery {
  status?: JobStatus;
  type?: JobType;
  projectId?: number;
  mrIid?: number;
  search?: string;
  limit: number;
  offset: number;
}

export interface JobPage {
  items: JobSummary[];
  total: number;
}

export interface JobAttemptSummary {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  error: string;
}

export interface JobStatusTransition {
  from: JobStatus;
  to: JobStatus;
  at: string;
}

export interface JobDetails extends JobSummary {
  attempts: JobAttemptSummary[];
  timeline: JobStatusTransition[];
}

export interface OperationsOverview {
  counts: Record<JobStatus, number>;
  oldestQueuedAt: string | null;
  workers: {
    onlineCount: number;
    lastSeenAt: string | null;
  };
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
