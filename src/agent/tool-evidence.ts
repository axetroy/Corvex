/**
 * 把过去轮次真实执行过的工具调用与结果，压缩成有界的「操作证据」文本。
 *
 * 对话历史只带文本，模型无法从「我以前说过」判断「我确实做过」。
 * 这段证据来自 conversation_trace，是关于过去操作的权威记录，注入请求后
 * 模型才能核实「我发过链接吗 / 评论发在哪」这类问题而不凭空编造。
 */

/** 结果正文里只提取 text 片段，避免把 JSON 包装结构也塞进提示词。 */
export function resultText(raw: string | null, limit: number): string {
  if (!raw) return "";
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const content = (parsed as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const parts = content.flatMap((part) => {
          if (!part || typeof part !== "object") return [];
          const item = part as Record<string, unknown>;
          return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
        });
        if (parts.length > 0) text = parts.join("\n");
      }
    }
  } catch {
    // 非 JSON 的工具输出直接按原文处理。
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export interface ToolEvidenceEntry {
  turnId: string;
  name: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
}

const evidenceLimits = {
  maxTurns: 10,
  maxToolsPerTurn: 12,
  fieldChars: 240,
  totalChars: 12_000,
} as const;

/**
 * 把工具轨迹格式化成「轮次 → 工具 → 结果」的紧凑文本；超过任一上限即截断，
 * 并明确告知这是有界记录，避免模型把省略当成「没做过」。
 */
export function buildToolEvidence(
  entries: readonly ToolEvidenceEntry[],
  limits: Partial<typeof evidenceLimits> = {},
): string {
  const { maxTurns, maxToolsPerTurn, fieldChars, totalChars } = { ...evidenceLimits, ...limits };
  const byTurn = new Map<string, ToolEvidenceEntry[]>();
  for (const entry of entries) {
    const list = byTurn.get(entry.turnId) ?? [];
    list.push(entry);
    byTurn.set(entry.turnId, list);
  }
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  // 按 turnId 在 entries 中首次出现的顺序（调用方按时间升序传入）取最近 maxTurns 轮。
  const order: string[] = [];
  for (const entry of entries) if (!order.includes(entry.turnId)) order.push(entry.turnId);
  outer: for (const turnId of order.slice(-maxTurns)) {
    const tools = byTurn.get(turnId) ?? [];
    if (tools.length > maxToolsPerTurn) truncated = true;
    const header = `- turn ${turnId.slice(0, 8)}:`;
    if (used + header.length + 1 > totalChars) {
      truncated = true;
      break;
    }
    lines.push(header);
    used += header.length + 1;
    for (const tool of tools.slice(0, maxToolsPerTurn)) {
      const parts: string[] = [];
      const input = resultText(tool.input, fieldChars);
      if (input) parts.push(`args=${input}`);
      const result = tool.status === "failed" ? resultText(tool.error, fieldChars) : resultText(tool.output, fieldChars);
      parts.push(`${tool.status}${result ? ` ${result}` : ""}`);
      const line = `  - ${tool.name}: ${parts.join(" | ")}`;
      if (used + line.length + 1 > totalChars) {
        truncated = true;
        break outer;
      }
      lines.push(line);
      used += line.length + 1;
    }
  }
  if (entries.length === 0) lines.push("(none — no tool calls are recorded for the history turns)");
  if (truncated) lines.push(`(truncated: showing at most ${maxTurns} turns and ${maxToolsPerTurn} tools per turn)`);
  return lines.join("\n");
}
