import { Type } from "typebox";
import type {
  CreatedIssue,
  CreatedMergeRequest,
  GitLabListState,
  GitLabWriteReceipt,
  IssueCreate,
  IssueSummary,
  IssueUpdate,
  MergeRequestChanges,
  MergeRequestCommitPage,
  MergeRequestCreate,
  MergeRequestDiscussionList,
  MergeRequestMergeOptions,
  MergeRequestMetadataUpdate,
  MergeRequestSummary,
} from "../../gitlab/client.js";

/**
 * 绑定到当前会话项目的 GitLab 能力集合；iid 一律由用户或读取结果提供，
 * 写操作只在用户明确要求时调用。这里不暴露 projectId 参数，避免跨项目操作。
 */
export interface GitLabAgentTools {
  getProject(): Promise<unknown>;
  listIssues(options: { search?: string; state?: GitLabListState; page?: number; perPage?: number }): Promise<IssueSummary[]>;
  listMergeRequests(options: { search?: string; state?: GitLabListState; page?: number; perPage?: number }): Promise<MergeRequestSummary[]>;
  getIssue(issueIid: number): Promise<unknown>;
  getMergeRequest(mrIid: number): Promise<unknown>;
  getMergeRequestChanges(mrIid: number): Promise<MergeRequestChanges>;
  getIssueComments(issueIid: number, limit: number): Promise<unknown>;
  getMergeRequestComments(mrIid: number, limit: number): Promise<unknown>;
  getMergeRequestCommits(mrIid: number, page: number, perPage: number): Promise<MergeRequestCommitPage>;
  createIssue(input: IssueCreate): Promise<CreatedIssue>;
  updateIssue(issueIid: number, update: IssueUpdate): Promise<GitLabWriteReceipt>;
  deleteIssue(issueIid: number): Promise<GitLabWriteReceipt>;
  postIssueNote(issueIid: number, body: string): Promise<GitLabWriteReceipt>;
  updateIssueNote(issueIid: number, noteId: number, body: string): Promise<GitLabWriteReceipt>;
  deleteIssueNote(issueIid: number, noteId: number): Promise<GitLabWriteReceipt>;
  createMergeRequest(input: MergeRequestCreate): Promise<CreatedMergeRequest>;
  updateMergeRequest(mrIid: number, update: MergeRequestMetadataUpdate): Promise<GitLabWriteReceipt>;
  deleteMergeRequest(mrIid: number): Promise<GitLabWriteReceipt>;
  mergeMergeRequest(mrIid: number, options: MergeRequestMergeOptions): Promise<GitLabWriteReceipt>;
  approveMergeRequest(mrIid: number): Promise<GitLabWriteReceipt>;
  unapproveMergeRequest(mrIid: number): Promise<GitLabWriteReceipt>;
  postMergeRequestNote(mrIid: number, body: string): Promise<GitLabWriteReceipt>;
  updateMergeRequestNote(mrIid: number, noteId: number, body: string): Promise<GitLabWriteReceipt>;
  deleteMergeRequestNote(mrIid: number, noteId: number): Promise<GitLabWriteReceipt>;
  listMergeRequestDiscussions(mrIid: number): Promise<MergeRequestDiscussionList>;
  resolveDiscussion(mrIid: number, discussionId: string, resolve: boolean): Promise<GitLabWriteReceipt>;
}

export const iidParam = Type.Integer({ minimum: 1 });
export const noteIdParam = Type.Integer({ minimum: 1 });
export const bodyParam = Type.String({ minLength: 1, maxLength: 100_000 });
export const limitParam = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));
export const stateParam = Type.Optional(Type.Union([
  Type.Literal("opened"), Type.Literal("closed"), Type.Literal("all"),
]));
export const pageParam = Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }));
export const perPageParam = Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }));
export const labelsParam = Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 20 }));
export const assigneeIdsParam = Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 10 }));
export const milestoneIdParam = Type.Optional(Type.Integer({ minimum: 1 }));

/** 工具结果统一序列化为文本；错误由 Pi 的工具调用链路记录到轨迹。 */
export function text(value: unknown): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  // 避免 undefined 序列化后留下没有 text 字段的 content 项，导致 SDK 读取 text.length 崩溃。
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], details: {} };
}
