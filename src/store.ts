import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  backup as sqliteBackup,
  DatabaseSync,
} from "node:sqlite";
import type { AuthUser, GitLabIdentity, ManagedUser } from "./app/auth/model.js";
import type { TokenCipher } from "./tokens.js";
import type { ContextSnapshotData } from "./agent/context-inspect.js";
import { defaultSkillDocuments, ensureQuickActionMetadata, parseSkillDocument, validateSkillDocument, SKILL_SEED_VERSION } from "./agent/skills.js";
import {
  redactSensitiveText,
  sanitizeSensitiveText,
  sanitizeSensitiveValue,
} from "./redact.js";
import {
  defaultConversationMode,
  isConversationMode,
  isConversationTurnStatus,
  isModelTaskType,
  normalizeConversationTitle,
  type Conversation,
  type ConversationFollowUp,
  type ConversationMessage,
  type ConversationSkill,
  type SkillPack,
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
  type TraceEntry,
  type TraceKind,
  type TraceStatus,
  type ConversationTurnSegment,
  type StorageCleanupRecord,
  type ActiveModel,
  isThinkingLevel,
  type ThinkingLevel,
  type ResponseLanguage,
  type ModelProvider,
  type ModelProviderDetails,
  type ModelProviderInput,
  type UserModelSelection,
  type ProviderModel,
  type ProviderModelInput,
  type ConversationTurnTransition,
  type ConversationTurns,
  type ContextMetric,
  type ModelCallMetric,
  type ModelTaskType,
  type OperationsOverview,
  type StatusTransition,
  type TraceScope,
} from "./model.js";

/** 保留策略裁剪掉的会话摘要；调用方据此逐个触发会话删除 hook 与资源清理。 */
export interface PrunedConversation {
  conversationId: string;
  projectId: number;
  turnIds: string[];
}

/** 已结束的对话轮次状态；仅这些轮次的耗时才算已确定。 */
const terminalConversationTurn = new Set<ConversationTurnStatus>(["completed", "failed", "stale", "cancelled"]);
/** 单条持久化执行轨迹输入或输出允许保存的最大字节数。 */
const maxExecutionPayloadBytes = 64 << 10;
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

/** 轨迹归属的轮次 ID；校验为空或超长时抛错。 */
function traceScopeId(scope: TraceScope): string {
  const id = scope.turnId;
  if (!id.trim() || id.length > 256) throw new Error("trace scope ID is invalid");
  return id;
}

/**
 * 对话轮次从创建到最近更新的耗时（毫秒）。仅终态轮次的耗时已确定；
 * 时间缺失或倒序（时钟回拨）时返回 null，避免统计出现负值。
 */
