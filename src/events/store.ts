import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  backup as sqliteBackup,
  DatabaseSync,
} from "node:sqlite";
import type { AuthUser, GitLabIdentity, ManagedUser } from "../app/auth/model.js";
import type { TokenCipher } from "../tokens.js";
import {
  defaultConversationMode,
  isConversationMode,
  isConversationTurnStatus,
  isEventStatus,
  isEventType,
  isModelTaskType,
  normalizeConversationTitle,
  type Conversation,
  type ConversationMessage,
  type ConversationPage,
  type ConversationProcessEntry,
  type ConversationSummary,
  type ConversationToolCall,
  type ConversationTurn,
  type ConversationTurnContext,
  type ConversationStats,
  type ConversationTurnStats,
  type ConversationTurnStatus,
  type CreatedConversationTurn,
  type CreateConversationInput,
  type ExecutionStep,
  type ExecutionStepStatus,
  type Event,
  type EventAttemptSummary,
  type EventDetails,
  type EventListQuery,
  type EventOperationsSummary,
  type EventPage,
  type EventResult,
  type EventSummary,
  type EventStatus,
  type EventTargetType,
  type EventStatusTransition,
  type EventTraceEntry,
  type EventTraceKind,
  type EventTraceStatus,
  type EventType,
  type ConversationTurnSegment,
  type StorageCleanupRecord,
  type ActiveModel,
  type ResponseLanguage,
  type ModelProvider,
  type ModelProviderDetails,
  type ModelProviderInput,
  type UserModelSelection,
  type ProviderModel,
  type ProviderModelInput,
  type ConversationTurnTransition,
  type ConversationTurns,
  type ModelCallMetric,
  type ModelTaskType,
  type OperationsOverview,
  type StatusTransition,
  type TraceScope,
} from "./model.js";

/** 事件执行器从开始到终止状态允许执行的最大尝试次数。 */
const maxAttempts = 3;
/** 已完成、失败、过期或取消的终态事件集合。 */
const terminal = new Set<EventStatus>(["completed", "failed", "stale", "cancelled"]);
/** 已结束的对话轮次状态；仅这些轮次的耗时才算已确定。 */
const terminalConversationTurn = new Set<ConversationTurnStatus>(["completed", "failed", "stale", "cancelled"]);
/** 持有租约期间可能运行的状态，用于检测并恢复过期租约。 */
const active = ["preparing", "analyzing", "fixing", "verifying", "publishing"];
/** 单条持久化执行轨迹输入或输出允许保存的最大字节数。 */
const maxExecutionPayloadBytes = 64 << 10;
/** 执行轨迹中用于识别并脱敏凭证类字段名的匹配规则。 */
const sensitiveField = /token|secret|password|api[_-]?key|authorization|cookie|credential/i;
/** 对话列表每条助手回复附带展示的工具调用条数上限，超出只保留最早的调用。 */
const maxConversationToolCalls = 50;
/** 对话列表工具调用参数展示的最大字节数，避免把整段轨迹负载塞进列表接口。 */
const maxConversationToolInputBytes = 2048;
/** 单轮对话过程落库的最大条目数；超出时只保留最近的过程，避免长任务撑大数据库。 */
const maxConversationProcessEntries = 400;
/** 单轮对话过程落库的最大字节数；超限时从最早条目开始丢弃。 */
const maxConversationProcessBytes = 256 << 10;
/** 过程条目里单段文本/工具参数的字符上限，按与轨迹相同的规则脱敏后截断。 */
const maxConversationProcessTextChars = 20_000;
const maxConversationProcessInputChars = 8_000;
/** 单次对话轮次注入模型上下文的历史消息条数上限，按最近优先截断。 */
/** 滚动摘要的最大字符数，避免摘要本身撑大提示词。 */
const maxConversationSummaryCharacters = 4_000;
/** 模型生成的对话标题最大字符数，避免超长标题破坏列表布局。 */
const maxConversationTitleCharacters = 120;

interface ConversationTurnRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  user_message_id: string | null;
  status: ConversationTurnStatus;
  request: string;
  head_sha: string;
  actor_id: number;
  attempt_count: number;
  last_error: string;
  process: string;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  type: EventType;
  status: EventStatus;
  project_id: number;
  mr_iid: number;
  target_type: EventTargetType;
  target_iid: number;
  target_branch: string;
  head_sha: string;
  actor_id: number;
  request: string;
  created_at: string;
  attempt_count: number;
  last_error: string;
  cancel_requested: number;
  lease_token: string;
  failure_stage: string;
  updated_at: string;
}

function stringColumn(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`SQLite column "${name}" is not text`);
  return value;
}

function numberColumn(row: Record<string, unknown>, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`SQLite column "${name}" is not a safe integer`);
  }
  return value;
}

/** 从 Base URL 推导供应商标识，用于迁移旧配置或分类时给供应商起名。 */
function providerName(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** 轨迹归属对应的 owner 列名：事件轨迹用 `event_id`，对话轨迹用 `turn_id`。 */
function traceScopeColumn(scope: TraceScope): "event_id" | "turn_id" {
  return scope.kind === "event" ? "event_id" : "turn_id";
}

/** 轨迹归属对应的 owner 主键；校验为空或超长时抛错。 */
function traceScopeId(scope: TraceScope): string {
  const id = scope.kind === "event" ? scope.eventId : scope.turnId;
  if (!id.trim() || id.length > 256) throw new Error("trace scope ID is invalid");
  return id;
}

/**
 * 事件从创建到最近更新的耗时（毫秒）。仅终态事件的耗时已确定；
 * 时间缺失或倒序（时钟回拨）时返回 null，避免统计出现负值。
 */
function turnDurationMs(createdAt: string, updatedAt: string, isTerminal: boolean): number | null {
  if (!isTerminal) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function redactTraceText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b(?:glpat-|glrt-|gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/\b(token|secret|api[_-]?key|password|authorization|private[_-]?token|client[_-]?secret)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/([?&](?:access[_-]?token|token|key|secret|password|signature|auth)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
}

function sanitizeTraceValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactTraceText(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeTraceValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 500).map(([key, item]) => [
        key,
        sensitiveField.test(key) ? "[REDACTED]" : sanitizeTraceValue(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return String(value);
  return value;
}

function serializeTraceValue(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(sanitizeTraceValue(value));
  if (Buffer.byteLength(serialized) <= maxExecutionPayloadBytes) return serialized;
  const bytes = Buffer.from(serialized);
  let previewBytes = maxExecutionPayloadBytes - 1024;
  let truncated = JSON.stringify({
    truncated: true,
    originalBytes: bytes.byteLength,
    preview: bytes.subarray(0, previewBytes).toString("utf8"),
  });
  while (Buffer.byteLength(truncated) > maxExecutionPayloadBytes) {
    previewBytes = Math.floor(previewBytes * 0.9);
    truncated = JSON.stringify({
      truncated: true,
      originalBytes: bytes.byteLength,
      preview: bytes.subarray(0, previewBytes).toString("utf8"),
    });
  }
  return truncated;
}

/**
 * 净化并限长对话过程条目：与轨迹共用同一套凭证脱敏规则，
 * 工具参数再按字段过滤，避免把密钥或整段文件读进过程快照。
 */
function sanitizeConversationProcess(entries: readonly ConversationProcessEntry[]): ConversationProcessEntry[] {
  const clean = entries.slice(-maxConversationProcessEntries).map((entry): ConversationProcessEntry => {
    if (entry.kind === "tool") {
      return {
        ...entry,
        name: redactTraceText(entry.name).slice(0, 512),
        input: entry.input ? redactTraceText(entry.input).slice(0, maxConversationProcessInputChars) : null,
      };
    }
    return { ...entry, text: redactTraceText(entry.text).slice(0, maxConversationProcessTextChars) };
  });
  let serialized = JSON.stringify(clean);
  while (Buffer.byteLength(serialized) > maxConversationProcessBytes && clean.length > 1) {
    clean.shift();
    serialized = JSON.stringify(clean);
  }
  return JSON.parse(serialized) as ConversationProcessEntry[];
}

/** 从 SQLite 文本读取过程条目；损坏或形状不认识的条目直接丢弃，不让列表接口失败。 */
function readConversationProcess(raw: string): ConversationProcessEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value): ConversationProcessEntry[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const entry = value as Record<string, unknown>;
    if ((entry.kind === "thinking" || entry.kind === "text") && typeof entry.text === "string") {
      return [{ kind: entry.kind, text: entry.text }];
    }
    if (entry.kind === "context" && typeof entry.id === "string" && typeof entry.text === "string") {
      return [{ kind: "context", id: entry.id, text: entry.text }];
    }
    if (
      entry.kind === "tool" && typeof entry.name === "string" &&
      (entry.status === "running" || entry.status === "succeeded" || entry.status === "failed")
    ) {
      return [{
        kind: "tool",
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        name: entry.name,
        input: typeof entry.input === "string" ? entry.input : null,
        status: entry.status,
        durationMs: typeof entry.durationMs === "number" ? entry.durationMs : null,
      }];
    }
    return [];
  }).slice(-maxConversationProcessEntries);
}

function readEventRow(row: Record<string, unknown> | undefined): EventRow | undefined {
  if (!row) return undefined;
  const type = stringColumn(row, "type");
  if (!isEventType(type)) throw new Error(`SQLite event type "${type}" is invalid`);
  const status = stringColumn(row, "status");
  if (!isEventStatus(status)) throw new Error(`SQLite event status "${status}" is invalid`);
  const targetType = stringColumn(row, "target_type");
  if (targetType !== "merge_request" && targetType !== "issue" && targetType !== "repository") {
    throw new Error(`SQLite event target type "${targetType}" is invalid`);
  }
  const failureStage = stringColumn(row, "failure_stage");
  if (failureStage && !isEventStatus(failureStage)) {
    throw new Error(`SQLite event failure stage "${failureStage}" is invalid`);
  }
  return {
    id: stringColumn(row, "id"),
    type,
    status,
    project_id: numberColumn(row, "project_id"),
    mr_iid: numberColumn(row, "mr_iid"),
    target_type: targetType,
    target_iid: numberColumn(row, "target_iid"),
    target_branch: stringColumn(row, "target_branch"),
    head_sha: stringColumn(row, "head_sha"),
    actor_id: numberColumn(row, "actor_id"),
    request: stringColumn(row, "request"),
    created_at: stringColumn(row, "created_at"),
    attempt_count: numberColumn(row, "attempt_count"),
    last_error: stringColumn(row, "last_error"),
    cancel_requested: numberColumn(row, "cancel_requested"),
    lease_token: stringColumn(row, "lease_token"),
    failure_stage: failureStage,
    updated_at: stringColumn(row, "updated_at"),
  };
}

function readConversationTurnRow(row: Record<string, unknown> | undefined): ConversationTurnRow | undefined {
  if (!row) return undefined;
  const status = stringColumn(row, "status");
  if (!isConversationTurnStatus(status)) throw new Error(`SQLite conversation turn status "${status}" is invalid`);
  const nullableId = (name: string): string | null => {
    const value = row[name];
    if (value !== null && value !== undefined && typeof value !== "string") {
      throw new Error(`SQLite column "${name}" is not text or null`);
    }
    return typeof value === "string" ? value : null;
  };
  return {
    id: stringColumn(row, "id"),
    conversation_id: stringColumn(row, "conversation_id"),
    message_id: nullableId("message_id"),
    user_message_id: nullableId("user_message_id"),
    status,
    request: stringColumn(row, "request"),
    head_sha: stringColumn(row, "head_sha"),
    process: stringColumn(row, "process"),
    actor_id: numberColumn(row, "actor_id"),
    attempt_count: numberColumn(row, "attempt_count"),
    last_error: stringColumn(row, "last_error"),
    created_at: stringColumn(row, "created_at"),
    updated_at: stringColumn(row, "updated_at"),
  };
}

function readModelCallMetric(row: Record<string, unknown>): ModelCallMetric {
  const taskType = stringColumn(row, "taskType");
  if (!isModelTaskType(taskType)) throw new Error(`SQLite model metric task type "${taskType}" is invalid`);
  const outcome = stringColumn(row, "outcome");
  if (outcome !== "success" && outcome !== "failure") {
    throw new Error(`SQLite model metric outcome "${outcome}" is invalid`);
  }
  return {
    taskType,
    outcome,
    calls: numberColumn(row, "calls"),
    durationMs: numberColumn(row, "durationMs"),
    inputTokens: numberColumn(row, "inputTokens"),
    outputTokens: numberColumn(row, "outputTokens"),
  };
}

function readEventTrace(row: Record<string, unknown>): EventTraceEntry {
  const kind = stringColumn(row, "kind");
  if (kind !== "tool" && kind !== "llm" && kind !== "context") throw new Error(`SQLite event trace kind "${kind}" is invalid`);
  const status = stringColumn(row, "status");
  if (status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new Error(`SQLite event trace status "${status}" is invalid`);
  }
  const nullableNumber = (name: string): number | null => {
    const value = row[name];
    return value === null ? null : numberColumn(row, name);
  };
  const nullableString = (name: string): string | null => {
    const value = row[name];
    if (value !== null && typeof value !== "string") {
      throw new Error(`SQLite column "${name}" is not text or null`);
    }
    return value;
  };
  return {
    id: numberColumn(row, "id"),
    turnId: nullableString("turn_id"),
    attempt: numberColumn(row, "attempt"),
    round: nullableNumber("round"),
    kind,
    name: stringColumn(row, "name"),
    status,
    startedAt: stringColumn(row, "started_at"),
    finishedAt: nullableString("finished_at"),
    durationMs: nullableNumber("duration_ms"),
    requestStartedAt: nullableString("request_started_at"),
    responseHeadersMs: nullableNumber("response_headers_ms"),
    firstTokenMs: nullableNumber("first_token_ms"),
    generationDurationMs: nullableNumber("generation_duration_ms"),
    model: nullableString("model"),
    inputTokens: nullableNumber("input_tokens"),
    outputTokens: nullableNumber("output_tokens"),
    input: nullableString("trace_input"),
    output: nullableString("trace_output"),
    schema: nullableString("trace_schema"),
    rawContent: nullableString("raw_content"),
    errorDetail: nullableString("error_detail"),
  };
}

function readExecutionStep(row: Record<string, unknown>): ExecutionStep {
  const status = stringColumn(row, "status");
  if (!(["running", "succeeded", "failed", "ignored", "unknown", "interrupted"] as string[]).includes(status)) {
    throw new Error(`SQLite execution event status "${status}" is invalid`);
  }
  const nullableString = (name: string): string | null => {
    const value = row[name];
    if (value !== null && typeof value !== "string") {
      throw new Error(`SQLite column "${name}" is not text or null`);
    }
    return value;
  };
  const nullableNumber = (name: string): number | null => {
    const value = row[name];
    return value === null ? null : numberColumn(row, name);
  };
  return {
    id: numberColumn(row, "id"),
    deliveryId: nullableString("delivery_id"),
    webhookEventId: nullableString("webhook_event_id"),
    eventId: nullableString("event_id"),
    turnId: nullableString("turn_id"),
    attempt: nullableNumber("attempt"),
    step: stringColumn(row, "step"),
    status: status as ExecutionStepStatus,
    startedAt: stringColumn(row, "started_at"),
    finishedAt: nullableString("finished_at"),
    durationMs: nullableNumber("duration_ms"),
    input: nullableString("input_json"),
    output: nullableString("output_json"),
    errorDetail: nullableString("error_detail"),
  };
}

function readWebhookOrigin(events: ExecutionStep[]): Pick<EventDetails, "actorUsername" | "triggerComment"> {
  const decodedEvent = events.find((event) => event.step === "webhook.decode");
  if (!decodedEvent?.output) return { actorUsername: null, triggerComment: null };
  try {
    const output: unknown = JSON.parse(decodedEvent.output);
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      return { actorUsername: null, triggerComment: null };
    }
    const record = output as Record<string, unknown>;
    return {
      actorUsername: typeof record.actorUsername === "string" ? record.actorUsername : null,
      triggerComment: typeof record.note === "string" ? record.note : null,
    };
  } catch {
    return { actorUsername: null, triggerComment: null };
  }
}

function mapEvent(row: EventRow): Event {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    projectId: row.project_id,
    mrIid: row.mr_iid,
    targetType: row.target_type,
    targetIid: row.target_iid,
    targetBranch: row.target_branch,
    headSha: row.head_sha,
    actorId: row.actor_id,
    request: row.request,
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    cancellationRequested: row.cancel_requested !== 0,
    leaseToken: row.lease_token,
    failureStage: row.failure_stage as Event["failureStage"],
  };
}

function mapEventSummary(row: EventRow): EventSummary {
  const event = mapEvent(row);
  return {
    id: event.id,
    type: event.type,
    status: event.status,
    projectId: event.projectId,
    mrIid: event.mrIid,
    targetType: event.targetType,
    targetIid: event.targetIid,
    targetBranch: event.targetBranch,
    headSha: event.headSha,
    actorId: event.actorId,
    request: event.request,
    createdAt: event.createdAt,
    updatedAt: row.updated_at,
    attemptCount: event.attemptCount,
    lastError: event.lastError,
    cancellationRequested: event.cancellationRequested,
    failureStage: event.failureStage,
  };
}

/** 归属重建后需要恢复的索引名。 */
const indexNames = {
  event_trace: "event_trace_event_started_idx",
  execution_steps: "execution_steps_event_started_idx",
} as const;

