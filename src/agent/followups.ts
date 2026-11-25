import { redactSensitiveText } from "../redact.js";

/** 结构化下一步建议块标记；模型在回复末尾附带，服务端解析后从正文剥离。 */
const blockPattern = /<corvex_followups>([\s\S]*?)<\/corvex_followups>/g;

/** 解析结果：干净正文与有界建议列表。 */
export interface ParsedFollowups {
  content: string;
  suggestions: string[];
}

/**
 * 客服腔反问特征：模型常把建议写成「需要我…吗？」这类向用户提问/求许可的句子，
 * 它们不是可执行的下一步，展示出来会干扰用户。命中即丢弃（代码级硬过滤，
 * 提示词是软约束，模型未必遵守）。
 */
const serviceTonePatterns = [
  /需要我.*[吗么]/,
  /要不要/,
  /想(?:要)?我?.*[吗么]/,
  /帮你.*[吗么]/,
  /我帮你/,
  /是否.*[吗么]/,
  /请问/,
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bwant me to\b/i,
  /\bneed me to\b/i,
  /\bcan i\b/i,
  /\?$/,
  /？$/,
];

/** 校验并清洗单条建议：非空、限长、脱敏，去掉 markdown 列表符号，过滤客服腔反问。 */
function cleanSuggestion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = redactSensitiveText(raw.trim())
    .replace(/^[-*\d.\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0 || text.length > 200) return null;
  if (serviceTonePatterns.some((pattern) => pattern.test(text))) return null;
  return text;
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
