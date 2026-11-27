/**
 * 有界会话持久化：超限时不再整体放弃，而是保留「压缩检查点 + 最近连续消息链」，
 * 让下一轮仍能恢复真实工具结果，而不是退回旧会话或只靠文本历史。
 *
 * 只处理结构化条目，不修改内容本身：丢弃整条入链前缀即可保证 parentId 链在保留段内连续。
 */

/**
 * 递归剥离会话条目里的图片内容块：图片只在发起它的那一轮有效，
 * 不能随完整会话跨轮恢复，更不能把 Base64 持久化到 SQLite。
 */
export function stripImageContent(entries: readonly SessionEntryLike[]): SessionEntryLike[] {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
        return { type: "text", text: "[image omitted]" };
      }
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  return entries.map((entry): SessionEntryLike => walk(entry) as SessionEntryLike);
}

export interface SessionEntryLike {
  id: string;
  parentId?: string | null;
  type: string;
  [key: string]: unknown;
}

export interface BoundedSession {
  entries: SessionEntryLike[];
  truncated: boolean;
  dropped: number;
}

/** 最后一条压缩记录以前的消息都已被摘要覆盖，可以安全丢弃。 */
function lastCompactionIndex(branch: readonly SessionEntryLike[]): number {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]!.type === "compaction") return index;
  }
  return -1;
}

function bytes(entries: readonly SessionEntryLike[]): number {
  return Buffer.byteLength(JSON.stringify(entries));
}

/**
 * 把会话压进字节上限。优先丢掉压缩点以前的旧消息；仍超限时从保留段头部逐条丢弃，
 * 但始终保留压缩条目（若存在）与最新的消息链尾部。
 */
export function boundSessionEntries(
  header: SessionEntryLike,
  branch: readonly SessionEntryLike[],
  maxBytes: number,
): BoundedSession {
  const original = branch.length;
  const compaction = lastCompactionIndex(branch);
  const kept = compaction >= 0 ? [...branch.slice(compaction)] : [...branch];
  const within = () => bytes([header, ...kept]) <= maxBytes;

  while (!within() && kept.length > 1) {
    // 压缩条目承载旧上下文摘要，优先保留；没有压缩点时直接从头丢。
    const firstDroppable = kept[0]?.type === "compaction" ? 1 : 0;
    if (kept.length <= firstDroppable + 1) break;
    kept.splice(firstDroppable, 1);
  }

  const entries = [header, ...kept];
  // 极端情况：单个条目就超限，只能放弃持久化，由调用方记日志。
  return {
    entries: bytes(entries) <= maxBytes ? entries : [],
    truncated: kept.length < original,
    dropped: original - kept.length,
  };
}