/** 归属重建时使用的表结构：保留外键级联，去掉旧库 NOT NULL 的 `event_id` 约束。 */
const ownershipDdl = {
  event_trace: `id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES conversation_turns(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL, round INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, model TEXT,
    input_tokens INTEGER, output_tokens INTEGER, trace_input TEXT, trace_output TEXT, trace_schema TEXT,
    raw_content TEXT, error_detail TEXT, request_started_at TEXT, response_headers_ms INTEGER,
    first_token_ms INTEGER, generation_duration_ms INTEGER`,
  execution_steps: `id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT, webhook_event_id TEXT,
    event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
    turn_id TEXT REFERENCES conversation_turns(id) ON DELETE CASCADE,
    attempt INTEGER, step TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    duration_ms INTEGER, input_json TEXT, output_json TEXT, error_detail TEXT`,
} as const;

export class EventStore {
  private readonly db: DatabaseSync;

  private constructor(private readonly path: string, db: DatabaseSync) {
    this.db = db;
  }

  static async open(path: string): Promise<EventStore> {
    if (!path) throw new Error("database path is required");
    if (path !== ":memory:") await mkdir(dirname(resolve(path)), { recursive: true });
    const db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.exec("PRAGMA journal_mode = WAL");
    const store = new EventStore(path, db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  ping(): void {
    this.db.prepare("SELECT 1").get();
  }

  eventCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM events GROUP BY status")
      .all() as { status: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  /** 运维总览：队列计数与内联事件执行器心跳。 */
  operationsOverview(heartbeatTimeoutMs = 30_000): OperationsOverview {
    if (!Number.isFinite(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
      throw new Error("event runner heartbeat timeout must be positive");
    }
    // ... counts / oldest ...
    const counts: Record<EventStatus, number> = {
      queued: 0,
      preparing: 0,
      analyzing: 0,
      fixing: 0,
      verifying: 0,
      publishing: 0,
      completed: 0,
      failed: 0,
      stale: 0,
      cancelled: 0,
    };
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM events GROUP BY status")
      .all() as { status: string; count: number }[];
    for (const row of rows) {
      if (!isEventStatus(row.status)) throw new Error(`SQLite event status "${row.status}" is invalid`);
      counts[row.status] = row.count;
    }
    const oldest = this.db
      .prepare("SELECT created_at FROM events WHERE status='queued' ORDER BY created_at ASC LIMIT 1")
      .get() as { created_at: string } | undefined;
    const heartbeat = this.db
      .prepare("SELECT last_seen_at FROM worker_heartbeats ORDER BY last_seen_at DESC LIMIT 1")
      .get() as { last_seen_at: string } | undefined;
    const lastSeenAt = heartbeat?.last_seen_at ?? null;
    return {
      counts,
      oldestQueuedAt: oldest?.created_at ?? null,
      runner: {
        online: lastSeenAt !== null && Date.parse(lastSeenAt) >= Date.now() - heartbeatTimeoutMs,
        lastSeenAt,
      },
    };
  }

  /**
   * 记录内联事件执行器心跳。
   *
   * 表名沿用 `worker_heartbeats`，避免为纯改名做一次数据库迁移；
   * 单进程部署下只有一个执行器写入，总览据此判断它是否在线。
   */
  heartbeatRunner(runnerId: string): void {
    const id = runnerId.trim();
    if (!id || id.length > 128) throw new Error("event runner ID must be between 1 and 128 characters");
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO worker_heartbeats(worker_id, last_seen_at) VALUES (?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
      )
      .run(id, now.toISOString());
    const staleBefore = new Date(now.valueOf() - 7 * 24 * 60 * 60_000).toISOString();
    this.db.prepare("DELETE FROM worker_heartbeats WHERE last_seen_at < ?").run(staleBefore);
  }

  modelCallMetrics(): ModelCallMetric[] {
    return this.db
      .prepare(
        `SELECT task_type AS taskType, outcome, calls, duration_ms AS durationMs,
         input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM model_call_metrics ORDER BY task_type, outcome`,
      )
      .all()
      .map(readModelCallMetric);
  }

  recordModelCall(
    taskType: ModelTaskType,
    outcome: "success" | "failure",
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    if (!isModelTaskType(taskType)) throw new Error(`unsupported model call task type "${taskType}"`);
    if (!["success", "failure"].includes(outcome)) {
      throw new Error(`unsupported model call outcome "${outcome}"`);
    }
    if (durationMs < 0 || inputTokens < 0 || outputTokens < 0) {
      throw new Error("model call metrics cannot be negative");
    }
    this.db
      .prepare(
        `INSERT INTO model_call_metrics
         (task_type, outcome, calls, duration_ms, input_tokens, output_tokens)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(task_type, outcome) DO UPDATE SET
           calls = calls + 1,
           duration_ms = duration_ms + excluded.duration_ms,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(taskType, outcome, Math.floor(durationMs), inputTokens, outputTokens);
  }

  startEventTrace(
    scope: TraceScope,
    attempt: number,
    kind: EventTraceKind,
    name: string,
    model = "",
    rawContent: string | null = null,
    details: { round?: number; input?: string | null; schema?: string | null } = {},
  ): number {
    const column = traceScopeColumn(scope);
    const ownerId = traceScopeId(scope);
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new Error("event trace requires a positive attempt number");
    }
    if (kind !== "tool" && kind !== "llm" && kind !== "context") throw new Error(`unsupported event trace kind "${kind}"`);
    if (
      !name.trim() ||
      name.length > 128 ||
      model.length > 256 ||
      (details.round !== undefined && (!Number.isSafeInteger(details.round) || details.round <= 0))
    ) {
      throw new Error("event trace name or model is invalid");
    }
    const result = this.db
      .prepare(
        `INSERT INTO event_trace
         (${column},attempt,round,kind,name,status,started_at,model,trace_input,trace_schema,raw_content)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        ownerId,
        attempt,
        details.round ?? null,
        kind,
        name,
        "running",
        new Date().toISOString(),
        model || null,
        details.input ?? null,
        details.schema ?? null,
        rawContent,
      );
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id)) throw new Error("SQLite returned an invalid event trace ID");
    return id;
  }

  finishEventTrace(
    traceId: number,
    status: Exclude<EventTraceStatus, "running">,
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    errorDetail?: string,
    output?: string,
    firstTokenMs?: number,
    generationDurationMs?: number,
    requestStartedAt?: string,
    responseHeadersMs?: number,
  ): void {
    if (
      !Number.isSafeInteger(traceId) ||
      traceId <= 0 ||
      (status !== "succeeded" && status !== "failed") ||
      !Number.isFinite(durationMs) ||
      durationMs < 0 ||
      (inputTokens !== undefined && (!Number.isSafeInteger(inputTokens) || inputTokens < 0)) ||
      (outputTokens !== undefined && (!Number.isSafeInteger(outputTokens) || outputTokens < 0)) ||
      (requestStartedAt !== undefined && !Number.isFinite(Date.parse(requestStartedAt))) ||
      (responseHeadersMs !== undefined && (!Number.isFinite(responseHeadersMs) || responseHeadersMs < 0)) ||
      (firstTokenMs !== undefined && (!Number.isFinite(firstTokenMs) || firstTokenMs < 0)) ||
      (generationDurationMs !== undefined && (!Number.isFinite(generationDurationMs) || generationDurationMs < 0))
    ) {
      throw new Error("event trace completion is invalid");
    }
    const result = this.db
      .prepare(
        `UPDATE event_trace SET status=?, finished_at=?, duration_ms=?, input_tokens=?, output_tokens=?, error_detail=?,
         trace_output=?, first_token_ms=?, generation_duration_ms=?, request_started_at=?, response_headers_ms=?
         WHERE id=? AND status='running'`,
      )
      .run(
        status,
        new Date().toISOString(),
        Math.floor(durationMs),
        inputTokens ?? null,
        outputTokens ?? null,
        errorDetail ?? null,
        output ?? null,
        firstTokenMs === undefined ? null : Math.floor(firstTokenMs),
        generationDurationMs === undefined ? null : Math.floor(generationDurationMs),
        requestStartedAt ?? null,
        responseHeadersMs === undefined ? null : Math.floor(responseHeadersMs),
        traceId,
      );
    if (result.changes !== 1) throw new Error(`event trace "${traceId}" is not running`);
  }
  startExecutionStep(input: {
    deliveryId?: string | null;
    webhookEventId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    attempt?: number | null;
    step: string;
    input?: unknown;
  }): number {
    const deliveryId = input.deliveryId ?? null;
    const webhookEventId = input.webhookEventId ?? null;
    const eventId = input.eventId ?? (webhookEventId
      ? (this.db.prepare("SELECT id FROM events WHERE webhook_event_id=?").get(webhookEventId) as { id: string } | undefined)?.id ?? null
      : null);
    const turnId = input.turnId ?? null;
    const attempt = input.attempt ?? null;
    if (
      (!deliveryId && !webhookEventId && !eventId && !turnId) ||
      [deliveryId, webhookEventId, eventId, turnId].some((value) => value !== null && (!value.trim() || value.length > 256)) ||
      !/^[a-z][a-z0-9_.-]{1,127}$/.test(input.step) ||
      (attempt !== null && (!Number.isSafeInteger(attempt) || attempt <= 0))
    ) {
      throw new Error("execution step identity or step is invalid");
    }
    const result = this.db
      .prepare(
        `INSERT INTO execution_steps
         (delivery_id,webhook_event_id,event_id,turn_id,attempt,step,status,started_at,input_json)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        deliveryId,
        webhookEventId,
        eventId,
        turnId,
        attempt,
        input.step,
        "running",
        new Date().toISOString(),
        serializeTraceValue(input.input),
      );
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id)) throw new Error("SQLite returned an invalid execution event ID");
    return id;
  }

  finishExecutionStep(
    id: number,
    status: Exclude<ExecutionStepStatus, "running">,
    durationMs: number,
    output?: unknown,
    errorDetail?: string,
  ): void {
    if (
      !Number.isSafeInteger(id) || id <= 0 ||
      !["succeeded", "failed", "ignored", "unknown", "interrupted"].includes(status) ||
      !Number.isFinite(durationMs) || durationMs < 0
    ) {
      throw new Error("execution event completion is invalid");
    }
    const result = this.db
      .prepare(
        `UPDATE execution_steps SET status=?,finished_at=?,duration_ms=?,output_json=?,error_detail=?
         WHERE id=? AND status='running'`,
      )
      .run(
        status,
        new Date().toISOString(),
        Math.floor(durationMs),
        serializeTraceValue(output),
        errorDetail ? redactTraceText(errorDetail).slice(0, 8192) : null,
        id,
      );
    if (result.changes !== 1) throw new Error(`execution event "${id}" is not running`);
  }

  recordExecutionStep(input: {
    deliveryId?: string | null;
    webhookEventId?: string | null;
    eventId?: string | null;
    turnId?: string | null;
    attempt?: number | null;
    step: string;
    status: Exclude<ExecutionStepStatus, "running">;
    input?: unknown;
    output?: unknown;
    errorDetail?: string;
  }): number {
    const id = this.startExecutionStep(input);
    this.finishExecutionStep(id, input.status, 0, input.output, input.errorDetail);
    return id;
  }

  linkExecutionStepsToEvent(deliveryId: string, webhookEventId: string): void {
    if (!deliveryId.trim() || !webhookEventId.trim()) throw new Error("execution event correlation IDs are required");
    this.db
      .prepare("UPDATE execution_steps SET webhook_event_id=? WHERE delivery_id=? AND webhook_event_id IS NULL")
      .run(webhookEventId, deliveryId);
  }

  pruneHistory(historyBefore: Date, auditBefore: Date): void {
    if (Number.isNaN(historyBefore.valueOf()) || Number.isNaN(auditBefore.valueOf())) {
      throw new Error("history and audit retention cutoffs are required");
    }
    this.transaction(() => {
      const history = historyBefore.toISOString();
      const audit = auditBefore.toISOString();
      const terminalStatuses = ["completed", "failed", "stale", "cancelled"];
      const statusParams = terminalStatuses.map(() => "?").join(",");
      this.db
        .prepare(
          `DELETE FROM event_attempts WHERE event_id IN
           (SELECT id FROM events WHERE status IN (${statusParams}) AND updated_at < ?)`,
        )
        .run(...terminalStatuses, history);
      this.db
        .prepare(`DELETE FROM events WHERE status IN (${statusParams}) AND updated_at < ?`)
        .run(...terminalStatuses, history);
      this.db
        .prepare("DELETE FROM execution_steps WHERE event_id IS NULL AND turn_id IS NULL AND started_at < ?")
        .run(history);
      // 对话消息与轨迹通过外键级联删除；保留仍有排队或运行中轮次的对话。
      this.db
        .prepare(
          `DELETE FROM conversations WHERE updated_at < ?
           AND id NOT IN (SELECT conversation_id FROM conversation_turns WHERE status IN ('queued','running'))`,
        )
        .run(history);
      this.db.prepare("DELETE FROM webhook_deliveries WHERE received_at < ?").run(history);
      this.db
        .prepare("DELETE FROM model_token_usage WHERE day < ?")
        .run(historyBefore.toISOString().slice(0, 10));
      this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(audit);
    });
  }

  reserveModelTokens(dailyLimit: number, tokens: number): string {
    if (dailyLimit <= 0 || tokens <= 0) {
      throw new Error("daily model token limit and reservation must be positive");
    }
    const day = new Date().toISOString().slice(0, 10);
    this.transaction(() => {
      this.db.prepare("INSERT INTO model_token_usage(day) VALUES (?) ON CONFLICT(day) DO NOTHING").run(day);
      const result = this.db
        .prepare(
          `UPDATE model_token_usage SET reserved_tokens = reserved_tokens + ?
           WHERE day = ? AND used_tokens + reserved_tokens + ? <= ?`,
        )
        .run(tokens, day, tokens, dailyLimit);
      if (result.changes !== 1) {
        throw new Error(`daily model token budget of ${dailyLimit} tokens would be exceeded`);
      }
    });
    return day;
  }

  settleModelTokens(day: string, reserved: number, actual: number): void {
    if (!day || reserved <= 0 || actual < 0) throw new Error("model token reservation settlement is invalid");
    const result = this.db
      .prepare(
        `UPDATE model_token_usage
         SET reserved_tokens = reserved_tokens - ?, used_tokens = used_tokens + ?
         WHERE day = ? AND reserved_tokens >= ?`,
      )
      .run(reserved, actual, day, reserved);
    if (result.changes !== 1) throw new Error("model token reservation no longer exists");
  }

  async backup(destination: string): Promise<void> {
    if (!destination.trim()) throw new Error("backup destination is required");
    const output = resolve(destination);
    if (this.path !== ":memory:" && output === resolve(this.path)) {
      throw new Error("backup destination must differ from the database path");
    }
    try {
      await import("node:fs/promises").then(({ lstat }) => lstat(output));
      throw new Error(`backup destination "${output}" already exists`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        // 仅当目标不存在时创建备份，避免覆盖已有文件。
      } else {
        throw error;
      }
    }
    await mkdir(dirname(output), { recursive: true });
    await sqliteBackup(this.db, output);
  }

  createReview(webhookEventId: string, key: string, event: Partial<Event> & Pick<Event, "projectId" | "mrIid" | "actorId" | "headSha">): EventResult {
  // 在事务中检查并增加预留量，避免并发请求同时通过预算检查。
    return this.createQueuedTask(webhookEventId, key, event, "review");
  }

  createExplain(
    webhookEventId: string,
    key: string,
    event: Partial<Event> & Pick<Event, "projectId" | "mrIid" | "actorId" | "headSha" | "request">,
  ): EventResult {
    return this.createQueuedTask(webhookEventId, key, event, "explain");
  }

  createChat(
    webhookEventId: string,
    key: string,
    event: Partial<Event> & Pick<Event, "projectId" | "mrIid" | "actorId" | "headSha" | "request">,
  ): EventResult {
    return this.createQueuedTask(webhookEventId, key, event, "chat");
  }

  createFix(
    webhookEventId: string,
    key: string,
    event: Partial<Event> & Pick<Event, "projectId" | "mrIid" | "actorId" | "headSha" | "request">,
    enabled: boolean,
  ): EventResult {
    return this.transaction(() => {
      const previous = this.webhookEventResult(webhookEventId);
      if (previous) {
        const existing = this.db.prepare("SELECT id FROM events WHERE webhook_event_id=?").get(webhookEventId) as { id: string } | undefined;
        if (existing) this.linkExecutionSteps(webhookEventId, existing.id);
        return previous;
      }
      let auditResult = "authorized_queued";
      let response: string;
      let resultEvent: EventResult["event"];
      if (!enabled) {
        response = "Fix proposals are disabled.";
        auditResult = "denied_disabled";
      } else {
        const existing = this.db.prepare("SELECT id FROM events WHERE idempotency_key = ?").get(key) as
          | { id: string }
          | undefined;
        if (existing) {
          resultEvent = { id: existing.id, created: false };
          response = `Fix task \`${existing.id}\` is already queued for this comment.`;
          auditResult = "authorized_duplicate";
        } else {
          const created = new Date().toISOString();
          const id = randomUUID();
          this.db
            .prepare(
              `INSERT INTO events
              (id,idempotency_key,webhook_event_id,type,status,project_id,mr_iid,target_type,target_iid,head_sha,actor_id,request,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(id, key, webhookEventId, "fix", "queued", event.projectId, event.mrIid, "merge_request", event.mrIid, event.headSha, event.actorId, event.request, created, created);
          resultEvent = { id, created: true };
          response = `Queued fix task \`${id}\` for MR !${event.mrIid} at \`${event.headSha.slice(0, 12)}\`.`;
        }
      }
      this.insertWebhookEvent(webhookEventId, response);
      if (resultEvent) this.linkExecutionSteps(webhookEventId, resultEvent.id);
      this.insertAudit(event.actorId, "request_fix", `${event.projectId}:${event.mrIid}`, auditResult);
      return { response, delivered: false, ...(resultEvent ? { event: resultEvent } : {}) };
    });
  }

