import { timingSafeEqual } from "node:crypto";
import { isRecord } from "../guards.js";

/** 单个 GitLab Webhook 请求体允许的最大字节数。 */
export const MAX_WEBHOOK_BODY_BYTES = 1 << 20;

interface NoteEventBase {
  object_kind: string;
  user: { id: number; username: string };
  project: { id: number };
  object_attributes: {
    id: number;
    note: string;
    noteable_type: string;
    system: boolean;
  };
}

export interface NoteEvent extends NoteEventBase {
  object_attributes: NoteEventBase["object_attributes"] & { noteable_type: "MergeRequest" };
  merge_request: {
    iid: number;
    last_commit?: { id?: string };
  };
}

export interface IssueNoteEvent extends NoteEventBase {
  object_attributes: NoteEventBase["object_attributes"] & { noteable_type: "Issue" };
  issue: { iid: number };
}

export function isIssueNoteEvent(event: NoteEvent | IssueNoteEvent): event is IssueNoteEvent {
  return "issue" in event;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function validateWebhookToken(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function parseNoteEventBody(body: Uint8Array): Record<string, unknown> {
  if (body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error("GitLab webhook payload exceeds 1 MiB");
  }
  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new Error(`decode GitLab note event: ${String(error)}`, { cause: error });
  }
  if (!isRecord(event)) throw new Error("incomplete or unsupported GitLab note event");
  return event;
}

function asNoteEvent(event: Record<string, unknown>): NoteEvent {
  const user = event.user;
  const project = event.project;
  const attributes = event.object_attributes;
  const mergeRequest = event.merge_request;
  if (
    event.object_kind !== "note" ||
    !isRecord(user) ||
    !isRecord(project) ||
    !isRecord(attributes) ||
    !isRecord(mergeRequest) ||
    attributes.noteable_type !== "MergeRequest" ||
    !positiveInteger(attributes.id) ||
    !positiveInteger(project.id) ||
    !positiveInteger(mergeRequest.iid) ||
    !positiveInteger(user.id) ||
    typeof attributes.note !== "string" ||
    typeof user.username !== "string" ||
    typeof attributes.system !== "boolean"
  ) {
    throw new Error("incomplete or unsupported GitLab note event");
  }
  return event as unknown as NoteEvent;
}

function asIssueNoteEvent(event: Record<string, unknown>): IssueNoteEvent {
  const user = event.user;
  const project = event.project;
  const attributes = event.object_attributes;
  const issue = event.issue;
  if (
    event.object_kind !== "note" ||
    !isRecord(user) ||
    !isRecord(project) ||
    !isRecord(attributes) ||
    !isRecord(issue) ||
    attributes.noteable_type !== "Issue" ||
    !positiveInteger(attributes.id) ||
    !positiveInteger(project.id) ||
    !positiveInteger(issue.iid) ||
    !positiveInteger(user.id) ||
    typeof attributes.note !== "string" ||
    typeof user.username !== "string" ||
    typeof attributes.system !== "boolean"
  ) {
    throw new Error("incomplete or unsupported GitLab issue note event");
  }
  return event as unknown as IssueNoteEvent;
}

export function decodeNoteEvent(body: Uint8Array): NoteEvent {
  return asNoteEvent(parseNoteEventBody(body));
}

export function decodeIssueNoteEvent(body: Uint8Array): IssueNoteEvent {
  return asIssueNoteEvent(parseNoteEventBody(body));
}

export function decodeGitLabNoteEvent(body: Uint8Array): NoteEvent | IssueNoteEvent {
  const event = parseNoteEventBody(body);
  const attributes = event.object_attributes;
  if (isRecord(attributes) && attributes.noteable_type === "Issue") return asIssueNoteEvent(event);
  return asNoteEvent(event);
}