function turnDurationMs(createdAt: string, updatedAt: string, isTerminal: boolean): number | null {
  if (!isTerminal) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/**
 * 上下文条目的字段结构是固定的：只对文本字段做脱敏，保留 tokens 数值。
 * 不能走 sanitizeSensitiveText 的字段名规则，否则 "tokens" 会被当成凭证字段替换成 [REDACTED]。
 * 体积按整条裁剪，保证落库后始终是合法 JSON。
 */
function serializeContextItems(items: ContextSnapshotData["items"]): string {
  const maxBytes = 128 * 1024;
  const clean = items.map((item) => ({
    category: item.category,
    name: redactSensitiveText(item.name).slice(0, 120),
    tokens: item.tokens,
    preview: redactSensitiveText(item.preview),
  }));
  while (clean.length > 0) {
    const json = JSON.stringify(clean);
    if (Buffer.byteLength(json) <= maxBytes) return json;
    // 条目按时间从旧到新排列；裁剪时丢掉最旧的，保留当前请求相关的最新内容。
    clean.shift();
  }
  return "[]";
}

function serializeTraceValue(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(sanitizeSensitiveValue(value));
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
 * 清洗调用方预先序列化好的轨迹文本：先按结构/文本脱敏，再做统一限长。
 * startTrace/finishTrace 的入参都是字符串，若不在这里兜底，敏感字段名的
 * 键值规则就完全失效（JSON 字符串里的 `"token":"..."` 不是裸 key=value）。
 */
function sanitizeTraceString(value: string | null): string | null {
  if (value === null) return null;
  const sanitized = sanitizeSensitiveText(value);
  if (Buffer.byteLength(sanitized) <= maxExecutionPayloadBytes) return sanitized;
  return serializeTraceValue(sanitized);
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
        name: redactSensitiveText(entry.name).slice(0, 512),
        input: entry.input ? redactSensitiveText(entry.input).slice(0, maxConversationProcessInputChars) : null,
      };
    }
    return { ...entry, text: redactSensitiveText(entry.text).slice(0, maxConversationProcessTextChars) };
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

function readTrace(row: Record<string, unknown>): TraceEntry {
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
    turnId: stringColumn(row, "turn_id"),
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
    turnId: stringColumn(row, "turn_id"),
    attempt: numberColumn(row, "attempt"),
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

export class AppStore {
  private readonly db: DatabaseSync;

  private constructor(private readonly path: string, db: DatabaseSync) {
    this.db = db;
  }

  static async open(path: string): Promise<AppStore> {
    if (!path) throw new Error("database path is required");
    if (path !== ":memory:") await mkdir(dirname(resolve(path)), { recursive: true });
    const db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    db.exec("PRAGMA journal_mode = WAL");
    const store = new AppStore(path, db);
    store.migrate();
    return store;
  }

  close(): void {
    this.db.close();
  }

  ping(): void {
    this.db.prepare("SELECT 1").get();
  }

  /** 运维总览：按对话轮次状态汇总当前活动。 */
  operationsOverview(): OperationsOverview {
    const counts: Record<ConversationTurnStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      stale: 0,
      cancelled: 0,
    };
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM conversation_turns GROUP BY status")
      .all() as { status: string; count: number }[];
    for (const row of rows) {
      if (!isConversationTurnStatus(row.status)) {
        throw new Error(`SQLite conversation turn status "${row.status}" is invalid`);
      }
      counts[row.status] = row.count;
    }
    const oldest = this.db
      .prepare("SELECT created_at FROM conversation_turns WHERE status='queued' ORDER BY created_at ASC LIMIT 1")
      .get() as { created_at: string } | undefined;
    const conversationCount = (this.db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count;
    return {
      counts,
      oldestQueuedAt: oldest?.created_at ?? null,
      conversationCount,
    };
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

  contextMetrics(): ContextMetric[] {
    return this.db
      .prepare("SELECT key, value FROM context_metrics ORDER BY key")
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        const key = String(record.key);
        const value = Number(record.value);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid context metric for "${key}"`);
        return { key: key as ContextMetric["key"], value };
      });
  }

  /** 累加上下文治理计数；字符数等指标可传大于 1 的增量。 */
  recordContextMetric(key: ContextMetric["key"], amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("context metric amount must be a non-negative integer");
    this.db
      .prepare(
        `INSERT INTO context_metrics (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      )
      .run(key, amount);
  }

  /**
   * 读取会话持久化的完整 Pi 会话条目（JSON 字符串）；不存在时返回 undefined。
   * 只返回原始文本，解析与大小校验由调用方负责。
   */
  conversationSessionEntries(conversationId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT entries FROM conversation_sessions WHERE conversation_id=?",
    ).get(conversationId) as { entries: string } | undefined;
    return row?.entries;
  }

  /**  upsert 会话的 Pi 会话条目。调用方负责脱敏与大小上限。 */
  saveConversationSessionEntries(conversationId: string, entries: string): void {
    if (!conversationId || !entries) return;
    this.db.prepare(
      `INSERT INTO conversation_sessions (conversation_id,entries,updated_at) VALUES (?,?,?)
       ON CONFLICT(conversation_id) DO UPDATE SET entries=excluded.entries, updated_at=excluded.updated_at`,
    ).run(conversationId, entries, new Date().toISOString());
  }

  /** 删除会话的持久化 Pi 会话条目；对话删除时由 ON DELETE CASCADE 兜底。 */
  deleteConversationSessionEntries(conversationId: string): void {
    this.db.prepare("DELETE FROM conversation_sessions WHERE conversation_id=?").run(conversationId);
  }

  /** 保存一次模型请求前的上下文快照；写入前走与轨迹相同的脱敏与限长路径。 */
  saveContextSnapshot(snapshot: ContextSnapshotData): void {
    if (!snapshot.conversationId || !snapshot.turnId) throw new Error("context snapshot requires conversation and turn");
    if (!Number.isSafeInteger(snapshot.requestSeq) || snapshot.requestSeq < 1) throw new Error("invalid context snapshot sequence");
    const breakdown = sanitizeTraceString(JSON.stringify(snapshot.breakdown))!;
    const counts = sanitizeTraceString(JSON.stringify(snapshot.counts))!;
    const items = serializeContextItems(snapshot.items);
    // requestSeq 在每次 Pi session 内从 1 重新计数；落库时改成会话内全局递增，
    // 避免不同轮次出现重复的 #1 并让 /context/:seq 的查询保持唯一。
    const seqRow = this.db.prepare(
      "SELECT COALESCE(MAX(request_seq), 0) + 1 AS seq FROM conversation_context_snapshots WHERE conversation_id=?",
    ).get(snapshot.conversationId) as { seq: number };
    this.db.prepare(
      `INSERT INTO conversation_context_snapshots
         (conversation_id,turn_id,request_seq,created_at,context_window,reserved_output,threshold,estimated_tokens,breakdown,counts,items,truncated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshot.conversationId, snapshot.turnId, seqRow.seq, snapshot.createdAt,
      snapshot.contextWindow, snapshot.reservedOutput, snapshot.threshold,
      snapshot.estimatedTokens, breakdown, counts, items, snapshot.truncated ? 1 : 0,
    );
    // 限制单会话快照数量：保留最近的记录，压缩边界点也随轮次保留。
    this.db.prepare(
      `DELETE FROM conversation_context_snapshots WHERE conversation_id=? AND id NOT IN
         (SELECT id FROM conversation_context_snapshots WHERE conversation_id=? ORDER BY id DESC LIMIT 300)`,
    ).run(snapshot.conversationId, snapshot.conversationId);
  }

  /** 按请求顺序返回会话的上下文快照（最新在前）。 */
  contextSnapshots(conversationId: string, limit = 300): ContextSnapshotData[] {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_context_snapshots WHERE conversation_id=? ORDER BY request_seq DESC,id DESC LIMIT ?",
    ).all(conversationId, Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map((row) => this.readContextSnapshot(row));
  }

  contextSnapshot(conversationId: string, requestSeq: number): ContextSnapshotData | undefined {
    const row = this.db.prepare(
      "SELECT * FROM conversation_context_snapshots WHERE conversation_id=? AND request_seq=? ORDER BY id DESC LIMIT 1",
    ).get(conversationId, requestSeq) as Record<string, unknown> | undefined;
    return row ? this.readContextSnapshot(row) : undefined;
  }

  private readContextSnapshot(row: Record<string, unknown>): ContextSnapshotData {
    const parseObject = (value: unknown): Record<string, unknown> => {
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
      if (typeof value !== "string") return {};
      try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    };
    // items 是数组，不能用「对象」解析器（那会把数组误判成空对象）。
    const parseItems = (value: unknown): ContextSnapshotData["items"] => {
      if (Array.isArray(value)) return value as ContextSnapshotData["items"];
      if (typeof value !== "string") return [];
      try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed as ContextSnapshotData["items"] : [];
      } catch {
        return [];
      }
    };
    return {
      conversationId: String(row.conversation_id),
      turnId: String(row.turn_id ?? ""),
      requestSeq: Number(row.request_seq),
      createdAt: String(row.created_at),
      contextWindow: Number(row.context_window),
      reservedOutput: Number(row.reserved_output),
      threshold: row.threshold === null || row.threshold === undefined ? null : Number(row.threshold),
      estimatedTokens: Number(row.estimated_tokens),
      breakdown: parseObject(row.breakdown) as ContextSnapshotData["breakdown"],
      counts: parseObject(row.counts) as ContextSnapshotData["counts"],
      items: parseItems(row.items),
      truncated: Number(row.truncated) === 1,
    };
  }

  startTrace(
    scope: TraceScope,
    attempt: number,
    kind: TraceKind,
    name: string,
    model = "",
    rawContent: string | null = null,
    details: { round?: number; input?: string | null; schema?: string | null } = {},
  ): number {
    const turnId = traceScopeId(scope);
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new Error("trace requires a positive attempt number");
    }
    if (kind !== "tool" && kind !== "llm" && kind !== "context") throw new Error(`unsupported trace kind "${kind}"`);
    if (
      !name.trim() ||
      name.length > 128 ||
      model.length > 256 ||
      (details.round !== undefined && (!Number.isSafeInteger(details.round) || details.round <= 0))
    ) {
      throw new Error("trace name or model is invalid");
    }
    const result = this.db
      .prepare(
        `INSERT INTO conversation_trace
         (turn_id,attempt,round,kind,name,status,started_at,model,trace_input,trace_schema,raw_content)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        turnId,
        attempt,
        details.round ?? null,
        kind,
        name,
        "running",
        new Date().toISOString(),
        model || null,
        sanitizeTraceString(details.input ?? null),
        sanitizeTraceString(details.schema ?? null),
        sanitizeTraceString(rawContent),
      );
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id)) throw new Error("SQLite returned an invalid trace ID");
    return id;
  }

  finishTrace(
    traceId: number,
    status: Exclude<TraceStatus, "running">,
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
        `UPDATE conversation_trace SET status=?, finished_at=?, duration_ms=?, input_tokens=?, output_tokens=?, error_detail=?,
         trace_output=?, first_token_ms=?, generation_duration_ms=?, request_started_at=?, response_headers_ms=?
         WHERE id=? AND status='running'`,
      )
      .run(
        status,
        new Date().toISOString(),
        Math.floor(durationMs),
        inputTokens ?? null,
        outputTokens ?? null,
        sanitizeTraceString(errorDetail ?? null),
        sanitizeTraceString(output ?? null),
        firstTokenMs === undefined ? null : Math.floor(firstTokenMs),
        generationDurationMs === undefined ? null : Math.floor(generationDurationMs),
        requestStartedAt ?? null,
        responseHeadersMs === undefined ? null : Math.floor(responseHeadersMs),
        traceId,
      );
    if (result.changes !== 1) throw new Error(`event trace "${traceId}" is not running`);
  }
  startExecutionStep(input: {
    turnId: string;
    attempt: number;
    step: string;
    input?: unknown;
  }): number {
    const { turnId, attempt } = input;
    if (
      !turnId.trim() || turnId.length > 256 ||
      !/^[a-z][a-z0-9_.-]{1,127}$/.test(input.step) ||
      !Number.isSafeInteger(attempt) || attempt <= 0
    ) {
      throw new Error("execution step identity or step is invalid");
    }
    const result = this.db
      .prepare(
        `INSERT INTO execution_steps (turn_id,attempt,step,status,started_at,input_json)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        turnId,
        attempt,
        input.step,
        "running",
        new Date().toISOString(),
        serializeTraceValue(input.input),
      );
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id)) throw new Error("SQLite returned an invalid execution step ID");
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
        errorDetail ? redactSensitiveText(errorDetail).slice(0, 8192) : null,
        id,
      );
    if (result.changes !== 1) throw new Error(`execution event "${id}" is not running`);
  }

  recordExecutionStep(input: {
    turnId: string;
    attempt: number;
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

  /**
   * 按保留策略裁剪历史，并返回被删掉的会话摘要。
   * 调用方据此逐个触发会话删除 hook，让插件与 Git 资源也能针对具体会话清理，
   * 而不是只靠事后的全局孤儿 ref sweep。
   */
  pruneHistory(historyBefore: Date, auditBefore: Date): PrunedConversation[] {
    if (Number.isNaN(historyBefore.valueOf()) || Number.isNaN(auditBefore.valueOf())) {
      throw new Error("history and audit retention cutoffs are required");
    }
    return this.transaction(() => {
      const history = historyBefore.toISOString();
      const audit = auditBefore.toISOString();
      // 保留仍有排队或运行中轮次的对话；先记下要删的会话及其轮次，再显式清理各表。
      const targets = (
        this.db
          .prepare(
            `SELECT c.id AS conversationId, c.project_id AS projectId,
                    COALESCE(GROUP_CONCAT(t.id), '') AS turnIds
             FROM conversations c
             LEFT JOIN conversation_turns t ON t.conversation_id = c.id
             WHERE c.updated_at < ?
               AND c.id NOT IN (
                 SELECT conversation_id FROM conversation_turns WHERE status IN ('queued','running')
               )
             GROUP BY c.id`,
          )
          .all(history) as { conversationId: string; projectId: number; turnIds: string }[]
      ).map((row) => ({
        conversationId: row.conversationId,
        projectId: row.projectId,
        turnIds: row.turnIds ? row.turnIds.split(",") : [],
      }));
      if (targets.length > 0) {
        const placeholders = targets.map(() => "?").join(",");
        const ids = targets.map((target) => target.conversationId);
        this.db
          .prepare(
            `DELETE FROM conversation_trace WHERE turn_id IN
             (SELECT id FROM conversation_turns WHERE conversation_id IN (${placeholders}))`,
          )
          .run(...ids);
        this.db
          .prepare(
            `DELETE FROM execution_steps WHERE turn_id IN
             (SELECT id FROM conversation_turns WHERE conversation_id IN (${placeholders}))`,
          )
          .run(...ids);
        this.db
          .prepare(`DELETE FROM conversation_context_snapshots WHERE conversation_id IN (${placeholders})`)
          .run(...ids);
        this.db
          .prepare(`DELETE FROM conversation_sessions WHERE conversation_id IN (${placeholders})`)
          .run(...ids);
        this.db
          .prepare(`DELETE FROM conversation_followups WHERE conversation_id IN (${placeholders})`)
          .run(...ids);
        this.db
          .prepare(`DELETE FROM conversation_messages WHERE conversation_id IN (${placeholders})`)
          .run(...ids);
        this.db
          .prepare(`DELETE FROM conversation_turns WHERE conversation_id IN (${placeholders})`)
          .run(...ids);
        this.db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...ids);
      }
      this.db
        .prepare("DELETE FROM model_token_usage WHERE day < ?")
        .run(historyBefore.toISOString().slice(0, 10));
      this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(audit);
      return targets;
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

  createConversation(input: CreateConversationInput): CreatedConversationTurn {
    this.validateConversationInput(input);
    const conversationId = randomUUID();
    const mode = input.mode ?? defaultConversationMode;
    const now = new Date().toISOString();
    return this.transaction(() => {
      this.db.prepare(
        `INSERT INTO conversations
         (id,project_id,project_name,target_branch,mode,base_sha,base_branch,owner_user_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        conversationId, input.projectId, input.projectName, input.targetBranch, mode,
        input.headSha, input.targetBranch, input.ownerUserId ?? "", now, now,
      );
      return this.enqueueConversationTurn(conversationId, input, now);
    });
  }

  /** 全部会话 ID，用于清理镜像里已无对应会话的改动 ref。 */
  listConversationIds(): string[] {
    return (this.db.prepare("SELECT id FROM conversations").all() as { id: string }[]).map((row) => row.id);
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
         (SELECT COALESCE(SUM(COALESCE(output_tokens, 0)), 0) FROM conversation_trace
          WHERE turn_id=conversation_messages.turn_id AND kind='llm' AND status='succeeded') AS generation_output_tokens,
         (SELECT COALESCE(SUM(COALESCE(generation_duration_ms, 0)), 0) FROM conversation_trace
          WHERE turn_id=conversation_messages.turn_id AND kind='llm' AND status='succeeded') AS generation_duration_ms,
         (SELECT COUNT(*) FROM conversation_trace WHERE turn_id=conversation_messages.turn_id) AS trace_count,
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
        `SELECT turn_id, name, status, trace_input, duration_ms FROM conversation_trace
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
      trajectory: this.readTrajectory({ turnId }),
      events: this.readExecutionSteps({ turnId }),
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
        .prepare(`SELECT * FROM conversation_trace WHERE turn_id IN (${placeholders}) ORDER BY started_at,id`)
        .all(...turnIds)
        .map((value) => readTrace(value as Record<string, unknown>)),
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
         COALESCE((SELECT SUM(CASE WHEN kind='llm' THEN 1 ELSE 0 END) FROM conversation_trace WHERE turn_id=conversation_turns.id), 0) AS model_calls,
         COALESCE((SELECT SUM(CASE WHEN kind='tool' THEN 1 ELSE 0 END) FROM conversation_trace WHERE turn_id=conversation_turns.id), 0) AS tool_calls,
         COALESCE((SELECT SUM(COALESCE(input_tokens, 0)) FROM conversation_trace WHERE turn_id=conversation_turns.id), 0) AS input_tokens,
         COALESCE((SELECT SUM(COALESCE(output_tokens, 0)) FROM conversation_trace WHERE turn_id=conversation_turns.id), 0) AS output_tokens
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

  /** 在运行中的轮次里追加一条用户补充消息；不创建新轮次，避免打断已固定的快照。 */
  appendUserMessage(conversationId: string, content: string): void {
    const request = content.trim();
    if (!request || request.length > 20_000) throw new Error("conversation message must be between 1 and 20000 characters");
    const exists = this.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(conversationId);
    if (!exists) throw new Error(`conversation "${conversationId}" not found`);
    this.transaction(() => {
      const active = this.db.prepare(
        "SELECT head_sha FROM conversation_turns WHERE conversation_id=? AND role='assistant' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      ).get(conversationId) as { head_sha: string } | undefined;
      if (!active) throw new Error("conversation has no active turn");
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO conversation_messages
           (id,conversation_id,role,content,status,turn_id,head_sha,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(randomUUID(), conversationId, "user", request, "completed", null, active.head_sha, now, now);
      this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
    });
  }

  /** 列出某对话排队等待下一轮执行的补充消息，按 position 顺序。 */
  listFollowUps(conversationId: string): ConversationFollowUp[] {
    const rows = this.db.prepare(
      "SELECT id,conversation_id,content,position,created_at FROM conversation_followups WHERE conversation_id=? ORDER BY position,rowid",
    ).all(conversationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      conversationId: String(row.conversation_id),
      content: String(row.content),
      position: Number(row.position),
      createdAt: String(row.created_at),
    }));
  }

  /** 追加一条排队消息；数量有上限，避免误操作攒出过长的执行队列。 */
  enqueueFollowUp(conversationId: string, content: string): ConversationFollowUp {
    const text = content.trim();
    if (!text || text.length > 20_000) throw new Error("conversation message must be between 1 and 20000 characters");
    const exists = this.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(conversationId);
    if (!exists) throw new Error(`conversation "${conversationId}" not found`);
    return this.transaction(() => {
      if (this.listFollowUps(conversationId).length >= 20) throw new Error("too many queued messages");
      const last = this.db.prepare(
        "SELECT position FROM conversation_followups WHERE conversation_id=? ORDER BY position DESC,rowid DESC LIMIT 1",
      ).get(conversationId) as { position: number } | undefined;
      const item: ConversationFollowUp = {
        id: randomUUID(),
        conversationId,
        content: text,
        position: (last?.position ?? -1) + 1,
        createdAt: new Date().toISOString(),
      };
      this.db.prepare(
        `INSERT INTO conversation_followups (id,conversation_id,content,position,created_at)
         VALUES (?,?,?,?,?)`,
      ).run(item.id, item.conversationId, item.content, item.position, item.createdAt);
      return item;
    });
  }

  /** 删除一条尚未执行的排队消息；只接受属于该对话的条目。 */
  removeFollowUp(conversationId: string, itemId: string): boolean {
    return this.db.prepare(
      "DELETE FROM conversation_followups WHERE conversation_id=? AND id=?",
    ).run(conversationId, itemId).changes > 0;
  }

  /** 与相邻条目交换位置，实现队列的上下移动。 */
  moveFollowUp(conversationId: string, itemId: string, direction: "up" | "down"): boolean {
    return this.transaction(() => {
      const items = this.listFollowUps(conversationId);
      const index = items.findIndex((item) => item.id === itemId);
      const other = direction === "up" ? index - 1 : index + 1;
      if (index < 0 || other < 0 || other >= items.length) return false;
      const current = items[index]!;
      const neighbor = items[other]!;
      const update = this.db.prepare("UPDATE conversation_followups SET position=? WHERE id=? AND conversation_id=?");
      update.run(neighbor.position, current.id, conversationId);
      update.run(current.position, neighbor.id, conversationId);
      return true;
    });
  }

  /** 原子取出队首并移除；执行方负责在失败时恢复。 */
  takeNextFollowUp(conversationId: string): ConversationFollowUp | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT id,conversation_id,content,position,created_at FROM conversation_followups WHERE conversation_id=? ORDER BY position,rowid LIMIT 1",
      ).get(conversationId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      this.db.prepare("DELETE FROM conversation_followups WHERE id=? AND conversation_id=?").run(String(row.id), conversationId);
      return {
        id: String(row.id),
        conversationId: String(row.conversation_id),
        content: String(row.content),
        position: Number(row.position),
        createdAt: String(row.created_at),
      };
    });
  }

  /** 把取出失败的消息放回队首。 */
  restoreFollowUp(conversationId: string, content: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE conversation_followups SET position=position+1 WHERE conversation_id=?").run(conversationId);
      this.db.prepare(
        `INSERT INTO conversation_followups (id,conversation_id,content,position,created_at)
         VALUES (?,?,?,?,?)`,
      ).run(randomUUID(), conversationId, content, 0, new Date().toISOString());
    });
  }

  /** 启动恢复用：找出仍有排队消息的对话。 */
  conversationsWithFollowUps(): string[] {
    return (this.db.prepare("SELECT DISTINCT conversation_id FROM conversation_followups").all() as { conversation_id: string }[])
      .map((row) => row.conversation_id);
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
        `SELECT id, role, content, turn_id FROM conversation_messages
         WHERE conversation_id=? AND status='completed' AND id <> ? AND id <> ?
         ORDER BY created_at,rowid`,
      ).all(turn.conversation_id, turn.message_id ?? "", turn.user_message_id ?? "") as { id: string; role: string; content: string; turn_id: string | null }[];
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
          .map((item) => ({
            id: item.id,
            role: item.role as "user" | "assistant",
            content: item.content,
            ...(item.turn_id ? { turnId: item.turn_id } : {}),
          })),
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
    // 摘要由模型从工具输出生成，可能原样带出凭证；写入前按文本规则脱敏。
    const trimmed = redactSensitiveText(summary).trim().slice(0, maxConversationSummaryCharacters);
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
   * 推进会话的同步基线。只在值变化时写入，且不改 updated_at（发布动作不应把对话排到列表最前）。
   * 调用方负责保证顺序：仅在成功 publish 到目标分支或新轮次确认远端快照后推进。
   */
  setConversationBaseSha(conversationId: string, sha: string, branch: string): void {
    if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(sha)) throw new Error("conversation base SHA is invalid");
    if (!branch.trim() || branch.length > 255) throw new Error("conversation base branch is invalid");
    this.db.prepare("UPDATE conversations SET base_sha=?,base_branch=? WHERE id=? AND (base_sha<>? OR base_branch<>?)")
      .run(sha, branch, conversationId, sha, branch);
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

  /** 删除一个对话及其轮次、消息、轨迹与上下文快照（显式删除，不依赖连接级外键开关）。 */
  deleteConversation(conversationId: string): boolean {
    return this.transaction(() => {
      const turnIds = (this.db.prepare("SELECT id FROM conversation_turns WHERE conversation_id=?")
        .all(conversationId) as { id: string }[]).map((row) => row.id);
      if (turnIds.length > 0) {
        const placeholders = turnIds.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM conversation_trace WHERE turn_id IN (${placeholders})`).run(...turnIds);
        this.db.prepare(`DELETE FROM execution_steps WHERE turn_id IN (${placeholders})`).run(...turnIds);
      }
      this.db.prepare("DELETE FROM conversation_messages WHERE conversation_id=?").run(conversationId);
      this.db.prepare("DELETE FROM conversation_followups WHERE conversation_id=?").run(conversationId);
      this.db.prepare("DELETE FROM conversation_context_snapshots WHERE conversation_id=?").run(conversationId);
      this.db.prepare("DELETE FROM conversation_sessions WHERE conversation_id=?").run(conversationId);
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
      baseSha: stringColumn(row, "base_sha"),
      baseBranch: stringColumn(row, "base_branch"),
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

  private readTrajectory(scope: TraceScope): TraceEntry[] {
    return this.db
      .prepare("SELECT * FROM conversation_trace WHERE turn_id=? ORDER BY started_at DESC,id DESC")
      .all(traceScopeId(scope))
      .map((value) => readTrace(value as Record<string, unknown>));
  }

  private readExecutionSteps(scope: TraceScope): ExecutionStep[] {
    return this.db
      .prepare("SELECT * FROM execution_steps WHERE turn_id=? ORDER BY started_at DESC,id DESC")
      .all(traceScopeId(scope))
      .map((value) => readExecutionStep(value as Record<string, unknown>));
  }

  /**
   * 读取指定轮次的工具调用证据，供新轮次注入「过去真实做过什么」。
   * 只读 kind='tool' 的少量字段并按时间升序，调用方再按有界上限格式化。
   */
  getToolEvidence(turnIds: readonly string[]): Array<{
    turnId: string;
    name: string;
    status: string;
    input: string | null;
    output: string | null;
    error: string | null;
  }> {
    const ids = [...new Set(turnIds.filter((id) => typeof id === "string" && id))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT turn_id, name, status, trace_input, trace_output, error_detail
       FROM conversation_trace
       WHERE kind='tool' AND turn_id IN (${placeholders})
       ORDER BY turn_id, started_at, id`,
    ).all(...ids) as Record<string, unknown>[];
    return rows.map((row) => ({
      turnId: stringColumn(row, "turn_id"),
      name: stringColumn(row, "name"),
      status: stringColumn(row, "status"),
      input: typeof row.trace_input === "string" ? row.trace_input : null,
      output: typeof row.trace_output === "string" ? row.trace_output : null,
      error: typeof row.error_detail === "string" ? row.error_detail : null,
    }));
  }

  getTraceEntries(scope: TraceScope, attempt: number): TraceEntry[] {
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new Error("trace query requires a positive attempt number");
    }
    return this.db
      .prepare("SELECT * FROM conversation_trace WHERE turn_id=? AND attempt=? ORDER BY started_at,id")
      .all(traceScopeId(scope), attempt)
      .map((value) => readTrace(value as Record<string, unknown>));
  }

  pendingProjectIds(): Set<number> {
    const rows = this.db
      .prepare("SELECT DISTINCT project_id FROM conversations")
      .all() as { project_id: number }[];
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

  /** 用户选择的思考等级；未选择时返回 undefined，由调用方回退到默认。 */
  getUserThinkingLevel(userId: string): ThinkingLevel | undefined {
    const row = this.db.prepare(
      "SELECT thinking_level FROM user_thinking_levels WHERE user_id=?",
    ).get(userId) as { thinking_level: string } | undefined;
    const value = row?.thinking_level;
    return isThinkingLevel(value) ? value : undefined;
  }

  /** 设置用户思考等级；非法取值返回 false。 */
  setUserThinkingLevel(userId: string, level: ThinkingLevel): boolean {
    if (!userId || !isThinkingLevel(level)) return false;
    this.db.prepare(
      `INSERT INTO user_thinking_levels (user_id,thinking_level,updated_at) VALUES (?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET thinking_level=excluded.thinking_level, updated_at=excluded.updated_at`,
    ).run(userId, level, new Date().toISOString());
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

  private insertAudit(actorId: number, action: string, resource: string, result: string, at?: string): void {
    this.db
      .prepare("INSERT INTO audit_events(actor_id,action,resource,result,created_at) VALUES (?,?,?,?,?)")
      .run(actorId, action, resource, result, at ?? new Date().toISOString());
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

  /** 旧库把对话轨迹存在 `event_trace`（或更早的 `job_trace`），迁移到独立的对话轨迹表。 */
  private migrateLegacyTraceTable(): void {
    const legacy = (this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('event_trace','job_trace') LIMIT 1")
      .get() as { name: string } | undefined)?.name;
    if (!legacy) return;
    const sourceColumns = new Set(
      (this.db.prepare(`PRAGMA table_info(${legacy})`).all() as { name: string }[]).map((column) => column.name),
    );
    const targetColumns = new Set(
      (this.db.prepare("PRAGMA table_info(conversation_trace)").all() as { name: string }[]).map((column) => column.name),
    );
    const shared = [...sourceColumns].filter((name) => targetColumns.has(name));
    if (shared.includes("turn_id")) {
      const names = shared.join(",");
      this.db.exec(
        `INSERT INTO conversation_trace (${names}) SELECT ${names} FROM ${legacy} WHERE turn_id IS NOT NULL`,
      );
    }
    this.db.exec(`DROP TABLE ${legacy}`);
  }

  private migrate(): void {
    this.migrateLegacyConversationSchema();
    this.db.exec(`
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
        -- 与远端同步到的基线：本地提交未发布时不变，publish 成功后前进。
        base_sha TEXT NOT NULL DEFAULT '',
        base_branch TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS conversation_followups (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        content TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_followups_order_idx ON conversation_followups(conversation_id,position);
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
      CREATE TABLE IF NOT EXISTS user_thinking_levels (
        user_id TEXT PRIMARY KEY, thinking_level TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
        name TEXT NOT NULL, context_window INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS provider_models_provider_idx ON provider_models(provider_id,created_at,id);
      CREATE TABLE IF NOT EXISTS runtime_settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER NOT NULL, action TEXT NOT NULL,
        resource TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT REFERENCES conversation_turns(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL, round INTEGER, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, trace_input TEXT, trace_output TEXT, trace_schema TEXT,
        raw_content TEXT, error_detail TEXT, request_started_at TEXT, response_headers_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS execution_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT REFERENCES conversation_turns(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL, step TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
        duration_ms INTEGER, input_json TEXT, output_json TEXT, error_detail TEXT
      );
      CREATE INDEX IF NOT EXISTS execution_steps_turn_started_idx ON execution_steps(turn_id,started_at,id);
      CREATE INDEX IF NOT EXISTS conversation_trace_turn_started_idx ON conversation_trace(turn_id,started_at,id);
      CREATE TABLE IF NOT EXISTS model_token_usage (
        day TEXT PRIMARY KEY, used_tokens INTEGER NOT NULL DEFAULT 0, reserved_tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS model_call_metrics (
        task_type TEXT NOT NULL, outcome TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(task_type,outcome)
      );
      CREATE TABLE IF NOT EXISTS context_metrics (
        key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS conversation_context_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES conversation_turns(id) ON DELETE CASCADE,
        request_seq INTEGER NOT NULL, created_at TEXT NOT NULL,
        context_window INTEGER NOT NULL, reserved_output INTEGER NOT NULL,
        threshold INTEGER, estimated_tokens INTEGER NOT NULL,
        breakdown TEXT NOT NULL, counts TEXT NOT NULL, items TEXT NOT NULL, truncated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_snapshots_conversation_idx ON conversation_context_snapshots(conversation_id,request_seq,id);
      -- 完整 Pi 会话条目（含 tool_use/tool_result），跨轮恢复真实会话而不是只注入文本历史。
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        entries TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_skills (
        id TEXT PRIMARY KEY,
        document TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        is_system INTEGER NOT NULL DEFAULT 0,
        pack_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_skills_name_idx ON conversation_skills(name);
      CREATE TABLE IF NOT EXISTS skill_packs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        archive BLOB NOT NULL,
        size INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        source_value TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    // 早期技能表按列存储；必须在写种子之前补 document 列并从旧列生成 SKILL.md。
    const skillColumns = new Set(
      (this.db.prepare("PRAGMA table_info(conversation_skills)").all() as { name: string }[]).map((column) => column.name),
    );
    if (!skillColumns.has("pack_id")) {
      this.db.exec("ALTER TABLE conversation_skills ADD COLUMN pack_id TEXT NOT NULL DEFAULT ''");
    }
    // 索引必须在列补齐后创建；旧库的建表语句不会因为 IF NOT EXISTS 自动补列。
    this.db.exec("CREATE INDEX IF NOT EXISTS conversation_skills_pack_idx ON conversation_skills(pack_id)");
    if (!skillColumns.has("document")) {
      this.db.exec("ALTER TABLE conversation_skills ADD COLUMN document TEXT NOT NULL DEFAULT ''");
      for (const row of this.db.prepare("SELECT * FROM conversation_skills").all() as Record<string, unknown>[]) {
        // 旧库可能带全套列，也可能只有简化后的列；只读取实际存在的列。
        const metadata = skillColumns.has("metadata") ? this.readSkillMetadata(row.metadata) : {};
        if (skillColumns.has("quick_action") && row.quick_action) metadata["corvex-quick-action"] = "true";
        if (skillColumns.has("quick_label") && row.quick_label) metadata["corvex-quick-label"] = String(row.quick_label);
        const metadataLines = Object.entries(metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`);
        const document = [
          "---",
          `name: ${JSON.stringify(String(row.name ?? ""))}`,
          `description: ${JSON.stringify(skillColumns.has("description") ? String(row.description ?? "") : "")}`,
          ...(metadataLines.length ? ["metadata:", ...metadataLines] : []),
          "---",
          "",
          skillColumns.has("content") ? String(row.content ?? "") : "",
          "",
        ].join("\n");
        this.db.prepare("UPDATE conversation_skills SET document=? WHERE id=?").run(document, String(row.id));
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS conversation_skills_name_idx ON conversation_skills(name)");
    // 升级前写入的种子文档可能缺少快捷操作标记；只补键，不改正文和其它字段。
    for (const row of this.db.prepare("SELECT id,document,is_system FROM conversation_skills").all() as {
      id: string; document: string; is_system: number;
    }[]) {
      if (row.is_system !== 1 || !row.document) continue;
      const enriched = ensureQuickActionMetadata(row.document);
      if (enriched !== row.document) {
        this.db.prepare("UPDATE conversation_skills SET document=? WHERE id=?").run(enriched, row.id);
      }
    }
    // 系统技能种子：只插入缺失项，管理员对文案/描述/启停的修改不会被升级覆盖。
    this.seedConversationSkills();
    // 旧版「模型列表」把供应商与模型混在一张表，升级时拆成供应商 + 模型。
    this.migrateLegacyModelProfiles();
    this.migrateLegacyTraceTable();
    const traceColumns = this.db.prepare("PRAGMA table_info(conversation_trace)").all() as { name: string }[];
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
      if (!existingTraceColumns.has(name)) this.db.exec(`ALTER TABLE conversation_trace ADD COLUMN ${name} ${definition}`);
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
      // 同步基线：旧库由下面的回填逻辑从最近一轮的 head_sha 补齐。
      base_sha: "TEXT NOT NULL DEFAULT ''",
      base_branch: "TEXT NOT NULL DEFAULT ''",
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
      // 该迁移早于上下文快照表；即使旧库里意外存在也一并清掉，避免孤儿行。
      this.db.exec("DELETE FROM conversation_context_snapshots");
      this.db.exec("DELETE FROM conversations");
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO runtime_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)")
        .run("schema:user-owned-conversations", now, now, "migration");
      // 旧的控制台 Basic 凭据不再使用。
      this.db.exec("DELETE FROM runtime_settings WHERE key IN ('operations_username','operations_password')");
    }
    // 旧版微压缩按消息下标去重，把每次请求的重复裁剪都累计进指标，需要清掉失真值重新计数。
    const microcompactMetricReset = this.db
      .prepare("SELECT value FROM runtime_settings WHERE key='schema:reset-microcompact-metrics'")
      .get() as { value: string } | undefined;
    if (!microcompactMetricReset) {
      this.db.exec("DELETE FROM context_metrics WHERE key IN ('microcompact','microcompact_chars')");
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO runtime_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)")
        .run("schema:reset-microcompact-metrics", now, now, "migration");
    }
    // 同步基线：旧库没有该列，按最近一轮的轮次快照回填；新建会话在首轮开始时补齐。
    const baseShaMigration = this.db
      .prepare("SELECT value FROM runtime_settings WHERE key='schema:conversation-base-sha'")
      .get() as { value: string } | undefined;
    if (!baseShaMigration) {
      this.db.exec(
        "UPDATE conversations SET base_sha = COALESCE((SELECT head_sha FROM conversation_turns WHERE conversation_id=conversations.id AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 1), '') WHERE base_sha='';" +
        "UPDATE conversations SET base_branch = target_branch WHERE base_branch=''",
      );
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO runtime_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)")
        .run("schema:conversation-base-sha", now, now, "migration");
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
    // GitLab 读/写 PAT 已移除：清掉数据库里可能残留的长期密钥。
    const gitlabTokenMigration = this.db
      .prepare("SELECT value FROM runtime_settings WHERE key='schema:no-shared-gitlab-tokens'")
      .get() as { value: string } | undefined;
    if (!gitlabTokenMigration) {
      this.db.exec("DELETE FROM runtime_settings WHERE key IN ('gitlab_read_token','gitlab_token')");
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO runtime_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?)")
        .run("schema:no-shared-gitlab-tokens", now, now, "migration");
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
    // turn_id 可能由上面的 ALTER 补齐，索引必须等列存在后再创建。
    this.db.exec("CREATE INDEX IF NOT EXISTS conversation_trace_turn_started_idx ON conversation_trace(turn_id,started_at,id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS execution_steps_turn_started_idx ON execution_steps(turn_id,started_at,id)");
  }

  /** 首次启动写入系统技能；INSERT OR IGNORE 保证管理员的修改不会被升级覆盖。 */
  private seedConversationSkills(): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO conversation_skills (id,document,name,enabled,is_system,created_at,updated_at)
       VALUES (?,?,?,1,1,?,?)`,
    );
    this.transaction(() => {
      for (const document of defaultSkillDocuments) {
        const parsed = parseSkillDocument(document);
        const row = this.db.prepare("SELECT id,document,is_system FROM conversation_skills WHERE name=?")
          .get(parsed.name) as { id: string; document: string; is_system: number } | undefined;
        if (!row) {
          insert.run(randomUUID(), document, parsed.name, now, now);
          continue;
        }
        // 系统种子升级：旧版本模板刷新为新内容，但保留管理员的停用选择。
        if (row.is_system !== 1 || row.document.includes(`corvex-seed-version: "${SKILL_SEED_VERSION}"`)) continue;
        const previous = parseSkillDocument(row.document);
        let next = document;
        if (!previous.enabled) next = next.replace('metadata:\n', 'metadata:\n  corvex-enabled: "false"\n');
        this.db.prepare("UPDATE conversation_skills SET document=?,enabled=?,updated_at=? WHERE id=?")
          .run(next, previous.enabled ? 1 : 0, now, row.id);
      }
    });
  }

  /** 全部技能，系统技能排在前面；enabledOnly 供运行时与补全菜单使用。 */
  listConversationSkills(enabledOnly = false): ConversationSkill[] {
    const rows = this.db.prepare(
      `SELECT * FROM conversation_skills ${enabledOnly ? "WHERE enabled=1" : ""} ORDER BY is_system DESC,name`,
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.readConversationSkill(row));
  }

  getConversationSkill(name: string): ConversationSkill | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_skills WHERE name=?").get(name) as Record<string, unknown> | undefined;
    return row ? this.readConversationSkill(row) : undefined;
  }

  createConversationSkill(document: string): ConversationSkill {
    const parsed = parseSkillDocument(document);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO conversation_skills (id,document,name,enabled,is_system,created_at,updated_at)
       VALUES (?,?,?,?,0,?,?)`,
    ).run(id, document.trim(), parsed.name, parsed.enabled ? 1 : 0, now, now);
    return this.getConversationSkillById(id)!;
  }

  updateConversationSkill(id: string, document: string): ConversationSkill | undefined {
    if (!this.db.prepare("SELECT 1 FROM conversation_skills WHERE id=?").get(id)) return undefined;
    const parsed = parseSkillDocument(document);
    this.db.prepare(
      "UPDATE conversation_skills SET document=?,name=?,enabled=?,updated_at=? WHERE id=?",
    ).run(document.trim(), parsed.name, parsed.enabled ? 1 : 0, new Date().toISOString(), id);
    return this.getConversationSkillById(id);
  }

  private getConversationSkillById(id: string): ConversationSkill | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_skills WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.readConversationSkill(row) : undefined;
  }

  /** 系统技能只能停用，不能删除；返回 false 表示不存在或受保护。 */
  deleteConversationSkill(id: string): boolean {
    const row = this.db.prepare("SELECT is_system FROM conversation_skills WHERE id=?").get(id) as { is_system: number } | undefined;
    if (!row || row.is_system === 1) return false;
    return this.db.prepare("DELETE FROM conversation_skills WHERE id=?").run(id).changes === 1;
  }

  /** 技能包列表只返回元数据，不把 ZIP 二进制带进接口。 */
  listSkillPacks(): SkillPack[] {
    const rows = this.db.prepare(
      `SELECT p.id, p.name, p.size, p.source, p.source_value, p.enabled, p.created_at, p.updated_at,
        (SELECT COUNT(*) FROM conversation_skills s WHERE s.pack_id=p.id) AS skill_count
       FROM skill_packs p ORDER BY p.created_at DESC`,
    ).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: stringColumn(row, "id"),
      name: stringColumn(row, "name"),
      size: numberColumn(row, "size"),
      source: stringColumn(row, "source"),
      sourceValue: stringColumn(row, "source_value"),
      enabled: numberColumn(row, "enabled") === 1,
      skillCount: numberColumn(row, "skill_count"),
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
    }));
  }

  /** 取回原始 ZIP，供重新解析或导出。 */
  getSkillPackArchive(id: string): Buffer | undefined {
    const row = this.db.prepare("SELECT archive FROM skill_packs WHERE id=?").get(id) as { archive: Buffer } | undefined;
    return row?.archive ? Buffer.from(row.archive) : undefined;
  }

  /**
   * 存下技能包并从包内 SKILL.md 派生技能行。重名技能按 overwrite 决定跳过或覆盖；
   * 返回派生结果，ZIP 始终是包的唯一来源。
   */
  createSkillPack(input: {
    name: string;
    archive: Buffer;
    source: string;
    sourceValue: string;
    documents: string[];
    overwrite: boolean;
  }): { pack: SkillPack; created: string[]; skipped: string[]; errors: string[] } {
    const id = randomUUID();
    const now = new Date().toISOString();
    const created: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO skill_packs (id,name,archive,size,source,source_value,enabled,created_at,updated_at)
         VALUES (?,?,?,?,?,?,1,?,?)`,
      ).run(id, input.name, input.archive, input.archive.byteLength, input.source, input.sourceValue, now, now);
      for (const document of input.documents) {
        try {
          const parsed = parseSkillDocument(document);
          const problems = validateSkillDocument(parsed);
          if (problems.length > 0) {
            errors.push(`${parsed.name || "unnamed"}: ${problems.join("; ")}`);
            continue;
          }
          const existing = this.db.prepare("SELECT id FROM conversation_skills WHERE name=?").get(parsed.name) as { id: string } | undefined;
          if (existing && !input.overwrite) {
            skipped.push(parsed.name);
            continue;
          }
          if (existing) {
            this.db.prepare("UPDATE conversation_skills SET document=?,enabled=?,pack_id=?,updated_at=? WHERE id=?")
              .run(document.trim(), parsed.enabled ? 1 : 0, id, now, existing.id);
          } else {
            this.db.prepare(
              `INSERT INTO conversation_skills (id,document,name,enabled,is_system,pack_id,created_at,updated_at)
               VALUES (?,?,?,?,0,?,?,?)`,
            ).run(randomUUID(), document.trim(), parsed.name, parsed.enabled ? 1 : 0, id, now, now);
          }
          created.push(parsed.name);
        } catch (cause) {
          errors.push(cause instanceof Error ? cause.message : "invalid SKILL.md");
        }
      }
    });
    return {
      pack: this.listSkillPacks().find((pack) => pack.id === id)!,
      created,
      skipped,
      errors,
    };
  }

  /** 删除技能包时一并删除它派生的技能，避免留下与包不一致的孤儿文档。 */
  deleteSkillPack(id: string): boolean {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM conversation_skills WHERE pack_id=?").run(id);
      return this.db.prepare("DELETE FROM skill_packs WHERE id=?").run(id).changes === 1;
    });
  }

  /** 停用技能包时同时停用其派生技能；重新启用时按各自 SKILL.md 的 enabled 恢复。 */
  setSkillPackEnabled(id: string, enabled: boolean): boolean {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE skill_packs SET enabled=?,updated_at=? WHERE id=?")
        .run(enabled ? 1 : 0, new Date().toISOString(), id);
      if (result.changes !== 1) return false;
      if (!enabled) {
        this.db.prepare("UPDATE conversation_skills SET enabled=0 WHERE pack_id=?").run(id);
      } else {
        this.db.prepare("UPDATE conversation_skills SET enabled=1 WHERE pack_id=?").run(id);
      }
      return true;
    });
  }

  /** 元数据是开放的 string→string 映射；损坏的 JSON 按空处理，不让一条脏数据挡住列表。 */
  private readSkillMetadata(value: unknown): Record<string, string> {
    const parse = (record: Record<string, unknown>): Record<string, string> =>
      Object.fromEntries(Object.entries(record).map(([key, item]) => [key, String(item)]));
    if (value && typeof value === "object" && !Array.isArray(value)) return parse(value as Record<string, unknown>);
    if (typeof value !== "string") return {};
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parse(parsed as Record<string, unknown>);
    } catch {
      // 忽略损坏的元数据。
    }
    return {};
  }

  private readConversationSkill(row: Record<string, unknown>): ConversationSkill {
    const document = stringColumn(row, "document");
    const parsed = parseSkillDocument(document);
    return {
      id: stringColumn(row, "id"),
      document,
      ...parsed,
      isSystem: numberColumn(row, "is_system") === 1,
      createdAt: stringColumn(row, "created_at"),
      updatedAt: stringColumn(row, "updated_at"),
      packId: typeof row.pack_id === "string" ? row.pack_id : "",
    };
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

}