  createIssueImplementation(
    webhookEventId: string,
    key: string,
    event: { projectId: number; issueIid: number; actorId: number; request: string },
  ): EventResult {
    return this.transaction(() => {
      const previous = this.webhookEventResult(webhookEventId);
      if (previous) return previous;
      let response: string;
      let resultEvent: EventResult["event"];
      let auditResult = "queued";
      const existing = this.db.prepare("SELECT id FROM events WHERE idempotency_key = ?").get(key) as
        | { id: string }
        | undefined;
      if (existing) {
        resultEvent = { id: existing.id, created: false };
        response = `Issue assistant task \`${existing.id}\` is already queued for this comment.`;
        auditResult = "authorized_duplicate";
      } else {
        const created = new Date().toISOString();
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO events
             (id,idempotency_key,webhook_event_id,type,status,project_id,mr_iid,target_type,target_iid,head_sha,actor_id,request,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(id, key, webhookEventId, "implement", "queued", event.projectId, 0, "issue", event.issueIid, "", event.actorId, event.request, created, created);
        resultEvent = { id, created: true };
        response = `Queued Issue assistant task \`${id}\` for issue #${event.issueIid}.`;
      }
      this.insertWebhookEvent(webhookEventId, response);
      if (resultEvent) this.linkExecutionSteps(webhookEventId, resultEvent.id);
      this.insertAudit(event.actorId, "request_issue_assistant", `${event.projectId}:#${event.issueIid}`, auditResult);
      return { response, delivered: false, ...(resultEvent ? { event: resultEvent } : {}) };
    });
  }

  status(webhookEventId: string, projectId: number, mrIid: number): EventResult {
    return this.transaction(() => {
      const previous = this.webhookEventResult(webhookEventId);
      if (previous) return previous;
      const row = this.db
        .prepare(
          `SELECT id, status, actor_id, cancel_requested FROM events
           WHERE project_id = ? AND mr_iid = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectId, mrIid) as
        | { id: string; status: string; actor_id: number; cancel_requested: number }
        | undefined;
      let response = "No Corvex task has been created for this MR.";
      if (row) {
        response = `Latest task \`${row.id}\`: **${row.status}** (requested by user ${row.actor_id}).`;
        if (row.cancel_requested) response += " Cancellation has been requested.";
      }
      this.insertWebhookEvent(webhookEventId, response);
      return { response, delivered: false };
    });
  }

  cancel(webhookEventId: string, projectId: number, mrIid: number, actorId: number): EventResult {
    return this.transaction(() => {
      const previous = this.webhookEventResult(webhookEventId);
      if (previous) return previous;
      const row = this.db
        .prepare(
          `SELECT id, status, actor_id FROM events
           WHERE project_id = ? AND mr_iid = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(projectId, mrIid) as { id: string; status: EventStatus; actor_id: number } | undefined;
      let response: string;
      let auditResult: string;
      let resource = `${projectId}:${mrIid}`;
      if (!row) {
        response = "There is no task to cancel for this MR.";
        auditResult = "no_task";
      } else {
        resource = row.id;
        if (row.actor_id !== actorId) {
          response = "You can only cancel a task that you started.";
          auditResult = "denied_not_owner";
        } else if (row.status === "queued") {
          const updated = this.db
            .prepare("UPDATE events SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
            .run("cancelled", new Date().toISOString(), row.id, "queued").changes;
          response =
            updated === 1
              ? `Cancelled task \`${row.id}\`.`
              : `Task \`${row.id}\` changed state before it could be cancelled.`;
          if (updated === 1) this.insertAudit(row.actor_id, "event_status", row.id, "queued->cancelled");
          auditResult = updated === 1 ? "cancelled" : "denied_state_changed";
        } else if (["preparing", "analyzing", "fixing", "verifying"].includes(row.status)) {
          const updated = this.db
            .prepare(
              "UPDATE events SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = ? AND cancel_requested = 0",
            )
            .run(new Date().toISOString(), row.id, row.status).changes;
          response =
            updated === 1
              ? `Cancellation requested for task \`${row.id}\`.`
              : `Task \`${row.id}\` changed state before it could be cancelled.`;
          auditResult = updated === 1 ? "cancellation_requested" : "denied_state_changed";
        } else {
          response = `Task \`${row.id}\` is ${row.status} and can no longer be cancelled.`;
          auditResult = `denied_status_${row.status}`;
        }
      }
      this.insertAudit(actorId, "cancel_event", resource, auditResult);
      this.insertWebhookEvent(webhookEventId, response);
      return { response, delivered: false };
    });
  }

  markDelivered(webhookEventId: string, token: string): void {
    if (!webhookEventId.trim() || !token.trim()) throw new Error("webhook delivery completion requires an event ID and token");
    const result = this.db
      .prepare(
        "UPDATE webhook_deliveries SET delivered=1,delivery_token='',delivery_until=0 WHERE webhook_event_id=? AND delivery_token=? AND delivered=0",
      )
      .run(webhookEventId, token);
    if (result.changes === 1) return;
    const row = this.db.prepare("SELECT delivered FROM webhook_deliveries WHERE webhook_event_id=?").get(webhookEventId) as
      | { delivered: number }
      | undefined;
    if (row?.delivered) return;
    throw new Error(`webhook delivery claim for "${webhookEventId}" is no longer owned`);
  }

  claimWebhookDelivery(
    webhookEventId: string,
    leaseMs: number,
  ): { status: "claimed"; token: string } | { status: "delivered" | "in_progress" } {
    if (!webhookEventId.trim() || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("webhook delivery claim requires an event ID and positive lease duration");
    }
    const now = Date.now();
    const token = randomUUID();
    const result = this.db
      .prepare(
        `UPDATE webhook_deliveries SET delivery_token=?,delivery_until=?
         WHERE webhook_event_id=? AND delivered=0 AND (delivery_token='' OR delivery_until<=?)`,
      )
      .run(token, now + leaseMs, webhookEventId, now);
    if (result.changes === 1) return { status: "claimed", token };
    const row = this.db
      .prepare("SELECT delivered FROM webhook_deliveries WHERE webhook_event_id=?")
      .get(webhookEventId) as { delivered: number } | undefined;
    if (!row) throw new Error(`webhook event "${webhookEventId}" not found`);
    return { status: row.delivered ? "delivered" : "in_progress" };
  }

  releaseWebhookDelivery(webhookEventId: string, token: string): void {
    if (!webhookEventId.trim() || !token.trim()) throw new Error("webhook delivery release requires an event ID and token");
    this.db
      .prepare(
        "UPDATE webhook_deliveries SET delivery_token='',delivery_until=0 WHERE webhook_event_id=? AND delivery_token=? AND delivered=0",
      )
      .run(webhookEventId, token);
  }

  recordResponse(webhookEventId: string, response: string): EventResult {
    return this.transaction(() => {
      const previous = this.webhookEventResult(webhookEventId);
      if (previous) return previous;
      this.insertWebhookEvent(webhookEventId, response);
      return { response, delivered: false };
    });
  }

  claimNextWithLease(leaseMs: number): Event | undefined {
    if (leaseMs <= 0) throw new Error("event lease duration must be positive");
    return this.transaction(() => {
      this.recoverExpiredLeases();
      const row = readEventRow(this.db
        .prepare(
          "SELECT * FROM events WHERE status = 'queued' AND available_at <= ? ORDER BY created_at LIMIT 1",
        )
        .get(Date.now()));
      if (!row) return undefined;
      const now = new Date();
      const leaseToken = randomUUID();
      const result = this.db
        .prepare(
          `UPDATE events SET status='preparing', attempt_count=attempt_count+1, updated_at=?,
           lease_token=?, lease_until=? WHERE id=? AND status='queued'`,
        )
        .run(now.toISOString(), leaseToken, now.valueOf() + leaseMs, row.id);
      if (result.changes !== 1) return undefined;
      this.db
        .prepare("INSERT INTO event_attempts(event_id,attempt,started_at) VALUES (?,?,?)")
        .run(row.id, row.attempt_count + 1, now.toISOString());
      this.insertAudit(row.actor_id, "event_status", row.id, "queued->preparing", now.toISOString());
      const claimed = readEventRow(this.db.prepare("SELECT * FROM events WHERE id = ?").get(row.id));
      if (!claimed) throw new Error(`claimed event "${row.id}" disappeared`);
      return mapEvent(claimed);
    });
  }

