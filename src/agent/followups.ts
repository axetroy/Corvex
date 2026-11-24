import { redactSensitiveText } from "../redact.js";

/** 结构化下一步建议块标记；模型在回复末尾附带，服务端解析后从正文剥离。 */
const blockPattern = /<corvex_followups>([\s\S]*?)<\/corvex_followups>/g;

/** 解析结果：干净正文与有界建议列表。 */
export interface ParsedFollowups {
  content: string;
  suggestions: string[];
}

/** 校验并清洗单条建议：非空、限长、脱敏，去掉 markdown 列表符号。 */
function cleanSuggestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = redactSensitiveText(raw.trim())
    .replace(/^[-*\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 && text.length <= 200 ? text : null;
}

/**
 * 从模型回复中剥离 `<corvex_followups>` 块并返回建议。
 * 块内既接受 JSON 字符串数组，也接受每行一条的纯文本；解析失败时原样保留正文，
 * 避免模型偶发格式错误影响回答本身。
 */
export function parseFollowups(content: string, limit: number): ParsedFollowups {
  const matches = [...content.matchAll(blockPattern)];
  if (matches.length === 0) return { content, suggestions: [] };

  const suggestions: string[] = [];
  for (const match of matches) {
    const body = match[1].trim();
    let candidates: unknown[] | null = null;
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed)) candidates = parsed;
    } catch {
      // 不是 JSON 则按行解析。
    }
    if (!candidates) candidates = body.split(/\r?\n/);
    for (const candidate of candidates) {
      const clean = cleanSuggestion(candidate);
      if (clean && !suggestions.includes(clean)) suggestions.push(clean);
      if (suggestions.length >= limit) break;
    }
    if (suggestions.length >= limit) break;
  }

  const stripped = content.replace(blockPattern, "").replace(/\n{3,}/g, "\n\n").trim();
  return { content: stripped, suggestions: suggestions.slice(0, limit) };
}