  updateLeasedStatus(eventId: string, leaseToken: string, from: EventStatus, to: EventStatus, failure = ""): void {
    if (!leaseToken) throw new Error("event lease token is required");
    if (!this.validTransition(from, to)) throw new Error(`invalid event transition "${from}" -> "${to}"`);
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT actor_id, cancel_requested FROM events WHERE id=? AND status=? AND lease_token=?")
        .get(eventId, from, leaseToken) as { actor_id: number; cancel_requested: number } | undefined;
      if (!row) throw new Error(`event "${eventId}" is no longer in status "${from}"`);
      if (row.cancel_requested && to !== "cancelled") throw new Error("event cancellation requested");
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE events SET status=?, last_error=?, failure_stage=CASE WHEN ?='failed' THEN ? ELSE '' END, updated_at=?,
           lease_token=CASE WHEN ? THEN '' ELSE lease_token END,
           lease_until=CASE WHEN ? THEN 0 ELSE lease_until END
           WHERE id=? AND status=? AND lease_token=? AND (? OR cancel_requested=0)`,
        )
        .run(to, failure, to, from, now, terminal.has(to) ? 1 : 0, terminal.has(to) ? 1 : 0, eventId, from, leaseToken, to === "cancelled" ? 1 : 0);
      if (result.changes !== 1) throw new Error(`event "${eventId}" is no longer in status "${from}"`);
      if (terminal.has(to)) {
        this.db
          .prepare("UPDATE event_attempts SET finished_at=?, error=? WHERE event_id=? AND finished_at IS NULL")
          .run(now, failure, eventId);
      }
      this.insertAudit(row.actor_id, "event_status", eventId, `${from}->${to}`, now);
    });
  }

  retryLeasedEvent(
    eventId: string,
    leaseToken: string,
    from: EventStatus,
    availableAt: number,
    failure: string,
  ): boolean {
    if (!leaseToken) throw new Error("event lease token is required");
    if (from === "publishing") throw new Error("publishing events cannot be retried automatically");
    if (!Number.isSafeInteger(availableAt) || availableAt < 0) {
      throw new Error("retry availability must be a non-negative timestamp");
    }
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT actor_id, cancel_requested, attempt_count FROM events WHERE id=? AND status=? AND lease_token=?")
        .get(eventId, from, leaseToken) as {
        actor_id: number;
        cancel_requested: number;
        attempt_count: number;
      } | undefined;
      if (!row) throw new Error(`event "${eventId}" is no longer in status "${from}"`);
      if (row.cancel_requested || row.attempt_count >= maxAttempts) return false;

      const now = new Date();
      const finishedAt = now.toISOString();
      const result = this.db
        .prepare(
          `UPDATE events SET status='queued', last_error=?, failure_stage='', available_at=?, updated_at=?,
           lease_token='', lease_until=0 WHERE id=? AND status=? AND lease_token=? AND cancel_requested=0`,
        )
        .run(failure, availableAt, finishedAt, eventId, from, leaseToken);
      if (result.changes !== 1) throw new Error(`event "${eventId}" changed before it could be retried`);
      this.db
        .prepare("UPDATE event_attempts SET finished_at=?, error=? WHERE event_id=? AND finished_at IS NULL")
        .run(finishedAt, failure, eventId);
      this.insertAudit(row.actor_id, "event_status", eventId, `${from}->queued`, finishedAt);
      this.insertAudit(row.actor_id, "automatic_retry", eventId, `available_at:${availableAt}`, finishedAt);
      return true;
    });
  }

  renewLease(eventId: string, leaseToken: string, leaseMs: number): void {
    if (!leaseToken || leaseMs <= 0) throw new Error("event lease token and positive duration are required");
    const now = new Date();
    const result = this.db
      .prepare(
        `UPDATE events SET lease_until=?, updated_at=? WHERE id=? AND lease_token=?
         AND status IN (${active.map(() => "?").join(",")})`,
      )
      .run(now.valueOf() + leaseMs, now.toISOString(), eventId, leaseToken, ...active);
    if (result.changes !== 1) throw new Error(`event "${eventId}" lease is no longer owned`);
  }

  createConversation(input: CreateConversationInput): CreatedConversationTurn {
    this.validateConversationInput(input);
    const conversationId = randomUUID();
    const mode = input.mode ?? defaultConversationMode;
    const now = new Date().toISOString();
    return this.transaction(() => {
      this.db.prepare(
        `INSERT INTO conversations
         (id,project_id,project_name,target_branch,mode,owner_user_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(conversationId, input.projectId, input.projectName, input.targetBranch, mode, input.ownerUserId ?? "", now, now);
      return this.enqueueConversationTurn(conversationId, input, now);
    });
  }

  listConversations(limit = 50, offset = 0, archived = false, ownerUserId = ""): ConversationPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("conversation list limit must be between 1 and 100");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new Error("conversation list offset must be between 0 and 1000000");
    }
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE archived=? AND owner_user_id=?").get(archived ? 1 : 0, ownerUserId) as Record<string, unknown>;
    const rows = this.db.prepare(
      `SELECT conversations.*,
         (SELECT COUNT(*) FROM conversation_turns
          WHERE conversation_id=conversations.id AND role='assistant') AS turn_count,
         (SELECT status FROM conversation_turns
          WHERE conversation_id=conversations.id AND role='assistant'
          ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_turn_status
       FROM conversations WHERE archived=? AND owner_user_id=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
    ).all(archived ? 1 : 0, ownerUserId, limit, offset);
    return { items: rows.map((row) => this.readConversationSummary(row as Record<string, unknown>)), total: numberColumn(count, "count") };
  }

  getConversation(conversationId: string): Conversation | undefined {
    const row = this.db.prepare(
      `SELECT conversations.*,
         (SELECT COUNT(*) FROM conversation_turns
          WHERE conversation_id=conversations.id AND role='assistant') AS turn_count,
         (SELECT status FROM conversation_turns
          WHERE conversation_id=conversations.id AND role='assistant'
          ORDER BY created_at DESC,rowid DESC LIMIT 1) AS last_turn_status
       FROM conversations WHERE id=?`,
    ).get(conversationId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    // 每条助手回复对应一轮 conversation_turns；把轮次状态、轨迹与执行步骤数量一并带出，
    // 让对话页无需额外请求就能提示「本轮有轨迹/记录可查看」。
    const messages = this.db.prepare(
      `SELECT conversation_messages.*, conversation_turns.status AS turn_status,
         conversation_turns.process AS turn_process, conversation_turns.model AS turn_model,
         conversation_turns.created_at AS turn_created_at, conversation_turns.updated_at AS turn_updated_at,
         (SELECT COALESCE(SUM(COALESCE(output_tokens, 0)), 0) FROM event_trace
          WHERE turn_id=conversation_messages.turn_id AND kind='llm' AND status='succeeded') AS generation_output_tokens,
         (SELECT COALESCE(SUM(COALESCE(generation_duration_ms, 0)), 0) FROM event_trace
          WHERE turn_id=conversation_messages.turn_id AND kind='llm' AND status='succeeded') AS generation_duration_ms,
         (SELECT COUNT(*) FROM event_trace WHERE turn_id=conversation_messages.turn_id) AS trace_count,
         (SELECT COUNT(*) FROM execution_steps WHERE turn_id=conversation_messages.turn_id) AS step_count
       FROM conversation_messages
       LEFT JOIN conversation_turns ON conversation_turns.id=conversation_messages.turn_id
       WHERE conversation_messages.conversation_id=? ORDER BY conversation_messages.created_at,conversation_messages.rowid`,
    ).all(conversationId).map((value) => this.readConversationMessage(value as Record<string, unknown>));
    // 工具调用摘要按轮次归组，只读取列表展示所需的字段，避免把整条轨迹带进列表接口。
    const toolCallsByTurn = new Map<string, ConversationToolCall[]>();
    const turnIds = messages.flatMap((message) => (message.role === "assistant" && message.turnId ? [message.turnId] : []));
    if (turnIds.length > 0) {
      const rows = this.db.prepare(
        `SELECT turn_id, name, status, trace_input, duration_ms FROM event_trace
         WHERE kind='tool' AND turn_id IN (${turnIds.map(() => "?").join(",")})
         ORDER BY started_at,id`,
      ).all(...turnIds);
      for (const value of rows) {
        const toolRow = value as Record<string, unknown>;
        const turnId = stringColumn(toolRow, "turn_id");
        const calls = toolCallsByTurn.get(turnId) ?? [];
        if (calls.length >= maxConversationToolCalls) continue;
        calls.push(this.readConversationToolCall(toolRow));
        toolCallsByTurn.set(turnId, calls);
      }
    }
    return {
      ...this.readConversationSummary(row),
      messages: messages.map((message) => ({
        ...message,
        toolCalls: message.turnId ? toolCallsByTurn.get(message.turnId) ?? [] : [],
      })),
    };
  }

  /**
   * 读取单轮对话的完整记录：轮次状态、生命周期、轨迹与执行步骤。
   * 校验轮次确实属于该对话，避免跨对话读取轨迹。
   */
  getConversationTurn(conversationId: string, turnId: string): ConversationTurn | undefined {
    const row = this.db.prepare(
      `SELECT * FROM conversation_turns WHERE id=? AND conversation_id=? AND role='assistant'`,
    ).get(turnId, conversationId) as Record<string, unknown> | undefined;
    const turn = row ? readConversationTurnRow(row) : undefined;
    if (!turn) return undefined;
    const messageId = turn.message_id;
    if (!messageId) throw new Error(`conversation turn "${turnId}" is missing its response message`);
    return {
      conversationId,
      messageId,
      turnId: turn.id,
      status: turn.status,
      request: turn.request,
      headSha: turn.head_sha,
      attemptCount: turn.attempt_count,
      createdAt: turn.created_at,
      updatedAt: turn.updated_at,
      lastError: turn.last_error,
      process: readConversationProcess(turn.process),
      timeline: this.readTurnTimeline(turnId),
      trajectory: this.readEventTrajectory({ kind: "conversation", turnId }),
      events: this.readExecutionSteps({ kind: "conversation", turnId }),
    };
  }

  /**
   * 读取整段对话的轨迹：把该对话全部轮次的轨迹与执行步骤合并成一条时间线，
   * 并按轮次创建时间给出分组边界。对话不存在时返回 undefined。
   */
  getConversationTurns(conversationId: string): ConversationTurns | undefined {
    if (!this.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(conversationId)) return undefined;
    const turns = this.db.prepare(
      `SELECT * FROM conversation_turns
       WHERE conversation_id=? AND role='assistant'
       ORDER BY created_at,rowid`,
    ).all(conversationId).flatMap((value): ConversationTurnSegment[] => {
      const turn = readConversationTurnRow(value as Record<string, unknown>);
      if (!turn) return [];
      return [{
        turnId: turn.id,
        status: turn.status,
        request: turn.request,
        headSha: turn.head_sha,
        attemptCount: turn.attempt_count,
        createdAt: turn.created_at,
        updatedAt: turn.updated_at,
        lastError: turn.last_error,
      }];
    });
    if (turns.length === 0) return { conversationId, turns, trajectory: [], events: [] };
    const placeholders = turns.map(() => "?").join(",");
    const turnIds = turns.map((turn) => turn.turnId);
    return {
      conversationId,
      turns,
      // 同一对话的轮次内联串行执行，轨迹时间天然不重叠；这里仍按时间排序，便于直接渲染。
      trajectory: this.db
        .prepare(`SELECT * FROM event_trace WHERE turn_id IN (${placeholders}) ORDER BY started_at,id`)
        .all(...turnIds)
        .map((value) => readEventTrace(value as Record<string, unknown>)),
      events: this.db
        .prepare(`SELECT * FROM execution_steps WHERE turn_id IN (${placeholders}) ORDER BY started_at,id`)
        .all(...turnIds)
        .map((value) => readExecutionStep(value as Record<string, unknown>)),
    };
  }

  /**
   * 汇总整个对话的用量与耗时：逐轮统计模型/工具调用、Token 用量与耗时，
   * 再累加成对话级总计。数据来自该轮对话的轨迹记录，缺失字段按 0 处理。
   */
  getConversationStats(conversationId: string): ConversationStats | undefined {
    if (!this.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(conversationId)) return undefined;
    const rows = this.db.prepare(
      `SELECT conversation_turns.id AS turn_id, conversation_turns.message_id AS message_id,
         conversation_turns.status AS turn_status, conversation_turns.request AS turn_request,
         conversation_turns.created_at AS turn_created_at, conversation_turns.updated_at AS turn_updated_at,
         COALESCE((SELECT SUM(CASE WHEN kind='llm' THEN 1 ELSE 0 END) FROM event_trace WHERE turn_id=conversation_turns.id), 0) AS model_calls,
         COALESCE((SELECT SUM(CASE WHEN kind='tool' THEN 1 ELSE 0 END) FROM event_trace WHERE turn_id=conversation_turns.id), 0) AS tool_calls,
         COALESCE((SELECT SUM(COALESCE(input_tokens, 0)) FROM event_trace WHERE turn_id=conversation_turns.id), 0) AS input_tokens,
         COALESCE((SELECT SUM(COALESCE(output_tokens, 0)) FROM event_trace WHERE turn_id=conversation_turns.id), 0) AS output_tokens
       FROM conversation_turns
       WHERE conversation_turns.conversation_id=? AND conversation_turns.role='assistant'
       ORDER BY conversation_turns.created_at,conversation_turns.rowid`,
    ).all(conversationId);

    const turns: ConversationTurnStats[] = rows.map((value) => {
      const row = value as Record<string, unknown>;
      const status = stringColumn(row, "turn_status");
      if (!isConversationTurnStatus(status)) {
        throw new Error(`SQLite conversation turn status "${status}" is invalid`);
      }
      const created = stringColumn(row, "turn_created_at");
      const updated = stringColumn(row, "turn_updated_at");
      return {
        messageId: stringColumn(row, "message_id"),
        turnId: stringColumn(row, "turn_id"),
        status,
        request: stringColumn(row, "turn_request"),
        createdAt: created,
        updatedAt: updated,
        durationMs: turnDurationMs(created, updated, terminalConversationTurn.has(status)),
        modelCalls: numberColumn(row, "model_calls"),
        toolCalls: numberColumn(row, "tool_calls"),
        inputTokens: numberColumn(row, "input_tokens"),
        outputTokens: numberColumn(row, "output_tokens"),
      };
    });

    const measured = turns.filter((turn) => turn.durationMs !== null);
    return {
      conversationId,
      turnCount: turns.length,
      completedTurns: turns.filter((turn) => turn.status === "completed").length,
      failedTurns: turns.filter((turn) => turn.status === "failed").length,
      activeTurns: turns.filter((turn) => !terminalConversationTurn.has(turn.status)).length,
      totalDurationMs: measured.reduce((sum, turn) => sum + (turn.durationMs ?? 0), 0),
      measuredTurns: measured.length,
      modelCalls: turns.reduce((sum, turn) => sum + turn.modelCalls, 0),
      toolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls, 0),
      inputTokens: turns.reduce((sum, turn) => sum + turn.inputTokens, 0),
      outputTokens: turns.reduce((sum, turn) => sum + turn.outputTokens, 0),
      turns,
    };
  }

  /** 追加一条用户消息并创建对应轮次；已有排队或执行中的轮次时拒绝。 */
  addConversationMessage(conversationId: string, input: Omit<CreateConversationInput, "projectName">): CreatedConversationTurn {
    this.validateConversationInput({ ...input, projectName: "" });
    const result = this.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(conversationId);
    if (!result) throw new Error(`conversation "${conversationId}" not found`);
    return this.transaction(() => {
      const activeTurn = this.db.prepare(
        "SELECT 1 FROM conversation_turns WHERE conversation_id=? AND role='assistant' AND status IN ('queued','running') LIMIT 1",
      ).get(conversationId);
      if (activeTurn) throw new Error("conversation already has an active turn");
      return this.enqueueConversationTurn(conversationId, input, new Date().toISOString());
    });
  }

  /** 领取指定的排队轮次并置为运行中，同时累加尝试次数；不可领取时返回 undefined。 */
  claimConversationTurn(turnId: string): ConversationTurnContext | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM conversation_turns WHERE id=? AND role='assistant' AND status='queued'",
      ).get(turnId) as Record<string, unknown> | undefined;
      const turn = row ? readConversationTurnRow(row) : undefined;
      if (!turn) return undefined;
      const now = new Date().toISOString();
      const claimed = this.db.prepare(
        "UPDATE conversation_turns SET status='running',attempt_count=attempt_count+1,updated_at=? WHERE id=? AND status='queued'",
      ).run(now, turn.id);
      if (claimed.changes !== 1) return undefined;
      if (turn.message_id) {
        this.db.prepare("UPDATE conversation_messages SET status='running',updated_at=? WHERE id=?").run(now, turn.message_id);
      }
      this.insertAudit(turn.actor_id, "conversation_turn", turn.id, "queued->running", now);
      const conversation = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(turn.conversation_id) as
        | Record<string, unknown>
        | undefined;
      if (!conversation) throw new Error(`conversation "${turn.conversation_id}" not found`);
      const history = this.db.prepare(
        `SELECT id, role, content FROM conversation_messages
         WHERE conversation_id=? AND status='completed' AND id <> ? AND id <> ?
         ORDER BY created_at,rowid`,
      ).all(turn.conversation_id, turn.message_id ?? "", turn.user_message_id ?? "") as { id: string; role: string; content: string }[];
      const summaryMessageId = stringColumn(conversation, "summary_message_id");
      const mode = stringColumn(conversation, "mode");
      if (!isConversationMode(mode)) throw new Error(`SQLite conversation mode "${mode}" is invalid`);
      // 摘要覆盖到的消息不再注入原文：它们已被压缩成 summary，重复注入只会浪费预算。
      const summaryIndex = summaryMessageId
        ? history.findIndex((item) => item.id === summaryMessageId)
        : -1;
      const recent = summaryIndex >= 0 ? history.slice(summaryIndex + 1) : history;
      return {
        turnId: turn.id,
        conversationId: turn.conversation_id,
        projectId: numberColumn(conversation, "project_id"),
        projectName: stringColumn(conversation, "project_name"),
        targetBranch: stringColumn(conversation, "target_branch"),
        mode,
        headSha: turn.head_sha,
        actorId: turn.actor_id,
        request: turn.request,
        attempt: turn.attempt_count + 1,
        history: recent
          .filter((item) => item.role === "user" || item.role === "assistant")
          .map((item) => ({ id: item.id, role: item.role as "user" | "assistant", content: item.content })),
        summary: stringColumn(conversation, "summary") || null,
        summaryMessageId: summaryMessageId || null,
      };
    });
  }

  /** 记录一次对话轮次尝试的失败，并把轮次状态置为指定终态。 */
  failConversationTurn(
    turnId: string,
    status: Exclude<ConversationTurnStatus, "queued" | "running" | "completed">,
    error: string,
  ): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM conversation_turns WHERE id=?").get(turnId) as
        | Record<string, unknown>
        | undefined;
      const turn = row ? readConversationTurnRow(row) : undefined;
      if (!turn) throw new Error(`conversation turn "${turnId}" not found`);
      const result = this.db.prepare(
        "UPDATE conversation_turns SET status=?,last_error=?,updated_at=? WHERE id=? AND status='running'",
      ).run(status, error.slice(0, 4096), now, turnId);
      if (result.changes !== 1) throw new Error(`conversation turn "${turnId}" is not running`);
      this.insertAudit(turn.actor_id, "conversation_turn", turnId, `running->${status}`, now);
      if (turn.message_id) {
        this.db.prepare(
          "UPDATE conversation_messages SET content=?,status='failed',updated_at=? WHERE id=?",
        ).run(error.slice(0, 20_000), now, turn.message_id);
      }
      this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, turn.conversation_id);
    });
  }

  /** 完成一轮对话：写入助手回复正文并把轮次置为完成。 */
  finishConversationTurn(turnId: string, content: string, model = ""): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM conversation_turns WHERE id=?").get(turnId) as
        | Record<string, unknown>
        | undefined;
      const turn = row ? readConversationTurnRow(row) : undefined;
      if (!turn) throw new Error(`conversation turn "${turnId}" not found`);
      const result = this.db.prepare(
        "UPDATE conversation_turns SET status='completed',last_error='',model=?,updated_at=? WHERE id=? AND status='running'",
      ).run(model, now, turnId);
      if (result.changes !== 1) throw new Error(`conversation turn "${turnId}" is not running`);
      this.insertAudit(turn.actor_id, "conversation_turn", turnId, "running->completed", now);
      if (turn.message_id) {
        this.db.prepare(
          "UPDATE conversation_messages SET content=?,status='completed',updated_at=? WHERE id=?",
        ).run(content, now, turn.message_id);
      }
      this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, turn.conversation_id);
    });
  }

  /**
   * 保存对话的滚动摘要，并记录摘要覆盖到的消息边界。只向前推进：传入的
   * `summaryMessageId` 早于或等于当前边界时忽略，避免并发轮次把摘要回退。
   */
  saveConversationSummary(
    conversationId: string,
    summary: string,
    summaryMessageId: string | null,
  ): void {
    const trimmed = summary.trim().slice(0, maxConversationSummaryCharacters);
    if (!trimmed) return;
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM conversations WHERE id=?").get(conversationId) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error(`conversation "${conversationId}" not found`);
      const currentMessageId = stringColumn(row, "summary_message_id");
      if (currentMessageId && summaryMessageId) {
        const boundary = this.db.prepare(
          `SELECT id FROM conversation_messages WHERE conversation_id=? AND id IN (?,?)
           ORDER BY created_at,rowid`,
        ).all(conversationId, currentMessageId, summaryMessageId) as { id: string }[];
        // 新边界若不在旧边界之后，说明摘要不会推进，直接放弃写入。
        if (boundary.length === 2 && boundary[0]!.id !== summaryMessageId) return;
        if (boundary.length === 0) return;
      }
      this.db.prepare(
        "UPDATE conversations SET summary=?,summary_message_id=?,updated_at=? WHERE id=?",
      ).run(trimmed, summaryMessageId ?? "", new Date().toISOString(), conversationId);
    });
  }

  /**
   * 保存模型生成的对话标题。只写入一次：已有标题时忽略，避免后续轮次把标题改掉，
   * 也避免与并发的首轮生成相互覆盖。
   */
  saveConversationTitle(conversationId: string, title: string): void {
    const trimmed = title.trim().replaceAll(/\s+/g, " ").slice(0, maxConversationTitleCharacters);
    if (!trimmed) return;
    this.transaction(() => {
      const row = this.db.prepare("SELECT title FROM conversations WHERE id=?").get(conversationId) as
        | { title: string }
        | undefined;
      if (!row) throw new Error(`conversation "${conversationId}" not found`);
      if (row.title) return;
      this.db.prepare("UPDATE conversations SET title=?,updated_at=? WHERE id=?")
        .run(trimmed, new Date().toISOString(), conversationId);
    });
  }

  /**
   * 用 LLM 精炼后的标题覆盖创建时的临时标题；失败不影响会话。
   */
  refineConversationTitle(conversationId: string, title: string): void {
    const trimmed = title.trim().replaceAll(/\s+/g, " ").slice(0, maxConversationTitleCharacters);
    if (!trimmed) return;
    this.db.prepare("UPDATE conversations SET title=?,updated_at=? WHERE id=?")
      .run(trimmed, new Date().toISOString(), conversationId);
  }

  /** 读取 Agent 控制台可覆盖的运行时设置；键不存在时返回 undefined。 */
  getRuntimeSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM runtime_settings WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /** 写入运行时设置并返回写入时间；空值表示删除该覆盖项。actor 记录控制台操作者。 */
  setRuntimeSetting(key: string, value: string | null, actor = ""): string {
    const now = new Date().toISOString();
    if (value === null) {
      this.db.prepare("DELETE FROM runtime_settings WHERE key=?").run(key);
      return now;
    }
    this.db.prepare(
      `INSERT INTO runtime_settings (key,value,updated_at,updated_by) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    ).run(key, value, now, actor);
    return now;
  }

  /** 列出全部运行时设置覆盖项，键按字典序。 */
  listRuntimeSettings(): { key: string; value: string; updatedAt: string; updatedBy: string }[] {
    const rows = this.db.prepare(
      "SELECT key,value,updated_at,updated_by FROM runtime_settings ORDER BY key",
    ).all() as { key: string; value: string; updated_at: string; updated_by: string }[];
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  }

  /**
   * 升级兼容：事件调度参数曾存放在 `worker_*` 键下，统一迁移为 `events_*`。
   * 新旧键同时存在时以新键为准并删除旧键；返回迁移的键数量。
   */
  migrateLegacyEventRuntimeSettings(): number {
    return this.transaction(() => {
      const mappings = [
        ["worker_poll_interval", "events_poll_interval"],
        ["worker_event_timeout", "events_timeout"],
      ] as const;
      let migrated = 0;
      for (const [legacy, current] of mappings) {
        if (this.getRuntimeSetting(legacy) === undefined) continue;
        if (this.getRuntimeSetting(current) === undefined) {
          this.db.prepare("UPDATE runtime_settings SET key=? WHERE key=?").run(current, legacy);
        } else {
          this.db.prepare("DELETE FROM runtime_settings WHERE key=?").run(legacy);
        }
        migrated++;
      }
      return migrated;
    });
  }

  /** 按 GitLab 用户 ID 创建或更新本地用户，返回带解密令牌的用户。 */
  upsertUser(identity: GitLabIdentity, cipher: TokenCipher): AuthUser {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const existing = this.db
        .prepare("SELECT id FROM users WHERE gitlab_user_id=?")
        .get(identity.gitlabUserId) as { id: string } | undefined;
      const userId = existing?.id ?? randomUUID();
      const accessToken = cipher.encrypt(identity.accessToken);
      const refreshToken = cipher.encrypt(identity.refreshToken);
      if (existing) {
        this.db.prepare(
          `UPDATE users SET username=?,name=?,avatar_url=?,access_token=?,refresh_token=?,token_expires_at=?,updated_at=? WHERE id=?`,
        ).run(identity.username, identity.name, identity.avatarUrl, accessToken, refreshToken, identity.expiresAt, now, userId);
      } else {
        const firstUser = (this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count === 0;
        this.db.prepare(
          `INSERT INTO users(id,gitlab_user_id,username,name,avatar_url,access_token,refresh_token,token_expires_at,is_admin,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(userId, identity.gitlabUserId, identity.username, identity.name, identity.avatarUrl, accessToken, refreshToken, identity.expiresAt, firstUser ? 1 : 0, now, now);
      }
      const saved = this.readUser(userId, cipher);
      if (!saved) throw new Error(`user "${userId}" disappeared after upsert`);
      return saved;
    });
  }

  /** 读取用户并解密令牌；用户不存在时返回 undefined。 */
  readUser(userId: string, cipher: TokenCipher): AuthUser | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id=?").get(userId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      gitlabUserId: Number(row.gitlab_user_id),
      username: String(row.username),
      name: String(row.name ?? ""),
      avatarUrl: String(row.avatar_url ?? ""),
      accessToken: cipher.decrypt(String(row.access_token ?? "")),
      refreshToken: cipher.decrypt(String(row.refresh_token ?? "")),
      tokenExpiresAt: Number(row.token_expires_at ?? 0),
      isAdmin: row.is_admin === 1 || row.is_admin === true,
    };
  }

  /** 列出全部登录用户，供管理员管理。 */
  listUsers(): ManagedUser[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY created_at,id").all() as Record<string, unknown>[])
      .map((row) => ({
        id: String(row.id),
        gitlabUserId: Number(row.gitlab_user_id),
        username: String(row.username),
        name: String(row.name ?? ""),
        avatarUrl: String(row.avatar_url ?? ""),
        isAdmin: row.is_admin === 1 || row.is_admin === true,
      }));
  }

  /** 设置或取消管理员；不允许取消最后一个管理员，返回是否命中用户。 */
  setUserAdmin(userId: string, admin: boolean): boolean {
    const existing = this.db.prepare("SELECT is_admin FROM users WHERE id=?").get(userId) as
      | { is_admin: number }
      | undefined;
    if (!existing) return false;
    if (!admin && existing.is_admin === 1) {
      const count = (this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin=1").get() as { count: number }).count;
      if (count <= 1) throw new Error("at least one administrator is required");
    }
    this.db.prepare("UPDATE users SET is_admin=?,updated_at=? WHERE id=?")
      .run(admin ? 1 : 0, new Date().toISOString(), userId);
    return true;
  }

  /** 更新令牌（刷新后调用）；令牌字段存密文。 */
  updateUserTokens(userId: string, identity: GitLabIdentity, cipher: TokenCipher): void {
    this.db.prepare(
      "UPDATE users SET access_token=?,refresh_token=?,token_expires_at=?,updated_at=? WHERE id=?",
    ).run(cipher.encrypt(identity.accessToken), cipher.encrypt(identity.refreshToken), identity.expiresAt, new Date().toISOString(), userId);
  }

  createUserSession(userId: string, expiresAt: number): string {
    const id = randomUUID();
    this.db.prepare("INSERT INTO user_sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)")
      .run(id, userId, new Date().toISOString(), expiresAt);
    return id;
  }

  readUserSession(sessionId: string): { userId: string; expiresAt: number } | undefined {
    const row = this.db.prepare("SELECT user_id,expires_at FROM user_sessions WHERE id=? AND expires_at>?")
      .get(sessionId, Date.now()) as { user_id: string; expires_at: number } | undefined;
    return row ? { userId: String(row.user_id), expiresAt: Number(row.expires_at) } : undefined;
  }

  deleteUserSession(sessionId: string): void {
    this.db.prepare("DELETE FROM user_sessions WHERE id=?").run(sessionId);
  }

  /** 读取或生成本地加密主密钥；密钥保存在 SQLite，不依赖环境变量。 */
  getOrCreateSessionSecret(): string {
    const existing = this.getRuntimeSetting("system_session_secret");
    if (existing) return existing;
    return this.transaction(() => {
      const fresh = `${randomUUID()}${randomUUID()}`;
      this.db.prepare(
        "INSERT INTO runtime_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)",
      ).run("system_session_secret", fresh, new Date().toISOString(), "system");
      return fresh;
    });
  }

  /** 读取最近的审计记录（写入顺序倒序），供运维排查与测试断言。 */
  listAuditEvents(limit = 100): {
    actorId: number;
    action: string;
    resource: string;
    result: string;
    createdAt: string;
  }[] {
    const rows = this.db.prepare(
      "SELECT actor_id,action,resource,result,created_at FROM audit_events ORDER BY id DESC LIMIT ?",
    ).all(limit) as {
      actor_id: number;
      action: string;
      resource: string;
      result: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      actorId: row.actor_id,
      action: row.action,
      resource: row.resource,
      result: row.result,
      createdAt: row.created_at,
    }));
  }

  /**
   * 记录一次运行时设置变更。设置不属于 GitLab 用户，actor_id 固定为 0，
   * 控制台操作者写入 resource；结果保存「旧值->新值」摘要，便于审计回溯。
   */
  recordSettingsAudit(actor: string, changes: Record<string, string>): void {
    const keys = Object.keys(changes).sort();
    if (keys.length === 0) return;
    const summary = keys.map((key) => `${key}: ${changes[key]}`).join("; ").slice(0, 4_000);
    this.insertAudit(0, "update_settings", `settings:${actor || "ops-console"}`, summary);
  }

  /** 归档或取消归档一个对话；已归档的对话仍可通过详情接口读取。 */
  setConversationArchived(conversationId: string, archived: boolean): boolean {
    const result = this.db.prepare("UPDATE conversations SET archived=?,updated_at=? WHERE id=?")
      .run(archived ? 1 : 0, new Date().toISOString(), conversationId);
    return result.changes === 1;
  }

  /** 删除一个对话及其轮次、消息与轨迹（显式删除，不依赖连接级外键开关）。 */
  deleteConversation(conversationId: string): boolean {
    return this.transaction(() => {
      const turnIds = (this.db.prepare("SELECT id FROM conversation_turns WHERE conversation_id=?")
        .all(conversationId) as { id: string }[]).map((row) => row.id);
      if (turnIds.length > 0) {
        const placeholders = turnIds.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM event_trace WHERE turn_id IN (${placeholders})`).run(...turnIds);
        this.db.prepare(`DELETE FROM execution_steps WHERE turn_id IN (${placeholders})`).run(...turnIds);
      }
      this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id=?").run(conversationId);
      this.db.prepare("DELETE FROM conversation_turns WHERE conversation_id=?").run(conversationId);
      return this.db.prepare("DELETE FROM conversations WHERE id=?").run(conversationId).changes === 1;
    });
  }

  /** 保存一轮对话的过程快照（思考、中间回复、工具调用），与落库回答分开存放。 */
  saveConversationTurnProcess(turnId: string, entries: readonly ConversationProcessEntry[]): void {
    const serialized = JSON.stringify(sanitizeConversationProcess(entries));
    this.db.prepare("UPDATE conversation_turns SET process=? WHERE id=?").run(serialized, turnId);
  }

  /** 标记对话轮次为取消；已结束的轮次保持原状。 */
  cancelConversationTurn(turnId: string, content: string): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM conversation_turns WHERE id=?").get(turnId) as
        | Record<string, unknown>
        | undefined;
      const turn = row ? readConversationTurnRow(row) : undefined;
      if (!turn) throw new Error(`conversation turn "${turnId}" not found`);
      const result = this.db.prepare(
        "UPDATE conversation_turns SET status='cancelled',last_error=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
      ).run(content.slice(0, 4096), now, turnId);
      if (result.changes !== 1) return;
      this.insertAudit(turn.actor_id, "conversation_turn", turnId, `${turn.status}->cancelled`, now);
      if (turn.message_id) {
        this.db.prepare(
          "UPDATE conversation_messages SET content=?,status='failed',updated_at=? WHERE id=?",
        ).run(content.slice(0, 20_000), now, turn.message_id);
      }
      this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, turn.conversation_id);
    });
  }

  /**
   * 把上一次进程退出时残留的排队/执行中轮次标记为失败。对话轮次由 Server 内联执行，
   * 没有跨进程的持久队列，重启后无法恢复；显式落库比静默挂起更便于运维发现并重发。
   */
  recoverInterruptedConversationTurns(): number {
    const now = new Date().toISOString();
    const error = "The Server restarted before this turn finished; send the message again.";
    return this.transaction(() => {
      const rows = this.db.prepare(
        "SELECT id,message_id,conversation_id,actor_id,status FROM conversation_turns WHERE role='assistant' AND status IN ('queued','running')",
      ).all() as { id: string; message_id: string | null; conversation_id: string; actor_id: number; status: string }[];
      for (const turn of rows) {
        this.db.prepare(
          "UPDATE conversation_turns SET status='failed',last_error=?,updated_at=? WHERE id=? AND status IN ('queued','running')",
        ).run(error, now, turn.id);
        if (turn.message_id) {
          this.db.prepare("UPDATE conversation_messages SET content=?,status='failed',updated_at=? WHERE id=?").run(
            error,
            now,
            turn.message_id,
          );
        }
        this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, turn.conversation_id);
        this.insertAudit(turn.actor_id, "conversation_turn", turn.id, `${turn.status}->failed`, now);
      }
      return rows.length;
    });
  }

  private validateConversationInput(input: CreateConversationInput): void {
    if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) throw new Error("project ID must be positive");
    if (!input.targetBranch.trim() || input.targetBranch.length > 255) throw new Error("target branch is invalid");
    if (!/^[a-f0-9]{40,64}$/i.test(input.headSha)) throw new Error("conversation head SHA is invalid");
    if (!Number.isSafeInteger(input.actorId) || input.actorId < 0) throw new Error("actor ID is invalid");
    if (input.projectName.length > 255) throw new Error("conversation labels are too long");
    if (input.mode !== undefined && !isConversationMode(input.mode)) throw new Error("conversation mode is invalid");
    if (!input.request.trim() || input.request.length > 20_000) throw new Error("conversation message must be between 1 and 20000 characters");
  }

  private enqueueConversationTurn(
    conversationId: string,
    input: Omit<CreateConversationInput, "projectName">,
    now: string,
  ): CreatedConversationTurn {
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const responseId = randomUUID();
    const request = input.request.trim();
    this.db.prepare(
      `INSERT INTO conversation_turns
         (id,conversation_id,message_id,user_message_id,role,status,request,head_sha,actor_id,attempt_count,last_error,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      turnId,
      conversationId,
      responseId,
      userMessageId,
      "assistant",
      "queued",
      request,
      input.headSha,
      input.actorId,
      0,
      "",
      now,
      now,
    );
    this.db.prepare(
      `INSERT INTO conversation_messages
         (id,conversation_id,role,content,status,turn_id,head_sha,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(userMessageId, conversationId, "user", request, "completed", null, input.headSha, now, now);
    this.db.prepare(
      `INSERT INTO conversation_messages
         (id,conversation_id,role,content,status,turn_id,head_sha,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(responseId, conversationId, "assistant", "", "queued", turnId, input.headSha, now, now);
    this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
    return { conversationId, turnId };
  }

  private readConversationSummary(row: Record<string, unknown>): ConversationSummary {
    const lastTurnStatus = row.last_turn_status;
    if (lastTurnStatus !== null && lastTurnStatus !== undefined &&
      (typeof lastTurnStatus !== "string" || !isConversationTurnStatus(lastTurnStatus))) {
      throw new Error(`SQLite conversation turn status "${String(lastTurnStatus)}" is invalid`);
    }
    const mode = stringColumn(row, "mode");
    if (!isConversationMode(mode)) throw new Error(`SQLite conversation mode "${mode}" is invalid`);
    return {
      id: stringColumn(row, "id"),
      title: stringColumn(row, "title"),
      projectId: numberColumn(row, "project_id"),
      projectName: stringColumn(row, "project_name"),
      targetBranch: stringColumn(row, "target_branch"),
      mode,
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      turnCount: numberColumn(row, "turn_count"),
      lastTurnStatus: (lastTurnStatus ?? null) as ConversationSummary["lastTurnStatus"],
      archived: row.archived === 1 || row.archived === true,
      ownerUserId: stringColumn(row, "owner_user_id"),
    };
  }

  private readConversationMessage(row: Record<string, unknown>): ConversationMessage {
    const role = stringColumn(row, "role");
    const status = stringColumn(row, "status");
    if (role !== "user" && role !== "assistant") throw new Error(`SQLite conversation message role "${role}" is invalid`);
    if (!(["queued", "running", "completed", "failed"] as string[]).includes(status)) {
      throw new Error(`SQLite conversation message status "${status}" is invalid`);
    }
    const turnId = row.turn_id;
    if (turnId !== null && typeof turnId !== "string") throw new Error('SQLite column "turn_id" is not text or null');
    const turnStatus = row.turn_status;
    if (turnStatus !== null && turnStatus !== undefined && (typeof turnStatus !== "string" || !isConversationTurnStatus(turnStatus))) {
      throw new Error(`SQLite conversation turn status "${String(turnStatus)}" is invalid`);
    }
    const resolvedTurnStatus = turnStatus && isConversationTurnStatus(turnStatus) ? turnStatus : null;
    const start = typeof row.turn_created_at === "string" ? row.turn_created_at : "";
    const end = typeof row.turn_updated_at === "string" ? row.turn_updated_at : "";
    const durationMs = start && end && resolvedTurnStatus && terminalConversationTurn.has(resolvedTurnStatus)
      ? turnDurationMs(start, end, true)
      : null;
    const generationOutputTokens = row.generation_output_tokens === undefined ? 0 : numberColumn(row, "generation_output_tokens");
    const generationDurationMs = row.generation_duration_ms === undefined ? 0 : numberColumn(row, "generation_duration_ms");
    const tps = generationDurationMs > 0 && generationOutputTokens > 0
      ? generationOutputTokens * 1000 / generationDurationMs
      : null;
    return {
      id: stringColumn(row, "id"),
      role,
      content: stringColumn(row, "content"),
      status: status as ConversationMessage["status"],
      turnId,
      headSha: stringColumn(row, "head_sha"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      turnStatus: (turnStatus ?? null) as ConversationMessage["turnStatus"],
      traceCount: row.trace_count === undefined ? 0 : numberColumn(row, "trace_count"),
      stepCount: row.step_count === undefined ? 0 : numberColumn(row, "step_count"),
      model: typeof row.turn_model === "string" ? row.turn_model : "",
      durationMs,
      tps,
      toolCalls: [],
      process: typeof row.turn_process === "string" ? readConversationProcess(row.turn_process) : [],
    };
  }

  /** 把一条工具轨迹行收窄为对话列表展示的摘要，参数按上限截断。 */
  private readConversationToolCall(row: Record<string, unknown>): ConversationToolCall {
    const status = stringColumn(row, "status");
    if (status !== "running" && status !== "succeeded" && status !== "failed") {
      throw new Error(`SQLite event trace status "${status}" is invalid`);
    }
    const duration = row.duration_ms;
    if (duration !== null && duration !== undefined && (typeof duration !== "number" || !Number.isSafeInteger(duration))) {
      throw new Error('SQLite column "duration_ms" is not a safe integer or null');
    }
    const input = row.trace_input;
    if (input !== null && input !== undefined && typeof input !== "string") {
      throw new Error('SQLite column "trace_input" is not text or null');
    }
    return {
      name: stringColumn(row, "name"),
      status,
      input: typeof input === "string" ? input.slice(0, maxConversationToolInputBytes) : null,
      durationMs: typeof duration === "number" ? duration : null,
    };
  }

  cancellationRequested(eventId: string, leaseToken: string): boolean {
    if (!leaseToken) throw new Error("event lease token is required");
    const row = this.db
      .prepare("SELECT cancel_requested FROM events WHERE id=? AND lease_token=?")
      .get(eventId, leaseToken) as { cancel_requested: number } | undefined;
    if (!row) throw new Error(`event "${eventId}" lease is no longer owned`);
    return row.cancel_requested !== 0;
  }

  getEvent(eventId: string): Event {
    const row = readEventRow(this.db.prepare("SELECT * FROM events WHERE id=?").get(eventId));
    if (!row) throw new Error(`event "${eventId}" not found`);
    return mapEvent(row);
  }

  listEvents(status?: EventStatus, limit = 50): EventSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("event list limit must be between 1 and 200");
    }
    const rows = status
      ? this.db
          .prepare("SELECT * FROM events WHERE status = ? ORDER BY created_at DESC LIMIT ?")
          .all(status, limit)
      : this.db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map((value) => {
      const row = readEventRow(value as Record<string, unknown>);
      if (!row) throw new Error("SQLite returned an empty event row");
      return mapEventSummary(row);
    });
  }

  listOperationsEvents(query: EventListQuery): EventPage {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new Error("operations event list limit must be between 1 and 100");
    }
    if (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > 1_000_000) {
      throw new Error("operations event list offset must be between 0 and 1000000");
    }
    if (query.status && !isEventStatus(query.status)) {
      throw new Error(`unknown event status "${query.status}"`);
    }
    if (query.type && !isEventType(query.type)) {
      throw new Error(`unknown event type "${query.type}"`);
    }
    for (const [label, value] of [
      ["project ID", query.projectId],
      ["MR IID", query.mrIid],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new Error(`${label} must be a positive safe integer`);
      }
    }
    const search = query.search?.trim() ?? "";
    if (search.length > 100) throw new Error("operations event search must be at most 100 characters");

    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.status) {
      clauses.push("status = ?");
      parameters.push(query.status);
    }
    if (query.type) {
      clauses.push("type = ?");
      parameters.push(query.type);
    }
    if (query.projectId !== undefined) {
      clauses.push("project_id = ?");
      parameters.push(query.projectId);
    }
    if (query.mrIid !== undefined) {
      clauses.push("mr_iid = ?");
      parameters.push(query.mrIid);
    }
    if (search) {
      clauses.push("(instr(lower(id), lower(?)) > 0 OR instr(CAST(project_id AS TEXT) || ':' || CAST(CASE WHEN target_type='merge_request' THEN mr_iid ELSE target_iid END AS TEXT), ?) > 0)");
      parameters.push(search, search);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const count = this.db
      .prepare(`SELECT COUNT(*) AS count FROM events ${where}`)
      .get(...parameters) as Record<string, unknown>;
    const rows = this.db
      .prepare(
        `SELECT events.*,
         CASE
           WHEN events.status='queued' THEN COALESCE(
             (SELECT created_at FROM audit_events
              WHERE resource=events.id AND action IN ('event_status','operator_retry') AND result LIKE '%->queued'
              ORDER BY id DESC LIMIT 1),
             events.created_at
           )
           WHEN events.status IN ('preparing','analyzing','fixing','verifying','publishing') THEN COALESCE(
             (SELECT started_at FROM event_attempts WHERE event_id=events.id AND attempt=events.attempt_count),
             events.created_at
           )
           ELSE events.created_at
         END AS activity_started_at
         FROM events ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...parameters, query.limit, query.offset);
    const items = rows.map((value) => {
      const record = value as Record<string, unknown>;
      const row = readEventRow(record);
      if (!row) throw new Error("SQLite returned an empty event row");
      return {
        ...mapEventSummary(row),
        activityStartedAt: stringColumn(record, "activity_started_at"),
      } satisfies EventOperationsSummary;
    });
    return { items, total: numberColumn(count, "count") };
  }

  getEventDetails(eventId: string): EventDetails | undefined {
    const event = readEventRow(this.db.prepare("SELECT * FROM events WHERE id=?").get(eventId));
    if (!event) return undefined;
    const attempts = this.readEventAttempts(eventId);
    const timeline = this.readEventTimeline(eventId);
    const trajectory = this.readEventTrajectory({ kind: "event", eventId });
    const events = this.readExecutionSteps({ kind: "event", eventId });
    const origin = readWebhookOrigin(events);
    return { ...mapEventSummary(event), ...origin, attempts, timeline, trajectory, events };
  }

  private readEventAttempts(eventId: string): EventAttemptSummary[] {
    return this.db
      .prepare("SELECT attempt, started_at, finished_at, error FROM event_attempts WHERE event_id=? ORDER BY attempt")
      .all(eventId)
      .map((value) => {
        const row = value as Record<string, unknown>;
        const finishedAt = row.finished_at;
        if (finishedAt !== null && typeof finishedAt !== "string") {
          throw new Error('SQLite column "finished_at" is not text or null');
        }
        return {
          attempt: numberColumn(row, "attempt"),
          startedAt: stringColumn(row, "started_at"),
          finishedAt,
          error: stringColumn(row, "error"),
        } satisfies EventAttemptSummary;
      });
  }

  private readEventTimeline(eventId: string): EventStatusTransition[] {
    return this.readStatusTransitions(eventId, "event_status", isEventStatus);
  }

  private readTurnTimeline(turnId: string): ConversationTurnTransition[] {
    return this.readStatusTransitions(turnId, "conversation_turn", isConversationTurnStatus);
  }

  /** 从审计日志读取某个资源的 `from->to` 状态迁移；非法记录直接抛错。 */
  private readStatusTransitions<S extends string>(
    resource: string,
    action: string,
    isStatus: (value: string) => value is S,
  ): StatusTransition<S>[] {
    return this.db
      .prepare("SELECT result, created_at FROM audit_events WHERE resource=? AND action=? ORDER BY id")
      .all(resource, action)
      .map((value) => {
        const row = value as Record<string, unknown>;
        const result = stringColumn(row, "result");
        const separator = result.indexOf("->");
        if (separator <= 0) throw new Error("SQLite status transition is malformed");
        const from = result.slice(0, separator);
        const to = result.slice(separator + 2);
        if (!isStatus(from) || !isStatus(to)) {
          throw new Error("SQLite status transition contains an invalid status");
        }
        return {
          from,
          to,
          at: stringColumn(row, "created_at"),
        } satisfies StatusTransition<S>;
      });
  }

  private readEventTrajectory(scope: TraceScope): EventTraceEntry[] {
    const column = traceScopeColumn(scope);
    return this.db
      .prepare(`SELECT * FROM event_trace WHERE ${column}=? ORDER BY started_at DESC,id DESC`)
      .all(traceScopeId(scope))
      .map((value) => readEventTrace(value as Record<string, unknown>));
  }

  private readExecutionSteps(scope: TraceScope): ExecutionStep[] {
    const column = traceScopeColumn(scope);
    return this.db
      .prepare(`SELECT * FROM execution_steps WHERE ${column}=? ORDER BY started_at DESC,id DESC`)
      .all(traceScopeId(scope))
      .map((value) => readExecutionStep(value as Record<string, unknown>));
  }

  getEventTraceEntries(scope: TraceScope, attempt: number): EventTraceEntry[] {
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new Error("event trace query requires a positive attempt number");
    }
    const column = traceScopeColumn(scope);
    return this.db
      .prepare(`SELECT * FROM event_trace WHERE ${column}=? AND attempt=? ORDER BY started_at,id`)
      .all(traceScopeId(scope), attempt)
      .map((value) => readEventTrace(value as Record<string, unknown>));
  }

  activeEventIds(): Set<string> {
    const rows = this.db
      .prepare(`SELECT id FROM events WHERE status IN (${active.map(() => "?").join(",")})`)
      .all(...active) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  }

  pendingProjectIds(): Set<number> {
    const terminalStatuses = ["completed", "failed", "stale", "cancelled"];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT project_id FROM events
         WHERE status NOT IN (${terminalStatuses.map(() => "?").join(",")})
         UNION SELECT DISTINCT project_id FROM conversations`,
      )
      .all(...terminalStatuses) as { project_id: number }[];
    // 对话可以随后续提问重新访问任何历史仓库：这些项目的镜像不能被清理掉，
    // 否则每次重新提问都要重新克隆整座仓库。
    return new Set(rows.map((row) => row.project_id));
  }

  /** 记录一次存储清理的结果，供控制台查看历史。 */
  recordStorageCleanup(entry: Omit<StorageCleanupRecord, "id">): void {
    this.db.prepare(
      `INSERT INTO storage_cleanup_log
       (started_at, finished_at, source, applied, older_than_days, removed_workspaces, removed_mirrors, error)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      entry.startedAt,
      entry.finishedAt,
      entry.source.slice(0, 40),
      entry.applied ? 1 : 0,
      entry.olderThanDays,
      entry.removedWorkspaces,
      entry.removedMirrors,
      entry.error.slice(0, 8_000),
    );
  }

  /** 存储清理记录总数，供控制台分页。 */
  countStorageCleanups(): number {
    return numberColumn(this.db.prepare("SELECT COUNT(*) AS count FROM storage_cleanup_log").get() as Record<string, unknown>, "count");
  }

  /** 存储清理记录，最新在前；limit/offset 由调用方校验。 */
  listStorageCleanups(limit = 10, offset = 0): StorageCleanupRecord[] {
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 10;
    const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const rows = this.db.prepare("SELECT * FROM storage_cleanup_log ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?")
      .all(safeLimit, safeOffset) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: numberColumn(row, "id"),
      startedAt: stringColumn(row, "started_at"),
      finishedAt: stringColumn(row, "finished_at"),
      source: stringColumn(row, "source"),
      applied: numberColumn(row, "applied") === 1,
      olderThanDays: numberColumn(row, "older_than_days"),
      removedWorkspaces: numberColumn(row, "removed_workspaces"),
      removedMirrors: numberColumn(row, "removed_mirrors"),
      error: stringColumn(row, "error"),
    }));
  }

  /** 全部供应商（管理员视角），包括系统级与用户级。 */
  listModelProviders(): ModelProviderDetails[] {
    return this.collectModelProviders(
      this.db.prepare("SELECT * FROM model_providers ORDER BY created_at,id").all() as Record<string, unknown>[],
    );
  }

  /** 用户可见的供应商：系统级共享，外加该用户自己创建的。 */
  listModelProvidersForUser(userId: string): ModelProviderDetails[] {
    return this.collectModelProviders(
      this.db
        .prepare("SELECT * FROM model_providers WHERE owner_user_id='' OR owner_user_id=? ORDER BY created_at,id")
        .all(userId) as Record<string, unknown>[],
    );
  }

  private collectModelProviders(rows: Record<string, unknown>[]): ModelProviderDetails[] {
    const providers = rows.map((row) => this.readModelProvider(row));
    const models = (this.db.prepare("SELECT * FROM provider_models ORDER BY created_at,id").all() as Record<string, unknown>[])
      .map((row) => this.readProviderModel(row));
    return providers.map((provider) => ({
      ...provider,
      models: models.filter((model) => model.providerId === provider.id),
    }));
  }

  /** 传入 ownerUserId 时只允许读取系统级或该用户自己的供应商。 */
  getModelProvider(id: string, ownerUserId?: string): ModelProvider | undefined {
    const row = (
      ownerUserId === undefined
        ? this.db.prepare("SELECT * FROM model_providers WHERE id=?").get(id)
        : this.db.prepare("SELECT * FROM model_providers WHERE id=? AND (owner_user_id='' OR owner_user_id=?)").get(id, ownerUserId)
    ) as Record<string, unknown> | undefined;
    return row ? this.readModelProvider(row) : undefined;
  }

  createModelProvider(input: ModelProviderInput, ownerUserId = ""): ModelProvider {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO model_providers (id,name,base_url,api_key,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run(id, input.name, input.baseUrl, input.apiKey, ownerUserId, now, now);
    return this.getModelProvider(id)!;
  }

  updateModelProvider(id: string, input: ModelProviderInput, ownerUserId?: string): ModelProvider | undefined {
    const existing = ownerUserId === undefined ? this.getModelProvider(id) : this.getModelProvider(id, ownerUserId);
    if (!existing || (ownerUserId !== undefined && existing.ownerUserId !== ownerUserId)) return undefined;
    const result = this.db.prepare(
      "UPDATE model_providers SET name=?,base_url=?,api_key=?,updated_at=? WHERE id=?",
    ).run(input.name, input.baseUrl, input.apiKey, new Date().toISOString(), id);
    return result.changes === 1 ? this.getModelProvider(id) : undefined;
  }

  deleteModelProvider(id: string, ownerUserId?: string): boolean {
    const existing = ownerUserId === undefined ? this.getModelProvider(id) : this.getModelProvider(id, ownerUserId);
    if (!existing || (ownerUserId !== undefined && existing.ownerUserId !== ownerUserId)) return false;
    return this.transaction(() => {
      const removed = this.db.prepare("DELETE FROM model_providers WHERE id=?").run(id).changes === 1;
      // 删除供应商会级联删除其模型；若删掉的是当前模型，提升剩余的第一个。
      if (removed) this.promoteFirstProviderModel();
      if (removed) this.db.prepare("DELETE FROM user_model_selections WHERE provider_id=?").run(id);
      return removed;
    });
  }

  getProviderModel(providerId: string, id: string): ProviderModel | undefined {
    const row = this.db
      .prepare("SELECT * FROM provider_models WHERE provider_id=? AND id=?")
      .get(providerId, id) as Record<string, unknown> | undefined;
    return row ? this.readProviderModel(row) : undefined;
  }

  createProviderModel(providerId: string, input: ProviderModelInput, ownerUserId?: string): ProviderModel | undefined {
    return this.transaction(() => {
      const provider = ownerUserId === undefined
        ? this.getModelProvider(providerId)
        : this.getModelProvider(providerId, ownerUserId);
      if (!provider || (ownerUserId !== undefined && provider.ownerUserId !== ownerUserId)) return undefined;
      const now = new Date().toISOString();
      const id = randomUUID();
      const first = ownerUserId === undefined &&
        (this.db.prepare("SELECT COUNT(*) AS count FROM provider_models").get() as { count: number }).count === 0;
      this.db.prepare(
        `INSERT INTO provider_models (id,provider_id,name,context_window,max_output_tokens,active,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(id, providerId, input.name, input.contextWindow, input.maxOutputTokens, first ? 1 : 0, now, now);
      return this.getProviderModel(providerId, id);
    });
  }

  updateProviderModel(providerId: string, id: string, input: ProviderModelInput, ownerUserId?: string): ProviderModel | undefined {
    const provider = ownerUserId === undefined ? this.getModelProvider(providerId) : this.getModelProvider(providerId, ownerUserId);
    if (!provider || (ownerUserId !== undefined && provider.ownerUserId !== ownerUserId)) return undefined;
    const result = this.db.prepare(
      "UPDATE provider_models SET name=?,context_window=?,max_output_tokens=?,updated_at=? WHERE provider_id=? AND id=?",
    ).run(input.name, input.contextWindow, input.maxOutputTokens, new Date().toISOString(), providerId, id);
    return result.changes === 1 ? this.getProviderModel(providerId, id) : undefined;
  }

  /**
   * 自动下调模型上下文窗口：只接受更小的值，并记录审计，便于操作台追溯自动改动。
   * 探测结果或超窗重试调用它，避免把服务端的临时错误当成永久扩大窗口的依据。
   */
  reduceProviderModelContextWindow(model: ProviderModel, contextWindow: number, reason: string): ProviderModel | undefined {
    if (
      !Number.isSafeInteger(contextWindow) || contextWindow < 1_024 ||
      contextWindow >= model.contextWindow || !reason.trim()
    ) {
      return undefined;
    }
    return this.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare(
        "UPDATE provider_models SET context_window=?,updated_at=? WHERE provider_id=? AND id=?",
      ).run(contextWindow, now, model.providerId, model.id);
      if (result.changes !== 1) return undefined;
      this.insertAudit(0, "auto_context_tune", model.id, `${model.contextWindow}->${contextWindow}:${reason}`, now);
      return this.getProviderModel(model.providerId, model.id);
    });
  }

  deleteProviderModel(providerId: string, id: string, ownerUserId?: string): boolean {
    const provider = ownerUserId === undefined ? this.getModelProvider(providerId) : this.getModelProvider(providerId, ownerUserId);
    if (!provider || (ownerUserId !== undefined && provider.ownerUserId !== ownerUserId)) return false;
    return this.transaction(() => {
      const removed = this.db
        .prepare("DELETE FROM provider_models WHERE provider_id=? AND id=?")
        .run(providerId, id).changes === 1;
      if (removed) this.promoteFirstProviderModel();
      if (removed) this.db.prepare("DELETE FROM user_model_selections WHERE model_id=?").run(id);
      return removed;
    });
  }

  activateProviderModel(providerId: string, id: string): ProviderModel | undefined {
    if (!this.getProviderModel(providerId, id)) return undefined;
    this.transaction(() => {
      this.db.prepare("UPDATE provider_models SET active=0 WHERE active=1").run();
      this.db.prepare("UPDATE provider_models SET active=1,updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    });
    return this.getProviderModel(providerId, id);
  }

  /** 当前使用的模型及其供应商；没有模型时返回空。 */
  getActiveModel(): ActiveModel | undefined {
    const row = this.db.prepare("SELECT * FROM provider_models WHERE active=1 LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const model = this.readProviderModel(row);
    const provider = this.getModelProvider(model.providerId);
    return provider ? { provider, model } : undefined;
  }

  /** 用户自己选择的模型记录。 */
  getUserModelSelection(userId: string): UserModelSelection | undefined {
    const row = this.db.prepare("SELECT * FROM user_model_selections WHERE user_id=?").get(userId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      userId: stringColumn(row, "user_id"),
      providerId: stringColumn(row, "provider_id"),
      modelId: stringColumn(row, "model_id"),
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  /** 设置用户选择的模型；return false 表示供应商或模型不存在/无权访问。 */
  setUserModelSelection(userId: string, providerId: string, modelId: string): boolean {
    const provider = this.getModelProvider(providerId, userId);
    if (!provider || !this.getProviderModel(providerId, modelId)) return false;
    this.db.prepare(
      `INSERT INTO user_model_selections (user_id,provider_id,model_id,updated_at) VALUES (?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET provider_id=excluded.provider_id,model_id=excluded.model_id,updated_at=excluded.updated_at`,
    ).run(userId, providerId, modelId, new Date().toISOString());
    return true;
  }

  /** 用户当前生效的模型：优先用户选择，否则回退到系统当前模型。 */
  getActiveModelForUser(userId: string): ActiveModel | undefined {
    const selection = this.getUserModelSelection(userId);
    if (!selection) return this.getActiveModel();
    const provider = this.getModelProvider(selection.providerId, userId);
    const model = provider ? this.getProviderModel(selection.providerId, selection.modelId) : undefined;
    return provider && model ? { provider, model } : this.getActiveModel();
  }

  /**
   * 升级兼容：把旧版写在运行时设置里的模型连接参数迁移为供应商 + 模型，
   * 避免升级后已保存的 Base URL 与 API Key 失效。Server 启动时调用，
   * 用写事务把「检查 + 插入」锁在一起，先到者生效，后者直接跳过。
   */
  migrateLegacyModelSettings(
    fallback: { contextWindow: number; maxOutputTokens: number },
    actorId: number,
  ): ActiveModel | undefined {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT COUNT(*) AS count FROM provider_models").get() as { count: number };
      if (existing.count > 0) return undefined;
      const rows = this.db
        .prepare(
          "SELECT key,value FROM runtime_settings WHERE key IN ('model','model_base_url','model_api_key','context_window','max_output_tokens')",
        )
        .all() as { key: string; value: string }[];
      const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
      const name = values.model?.trim() ?? "";
      const baseUrl = values.model_base_url?.trim() ?? "";
      if (!name || !baseUrl) return undefined;
      const positive = (value: string | undefined, fallbackValue: number) => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
      };
      const now = new Date().toISOString();
      const providerId = randomUUID();
      const modelId = randomUUID();
      this.db
        .prepare("INSERT INTO model_providers (id,name,base_url,api_key,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(providerId, providerName(baseUrl), baseUrl, values.model_api_key ?? "", now, now);
      this.db
        .prepare(
          `INSERT INTO provider_models (id,provider_id,name,context_window,max_output_tokens,active,created_at,updated_at)
           VALUES (?,?,?,?,?,1,?,?)`,
        )
        .run(
          modelId,
          providerId,
          name,
          positive(values.context_window, fallback.contextWindow),
          positive(values.max_output_tokens, fallback.maxOutputTokens),
          now,
          now,
        );
      // 迁移后清掉旧键：模型目录成为唯一来源，避免两处配置互相矛盾。
      this.db
        .prepare(
          "DELETE FROM runtime_settings WHERE key IN ('model','model_base_url','model_api_key','context_window','max_output_tokens')",
        )
        .run();
      this.insertAudit(actorId, "model_provider", providerId, "migrated", now);
      return this.getActiveModel();
    }, true);
  }

  /** 删除或停用模型后保证仍有一个使用中的模型；没有任何模型时保持为空。 */
  private promoteFirstProviderModel(): void {
    const active = this.db.prepare("SELECT id FROM provider_models WHERE active=1 LIMIT 1").get();
    if (active) return;
    this.db.prepare(
      "UPDATE provider_models SET active=1,updated_at=? WHERE id=(SELECT id FROM provider_models ORDER BY created_at,id LIMIT 1)",
    ).run(new Date().toISOString());
  }

  /** 旧版 `model_profiles` 表（供应商与模型混在一起）拆分为供应商与模型两张表。 */
  private migrateLegacyModelProfiles(): void {
    const tables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    if (!tables.has("model_profiles")) return;
    this.transaction(() => {
      const total = (this.db.prepare("SELECT COUNT(*) AS count FROM provider_models").get() as { count: number }).count;
      if (total === 0) {
        const rows = this.db.prepare("SELECT * FROM model_profiles ORDER BY created_at,id").all() as Record<string, unknown>[];
        const providers = new Map<string, { id: string; name: string; baseUrl: string; apiKey: string; createdAt: string; updatedAt: string }>();
        for (const row of rows) {
          const baseUrl = stringColumn(row, "base_url");
          const apiKey = stringColumn(row, "api_key");
          const key = `${baseUrl}\u0000${apiKey}`;
          let provider = providers.get(key);
          if (!provider) {
            provider = {
              id: randomUUID(),
              name: providerName(baseUrl),
              baseUrl,
              apiKey,
              createdAt: stringColumn(row, "created_at"),
              updatedAt: stringColumn(row, "updated_at"),
            };
            providers.set(key, provider);
            this.db
              .prepare("INSERT INTO model_providers (id,name,base_url,api_key,created_at,updated_at) VALUES (?,?,?,?,?,?)")
              .run(provider.id, provider.name, provider.baseUrl, provider.apiKey, provider.createdAt, provider.updatedAt);
          }
          this.db
            .prepare(
              `INSERT INTO provider_models (id,provider_id,name,context_window,max_output_tokens,active,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?)`,
            )
            .run(
              randomUUID(),
              provider.id,
              stringColumn(row, "name"),
              numberColumn(row, "context_window"),
              numberColumn(row, "max_output_tokens"),
              numberColumn(row, "active") === 1 ? 1 : 0,
              stringColumn(row, "created_at"),
              stringColumn(row, "updated_at"),
            );
        }
        this.promoteFirstProviderModel();
      }
      this.db.exec("DROP TABLE model_profiles");
    }, true);
  }

  private readModelProvider(row: Record<string, unknown>): ModelProvider {
    return {
      id: stringColumn(row, "id"),
      name: stringColumn(row, "name"),
      baseUrl: stringColumn(row, "base_url"),
      apiKey: stringColumn(row, "api_key"),
      ownerUserId: stringColumn(row, "owner_user_id"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  private readProviderModel(row: Record<string, unknown>): ProviderModel {
    return {
      id: stringColumn(row, "id"),
      providerId: stringColumn(row, "provider_id"),
      name: stringColumn(row, "name"),
      contextWindow: numberColumn(row, "context_window"),
      maxOutputTokens: numberColumn(row, "max_output_tokens"),
      active: numberColumn(row, "active") === 1,
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
    };
  }

  /** 仍有排队或运行中轮次的对话 ID，用于保护其常驻工作区不被清理。 */
  activeConversationIds(): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT conversation_id FROM conversation_turns WHERE status IN ('queued','running')")
      .all() as { conversation_id: string }[];
    return new Set(rows.map((row) => row.conversation_id));
  }

  retryFailedEvent(eventId: string): EventSummary {
    if (!eventId.trim()) throw new Error("event ID is required");
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM events WHERE id = ?")
        .get(eventId) as Record<string, unknown> | undefined;
      const event = readEventRow(row);
      if (!event) throw new Error(`event "${eventId}" not found`);
      if (event.status !== "failed") throw new Error(`event "${eventId}" is not failed`);
      if (event.failure_stage === "publishing") {
        throw new Error("publishing failures cannot be retried because the GitLab outcome may be uncertain");
      }
      if (!event.failure_stage) {
        throw new Error("event failure stage is unknown; refusing a potentially unsafe retry");
      }
      if (event.attempt_count >= maxAttempts) {
        throw new Error(`event "${eventId}" has used all ${maxAttempts} attempts`);
      }
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE events SET status='queued', failure_stage='', cancel_requested=0,
           lease_token='', lease_until=0, available_at=0, updated_at=? WHERE id=? AND status='failed'`,
        )
        .run(now, eventId);
      if (result.changes !== 1) throw new Error(`event "${eventId}" changed before it could be retried`);
      this.insertAudit(0, "operator_retry", eventId, "failed->queued", now);
      const updated = readEventRow(this.db.prepare("SELECT * FROM events WHERE id = ?").get(eventId));
      if (!updated) throw new Error(`retried event "${eventId}" disappeared`);
      const summary = mapEvent(updated);
      return {
        id: summary.id,
        type: summary.type,
        status: summary.status,
        projectId: summary.projectId,
        mrIid: summary.mrIid,
        targetType: summary.targetType,
        targetIid: summary.targetIid,
        targetBranch: summary.targetBranch,
        headSha: summary.headSha,
        actorId: summary.actorId,
        request: summary.request,
        createdAt: summary.createdAt,
        updatedAt: updated.updated_at,
        attemptCount: summary.attemptCount,
        lastError: summary.lastError,
        cancellationRequested: summary.cancellationRequested,
        failureStage: summary.failureStage,
      };
    });
  }

  private createQueuedTask(
    webhookEventId: string,
    key: string,
    event: Partial<Event> & Pick<Event, "projectId" | "mrIid" | "actorId" | "headSha">,
    type: "review" | "explain" | "chat",
  ): EventResult {
    // 将事件去重、事件创建和事件记录放进同一事务，避免 webhook 重投创建重复事件。
    return this.transaction(() => {
      const previous = this.webhookEventResult(webhookEventId);
      if (previous) {
        const existingEvent = this.db.prepare("SELECT id FROM events WHERE webhook_event_id=?").get(webhookEventId) as { id: string } | undefined;
        if (existingEvent) this.linkExecutionSteps(webhookEventId, existingEvent.id);
        return previous;
      }
      const existing = this.db
        .prepare("SELECT id FROM events WHERE idempotency_key = ?")
        .get(key) as { id: string } | undefined;
      const label = type === "review" ? "Review" : type === "explain" ? "Explain" : "Chat";
      let response: string;
      let resultEvent: EventResult["event"];
      let auditResult = "queued";
      if (existing) {
        resultEvent = { id: existing.id, created: false };
        response = `${label} task \`${existing.id}\` is already queued for this comment.`;
        auditResult = "authorized_duplicate";
      } else {
        const id = randomUUID();
        const created = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO events
             (id,idempotency_key,webhook_event_id,type,status,project_id,mr_iid,target_type,target_iid,head_sha,actor_id,request,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
           .run(id, key, webhookEventId, type, "queued", event.projectId, event.mrIid, "merge_request", event.mrIid, event.headSha, event.actorId, event.request ?? "", created, created);
        resultEvent = { id, created: true };
        response = `Queued ${label.toLowerCase()} task \`${id}\` for MR !${event.mrIid} at \`${event.headSha.slice(0, 12)}\`.`;
      }
      this.insertWebhookEvent(webhookEventId, response);
      if (resultEvent) this.linkExecutionSteps(webhookEventId, resultEvent.id);
      this.insertAudit(event.actorId, `request_${type}`, `${event.projectId}:${event.mrIid}`, auditResult);
      return { response, delivered: false, ...(resultEvent ? { event: resultEvent } : {}) };
    });
  }

  /**
   * 启动时回收上次进程留下的在途事件。
   *
   * 单进程部署下不存在其他租约持有者，因此可以立即回收，不必等待租约到期；
   * 这对「启动补跑」是必要的，否则要空转到 `lease_until` 才会重新入队。
   */
  recoverInterruptedEvents(): number {
    return this.transaction(() => this.recoverExpiredLeases(true));
  }

  private recoverExpiredLeases(recoverActiveLeases = false): number {
    const now = new Date();
    const condition = recoverActiveLeases
      ? "lease_token != ''"
      : "lease_token != '' AND lease_until > 0 AND lease_until <= ?";
    const rows = this.db
      .prepare(
        `SELECT id,status,attempt_count,cancel_requested,actor_id FROM events
         WHERE ${condition}
         AND status IN (${active.map(() => "?").join(",")})`,
      )
      .all(...(recoverActiveLeases ? active : [now.valueOf(), ...active])) as {
      id: string;
      status: EventStatus;
      attempt_count: number;
      cancel_requested: number;
      actor_id: number;
    }[];
    for (const row of rows) {
      // 发布阶段无法确认 GitLab 是否已收到评论，不能像其他阶段那样自动重试。
      let status: EventStatus = "queued";
      let error = "Event lease expired; task will be retried.";
      if (row.cancel_requested) {
        status = "cancelled";
        error = "Event lease expired after cancellation was requested; task was cancelled.";
      } else if (row.status === "publishing") {
        status = "failed";
        error = "Event lease expired during publishing; outcome is uncertain, so automatic retry was skipped to prevent duplicate GitLab comments.";
      } else if (row.attempt_count >= maxAttempts) {
        status = "failed";
        error = "Event lease expired and the maximum number of attempts was reached.";
      }
      this.db
        .prepare(
          "UPDATE events SET status=?,last_error=?,failure_stage=?,updated_at=?,lease_token='',lease_until=0 WHERE id=? AND status=?",
        )
        .run(status, error, status === "failed" ? row.status : "", now.toISOString(), row.id, row.status);
      this.db
        .prepare("UPDATE event_attempts SET finished_at=?,error=? WHERE event_id=? AND finished_at IS NULL")
        .run(now.toISOString(), error, row.id);
      const runningEvents = this.db
        .prepare("SELECT id,started_at FROM execution_steps WHERE event_id=? AND attempt=? AND status='running'")
        .all(row.id, row.attempt_count) as { id: number; started_at: string }[];
      for (const event of runningEvents) {
        const elapsed = Math.max(0, now.valueOf() - Date.parse(event.started_at));
        this.db
          .prepare(
            `UPDATE execution_steps SET status='interrupted',finished_at=?,duration_ms=?,error_detail=?
             WHERE id=? AND status='running'`,
          )
          .run(now.toISOString(), elapsed, error, event.id);
      }
      this.insertAudit(row.actor_id, "event_status", row.id, `${row.status}->${status}`, now.toISOString());
    }
    return rows.length;
  }

  private validTransition(from: EventStatus, to: EventStatus): boolean {
    const transitions: Partial<Record<EventStatus, EventStatus[]>> = {
      preparing: ["analyzing", "stale", "failed", "cancelled"],
      analyzing: ["fixing", "verifying", "publishing", "completed", "stale", "failed", "cancelled"],
      fixing: ["verifying", "stale", "failed", "cancelled"],
      verifying: ["publishing", "stale", "failed", "cancelled"],
      publishing: ["completed", "failed"],
    };
    return transitions[from]?.includes(to) ?? false;
  }

  private webhookEventResult(webhookEventId: string): EventResult | undefined {
    const row = this.db
      .prepare("SELECT response, delivered FROM webhook_deliveries WHERE webhook_event_id=?")
      .get(webhookEventId) as { response: string; delivered: number } | undefined;
    return row ? { response: row.response, delivered: row.delivered !== 0 } : undefined;
  }

  private insertWebhookEvent(webhookEventId: string, response: string): void {
    this.db
      .prepare("INSERT INTO webhook_deliveries(webhook_event_id,response,received_at) VALUES (?,?,?)")
      .run(webhookEventId, response, new Date().toISOString());
  }

  private insertAudit(actorId: number, action: string, resource: string, result: string, at?: string): void {
    this.db
      .prepare("INSERT INTO audit_events(actor_id,action,resource,result,created_at) VALUES (?,?,?,?,?)")
      .run(actorId, action, resource, result, at ?? new Date().toISOString());
  }

  private linkExecutionSteps(webhookEventId: string, eventId: string): void {
    this.db
      .prepare("UPDATE execution_steps SET event_id=? WHERE webhook_event_id=? AND event_id IS NULL")
      .run(eventId, webhookEventId);
  }

  private transaction<T>(callback: () => T, immediate = false): T {
    this.db.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "SQLite transaction failed and rollback also failed",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  private migrate(): void {
    this.migrateLegacyEventSchema();
    this.migrateLegacyConversationSchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, webhook_event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, status TEXT NOT NULL, project_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL,
        target_type TEXT NOT NULL DEFAULT 'merge_request', target_iid INTEGER NOT NULL DEFAULT 0,
        target_branch TEXT NOT NULL DEFAULT '', head_sha TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL, request TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, failure_stage TEXT NOT NULL DEFAULT '',
        available_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS events_mr_created_idx ON events(project_id,mr_iid,created_at DESC);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, gitlab_user_id INTEGER NOT NULL UNIQUE,
        username TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '',
        access_token TEXT NOT NULL DEFAULT '', refresh_token TEXT NOT NULL DEFAULT '',
        token_expires_at INTEGER NOT NULL DEFAULT 0, is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, project_name TEXT NOT NULL,
        target_branch TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'gitlab',
        owner_user_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '', summary_message_id TEXT NOT NULL DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT, user_message_id TEXT, role TEXT NOT NULL DEFAULT 'assistant',
        status TEXT NOT NULL, request TEXT NOT NULL DEFAULT '', head_sha TEXT NOT NULL DEFAULT '',
        actor_id INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '', process TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_turns_order_idx ON conversation_turns(conversation_id,created_at,id);
      CREATE INDEX IF NOT EXISTS conversation_turns_queue_idx ON conversation_turns(status,created_at,id);
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, turn_id TEXT,
        head_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_order_idx ON conversation_messages(conversation_id,created_at,id);
      CREATE TABLE IF NOT EXISTS storage_cleanup_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL, finished_at TEXT NOT NULL, source TEXT NOT NULL,
        applied INTEGER NOT NULL, older_than_days INTEGER NOT NULL,
        removed_workspaces INTEGER NOT NULL DEFAULT 0, removed_mirrors INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS storage_cleanup_log_order_idx ON storage_cleanup_log(started_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '', owner_user_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_model_selections (
        user_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
        name TEXT NOT NULL, context_window INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_models_provider_idx ON provider_models(provider_id,created_at,id);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        webhook_event_id TEXT PRIMARY KEY, response TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL, action TEXT NOT NULL,
        resource TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES events(id), attempt INTEGER NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, error TEXT NOT NULL DEFAULT '', UNIQUE(event_id,attempt)
      );
      CREATE TABLE IF NOT EXISTS event_trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES conversation_turns(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL, round INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, trace_input TEXT, trace_output TEXT, trace_schema TEXT,
        raw_content TEXT, error_detail TEXT, request_started_at TEXT, response_headers_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS execution_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT, webhook_event_id TEXT, event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES conversation_turns(id) ON DELETE CASCADE,
        attempt INTEGER, step TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        duration_ms INTEGER, input_json TEXT, output_json TEXT, error_detail TEXT
      );
      CREATE INDEX IF NOT EXISTS execution_steps_event_started_idx ON execution_steps(event_id,started_at,id);
      CREATE INDEX IF NOT EXISTS execution_steps_webhook_event_idx ON execution_steps(webhook_event_id,started_at,id);
      CREATE INDEX IF NOT EXISTS event_trace_event_started_idx ON event_trace(event_id,started_at,id);
      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        worker_id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS model_token_usage (
        day TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL DEFAULT 0, reserved_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS model_call_metrics (
        task_type TEXT NOT NULL, outcome TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_type,outcome)
      );
    `);
    // 旧版「模型列表」把供应商与模型混在一张表，升级时拆成供应商 + 模型。
    this.migrateLegacyModelProfiles();
    const webhookColumns = this.db.prepare("PRAGMA table_info(webhook_deliveries)").all() as { name: string }[];
    const existingWebhookColumns = new Set(webhookColumns.map((column) => column.name));
    const webhookAdditions: Record<string, string> = {
      delivery_token: "TEXT NOT NULL DEFAULT ''",
      delivery_until: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [name, definition] of Object.entries(webhookAdditions)) {
      if (!existingWebhookColumns.has(name)) this.db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN ${name} ${definition}`);
    }
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    const existing = new Set(columns.map((column) => column.name));
    const additions: Record<string, string> = {
      attempt_count: "INTEGER NOT NULL DEFAULT 0",
      last_error: "TEXT NOT NULL DEFAULT ''",
      request: "TEXT NOT NULL DEFAULT ''",
      lease_token: "TEXT NOT NULL DEFAULT ''",
      lease_until: "INTEGER NOT NULL DEFAULT 0",
      cancel_requested: "INTEGER NOT NULL DEFAULT 0",
      failure_stage: "TEXT NOT NULL DEFAULT ''",
      available_at: "INTEGER NOT NULL DEFAULT 0",
      target_type: "TEXT NOT NULL DEFAULT 'merge_request'",
      target_iid: "INTEGER NOT NULL DEFAULT 0",
      target_branch: "TEXT NOT NULL DEFAULT ''",
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec("UPDATE events SET target_iid=mr_iid WHERE target_iid=0 AND target_type='merge_request'");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_queue_available_idx ON events(status,available_at,created_at)");
    // 过期租约回收按 lease_until 过滤，仅对已持有租约的行建部分索引，避免全表扫描。
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS events_lease_until_idx ON events(lease_until) WHERE lease_token != ''",
    );
    const traceColumns = this.db.prepare("PRAGMA table_info(event_trace)").all() as { name: string }[];
    const existingTraceColumns = new Set(traceColumns.map((column) => column.name));
    const traceAdditions: Record<string, string> = {
      round: "INTEGER",
      trace_input: "TEXT",
      trace_output: "TEXT",
      trace_schema: "TEXT",
      raw_content: "TEXT",
      error_detail: "TEXT",
      first_token_ms: "INTEGER",
      generation_duration_ms: "INTEGER",
      request_started_at: "TEXT",
      response_headers_ms: "INTEGER",
      turn_id: "TEXT",
    };
    for (const [name, definition] of Object.entries(traceAdditions)) {
      if (!existingTraceColumns.has(name)) this.db.exec(`ALTER TABLE event_trace ADD COLUMN ${name} ${definition}`);
    }
    const stepColumns = new Set(
      (this.db.prepare("PRAGMA table_info(execution_steps)").all() as { name: string }[]).map((column) => column.name),
    );
    if (!stepColumns.has("turn_id")) this.db.exec("ALTER TABLE execution_steps ADD COLUMN turn_id TEXT");
    // 运行时设置记录修改者，便于回答「谁把窗口改小了」；旧库留空。
    const runtimeColumns = new Set(
      (this.db.prepare("PRAGMA table_info(runtime_settings)").all() as { name: string }[]).map((column) => column.name),
    );
    if (!runtimeColumns.has("updated_by")) {
      this.db.exec("ALTER TABLE runtime_settings ADD COLUMN updated_by TEXT NOT NULL DEFAULT ''");
    }
    const userColumns = new Set(
      (this.db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((column) => column.name),
    );
    if (!userColumns.has("is_admin")) this.db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    // 供应商可属于某个用户；空 owner 表示系统级，迁移时把已有供应商都归为系统级。
    const providerColumns = new Set(
      (this.db.prepare("PRAGMA table_info(model_providers)").all() as { name: string }[]).map((column) => column.name),
    );
    if (!providerColumns.has("owner_user_id")) {
      this.db.exec("ALTER TABLE model_providers ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''");
    }
    const adminCount = (this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE is_admin=1").get() as { count: number }).count;
    if (adminCount === 0) {
      const firstUser = this.db.prepare("SELECT id FROM users ORDER BY created_at,id LIMIT 1").get() as { id: string } | undefined;
      if (firstUser) this.db.prepare("UPDATE users SET is_admin=1 WHERE id=?").run(firstUser.id);
    }
    // 对话轮次落库完整过程（思考、中间回复、工具调用），旧库留空由界面回退到工具摘要。
    const turnColumns = new Set(
      (this.db.prepare("PRAGMA table_info(conversation_turns)").all() as { name: string }[]).map((column) => column.name),
    );
    if (!turnColumns.has("process")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN process TEXT NOT NULL DEFAULT ''");
    // 落库回复使用的模型名，供控制台在复制按钮旁展示；旧库补齐这一列。
    if (!turnColumns.has("model")) this.db.exec("ALTER TABLE conversation_turns ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    // 对话现在只绑定仓库分支，移除旧版本按 Issue/MR 区分目标时留下的列。
    const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    const legacyConversationColumns = new Set(conversationColumns.map((column) => column.name));
    for (const name of ["target_type", "target_iid", "target_title"]) {
      if (legacyConversationColumns.has(name)) this.db.exec(`ALTER TABLE conversations DROP COLUMN ${name}`);
    }
    // 旧版本误把 model 列加到了 conversations；模型名记录在 conversation_turns 上。
    if (legacyConversationColumns.has("model")) this.db.exec("ALTER TABLE conversations DROP COLUMN model");
    // 跨轮滚动摘要：记录被裁剪历史压缩出的摘要，以及摘要覆盖到的消息边界。
    for (const [name, definition] of Object.entries({
      summary: "TEXT NOT NULL DEFAULT ''",
      summary_message_id: "TEXT NOT NULL DEFAULT ''",
      // 对话模式：统一为可读可写，旧库补齐时直接落在 gitlab 模式。
      mode: "TEXT NOT NULL DEFAULT 'gitlab'",
      // 模型生成的标题：旧库留空，首次生成后写入。
      title: "TEXT NOT NULL DEFAULT ''",
      // 归档标记：旧库默认未归档。
      archived: "INTEGER NOT NULL DEFAULT 0",
      // 会话归属的 GitLab 用户；空值代表旧数据，迁移时会被清理。
      owner_user_id: "TEXT NOT NULL DEFAULT ''",
    })) {
      if (!legacyConversationColumns.has(name)) {
        this.db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${definition}`);
      }
    }
    // 用户级会话是全新的数据模型：旧会话没有归属用户，按约定整体丢弃一次。
    const ownerMigration = this.db
      .prepare("SELECT value FROM runtime_settings WHERE key='schema:user-owned-conversations'")
      .get() as { value: string } | undefined;
    if (!ownerMigration) {
      this.db.exec("DELETE FROM conversations");
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO runtime_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)")
        .run("schema:user-owned-conversations", now, now, "migration");
      // 旧的控制台 Basic 凭据不再使用。
      this.db.exec("DELETE FROM runtime_settings WHERE key IN ('operations_username','operations_password')");
    }
    // 对话不再区分只读/可写：把所有旧模式统一迁移到可读可写的 gitlab 模式。
    const modeMigration = this.db
      .prepare("SELECT value FROM runtime_settings WHERE key='schema:read-write-conversations'")
      .get() as { value: string } | undefined;
    if (!modeMigration) {
      this.db.exec("UPDATE conversations SET mode='gitlab' WHERE mode <> 'gitlab'");
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO runtime_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)")
        .run("schema:read-write-conversations", now, now, "migration");
    }
    this.db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(Date.now());
    // 早期模型可能把整段回答当作标题；按当前规则收敛已有的长标题。
    for (const row of this.db.prepare("SELECT id,title FROM conversations WHERE title != ''").all() as {
      id: string;
      title: string;
    }[]) {
      const language: ResponseLanguage = /[一-龥]/.test(row.title) ? "zh-CN" : "en";
      const normalized = normalizeConversationTitle(row.title, language);
      if (normalized !== row.title) {
        this.db.prepare("UPDATE conversations SET title=? WHERE id=?").run(normalized, row.id);
      }
    }
    this.backfillConversationTurns();
    this.finalizeConversationMigration();
    // turn_id 可能由上面的 ALTER 补齐，索引必须等列存在后再创建。
    this.db.exec("CREATE INDEX IF NOT EXISTS event_trace_turn_started_idx ON event_trace(turn_id,started_at,id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS execution_steps_turn_started_idx ON execution_steps(turn_id,started_at,id)");
  }

  /**
   * 把旧版 `jobs` / `job_attempts` / `job_trace` / `execution_events` / `webhook_events`
   * 重命名为事件（event）命名。SQLite 的 RENAME 会自动改写子表外键、索引与触发器，
   * 因此保留既有数据；重命名后再由 `migrate()` 的建表语句补齐新列。
   */
  private migrateLegacyEventSchema(): void {
    const tables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    if (tables.has("jobs") && !tables.has("events")) {
      this.db.exec("ALTER TABLE jobs RENAME TO events");
    }
    if (tables.has("job_attempts") && !tables.has("event_attempts")) {
      this.db.exec("ALTER TABLE job_attempts RENAME TO event_attempts");
      this.db.exec("ALTER TABLE event_attempts RENAME COLUMN job_id TO event_id");
    }
    if (tables.has("job_trace") && !tables.has("event_trace")) {
      this.db.exec("ALTER TABLE job_trace RENAME TO event_trace");
      this.db.exec("ALTER TABLE event_trace RENAME COLUMN job_id TO event_id");
    }
    if (tables.has("execution_events") && !tables.has("execution_steps")) {
      this.db.exec("ALTER TABLE execution_events RENAME TO execution_steps");
      // 旧表同时有 `event_id`（webhook 事件）与 `job_id`（任务）：先腾出列名再改名。
      const stepColumns = new Set(
        (this.db.prepare("PRAGMA table_info(execution_steps)").all() as { name: string }[]).map((c) => c.name),
      );
      if (stepColumns.has("event_id") && !stepColumns.has("webhook_event_id")) {
        this.db.exec("ALTER TABLE execution_steps RENAME COLUMN event_id TO webhook_event_id");
      }
      if (stepColumns.has("job_id")) {
        this.db.exec("ALTER TABLE execution_steps RENAME COLUMN job_id TO event_id");
      }
    }
    if (tables.has("webhook_events") && !tables.has("webhook_deliveries")) {
      this.db.exec("ALTER TABLE webhook_events RENAME TO webhook_deliveries");
      const deliveryColumns = new Set(
        (this.db.prepare("PRAGMA table_info(webhook_deliveries)").all() as { name: string }[]).map((c) => c.name),
      );
      if (deliveryColumns.has("event_id") && !deliveryColumns.has("webhook_event_id")) {
        this.db.exec("ALTER TABLE webhook_deliveries RENAME COLUMN event_id TO webhook_event_id");
      }
    }
    // 事件表的列重命名：旧库把 webhook 关联列叫 event_id，与新语义冲突。
    if (tables.has("events") || tables.has("jobs")) {
      const eventColumns = new Set(
        (this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((column) => column.name),
      );
      if (eventColumns.has("event_id") && !eventColumns.has("webhook_event_id")) {
        this.db.exec("ALTER TABLE events RENAME COLUMN event_id TO webhook_event_id");
      }
    }
    // 对话消息的轮次列：旧版存的是任务 ID 列 `job_id`。
    const messageTables = new Set(
      (this.db.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[]).map((c) => c.name),
    );
    if (messageTables.has("job_id") && !messageTables.has("turn_id")) {
      this.db.exec("ALTER TABLE conversation_messages RENAME COLUMN job_id TO turn_id");
    }
    // 模型调用统计：旧版把对话轮次记为 `session`，现统一为 `conversation`。
    if (tables.has("model_call_metrics")) {
      this.db.exec("UPDATE model_call_metrics SET task_type='conversation' WHERE task_type='session'");
    }
    // 事件类型：旧版把对话轮次记为 `session`，现统一为 `conversation`（随后会被清理）。
    // 表名可能刚由 `jobs` 改名而来，需重新查询表是否存在。
    const hasEvents = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .get() !== undefined;
    if (hasEvents) {
      const eventColumns = new Set(
        (this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((column) => column.name),
      );
      if (eventColumns.has("type")) this.db.exec("UPDATE events SET type='conversation' WHERE type='session'");
    }
  }

  /**
   * 把旧版 `chat_sessions` / `chat_session_messages` 表重命名为对话命名，并把
   * 对话消息的 `event_id` 改为轮次列 `turn_id`。SQLite 的 RENAME 会自动改写子表
   * 外键、索引和触发器，因此保留既有数据；重命名后再由 `migrate()` 建表语句补齐新列。
   */
  private migrateLegacyConversationSchema(): void {
    const tables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
        .map((row) => row.name),
    );
    if (tables.has("chat_session_messages")) {
      this.db.exec("ALTER TABLE chat_session_messages RENAME TO conversation_messages");
    }
    if (tables.has("chat_sessions")) this.db.exec("ALTER TABLE chat_sessions RENAME TO conversations");
    const messageColumns = new Set(
      (this.db.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[])
        .map((column) => column.name),
    );
    if (messageColumns.has("session_id") && !messageColumns.has("conversation_id")) {
      this.db.exec("ALTER TABLE conversation_messages RENAME COLUMN session_id TO conversation_id");
    }
    if (messageColumns.has("event_id") && !messageColumns.has("turn_id")) {
      this.db.exec("ALTER TABLE conversation_messages RENAME COLUMN event_id TO turn_id");
    }
  }

  /**
   * 为旧库补齐对话轮次：按既有助手消息生成一轮，并把助手消息的轮次列指向该轮次。
   * 轨迹与执行步骤的归属迁移放在 `finalizeConversationMigration()`，因为那时新列才齐全。
   */
  private backfillConversationTurns(): void {
    const messageColumns = new Set(
      (this.db.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[])
        .map((column) => column.name),
    );
    if (!messageColumns.has("turn_id")) return;
    // 旧库的 `turn_id` 存的是对话任务 ID，沿用为轮次主键，轨迹与消息才能继续关联。
    this.db.exec(`
      INSERT INTO conversation_turns
        (id,conversation_id,message_id,user_message_id,role,status,request,head_sha,actor_id,attempt_count,last_error,created_at,updated_at)
      SELECT COALESCE(NULLIF(m.turn_id,''), m.id), m.conversation_id, m.id, NULL, 'assistant',
        CASE m.status WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running'
             WHEN 'completed' THEN 'completed' ELSE 'failed' END,
        m.content, m.head_sha, 0, 0, '', m.created_at, m.updated_at
      FROM conversation_messages m
      WHERE m.role='assistant' AND NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.id=COALESCE(NULLIF(m.turn_id,''), m.id))
    `);
    this.db.exec(`
      UPDATE conversation_messages SET turn_id = (SELECT t.id FROM conversation_turns t WHERE t.message_id = conversation_messages.id)
      WHERE role='assistant' AND (turn_id IS NULL OR turn_id='' OR turn_id NOT IN (SELECT id FROM conversation_turns))
    `);
  }

  /**
   * 迁移对话轨迹与执行步骤的归属，并清理旧版存成 `events.type='conversation'` 的事件。
   * 必须在 `migrate()` 补全新列之后调用：旧库把对话任务的记录存在事件列里，且旧
   * `job_trace.event_id` 为 NOT NULL，需要按新结构重建表才能把归属改到轮次列。
   */
  private finalizeConversationMigration(): void {
    const turnIds = new Set(
      (this.db.prepare("SELECT id FROM conversation_turns").all() as { id: string }[]).map((row) => row.id),
    );
    if (turnIds.size > 0) {
      this.reassignTraceOwnership("event_trace", turnIds);
      this.reassignTraceOwnership("execution_steps", turnIds);
    }
    const eventColumns = new Set(
      (this.db.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((column) => column.name),
    );
    if (eventColumns.has("type")) this.db.exec("DELETE FROM events WHERE type='conversation'");
  }

  /** 把表中指向对话轮次的 `event_id` 归属改到 `turn_id`，必要时按新结构重建以解除 NOT NULL。 */
  private reassignTraceOwnership(table: "event_trace" | "execution_steps", turnIds: ReadonlySet<string>): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[];
    const names = columns.map((column) => column.name);
    if (!names.includes("event_id") || !names.includes("turn_id")) return;
    const eventIdNotNull = columns.find((column) => column.name === "event_id")?.notnull === 1;
    if (!eventIdNotNull) {
      this.db.exec(
        `UPDATE ${table} SET turn_id=event_id WHERE turn_id IS NULL AND event_id IN (SELECT id FROM conversation_turns)`,
      );
      this.db.exec(`UPDATE ${table} SET event_id=NULL WHERE event_id IN (SELECT id FROM conversation_turns)`);
      return;
    }
    // 旧 `job_trace` 的关联列是 NOT NULL，无法直接置空，按新结构重建表并保留外键级联。
    const placeholders = [...turnIds].map(() => "?").join(",");
    const isTurn = `event_id IN (${placeholders})`;
    const passthrough = names.filter((name) => name !== "event_id" && name !== "turn_id");
    const columnList = ["event_id", "turn_id", ...passthrough].join(",");
    this.db.exec(`CREATE TABLE ${table}_ownership (${ownershipDdl[table]})`);
    this.db
      .prepare(
        `INSERT INTO ${table}_ownership (${columnList})
         SELECT CASE WHEN ${isTurn} THEN NULL ELSE event_id END,
                CASE WHEN ${isTurn} THEN event_id ELSE turn_id END,
                ${passthrough.join(",")}
         FROM ${table}`,
      )
      .run(...[...turnIds, ...turnIds]);
    this.db.exec(`DROP TABLE ${table}`);
    this.db.exec(`ALTER TABLE ${table}_ownership RENAME TO ${table}`);
    // 重建不带索引，按新结构补回（`migrate()` 只在首次建表时创建）。
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${indexNames[table]} ON ${table}(event_id,started_at,id)`);
  }
}
