import type { Copy, Locale } from "./i18n.js";
import { asTraceRecord, parseTraceValue } from "./trace.js";

/** 格式化时间戳；空值与无效日期使用界面文案占位。 */
export function formatDate(value: string | null | undefined, copy: Copy, locale: Locale): string {
  if (!value) return copy.none;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? copy.invalidDate : date.toLocaleString(locale);
}

/**
 * 把提交时间格式化为相对描述（如 `3 天前`）；无效或缺失返回占位文案。
 * 使用固定时长（而非自然月/年）以保证输出稳定、易于测试。
 */
export function formatRelativeTime(value: string | null | undefined, copy: Copy, now = Date.now()): string {
  if (!value) return copy.none;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return copy.invalidDate;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return copy.commitJustNow;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return copy.commitMinutesTemplate.replace("{value}", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return copy.commitHoursTemplate.replace("{value}", String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return copy.commitDaysTemplate.replace("{value}", String(days));
  const months = Math.floor(days / 30);
  if (months < 12) return copy.commitMonthsTemplate.replace("{value}", String(months));
  return copy.commitYearsTemplate.replace("{value}", String(Math.floor(months / 12)));
}

/** 把事件目标渲染为 `project:MR !iid` 或 `project:Issue #iid`。 */
export function formatEventTarget(
  event: { targetType: string; projectId: number; mrIid: number; targetIid: number },
  copy: Copy,
): string {
  const issue = event.targetType === "issue";
  return (issue ? copy.issueTargetTemplate : copy.mrTargetTemplate)
    .replace("{project}", String(event.projectId))
    .replace("{iid}", String(issue ? event.targetIid : event.mrIid));
}

/** 按秒、分、小时三档格式化持续时长。 */
export function formatDuration(seconds: number | null | undefined, copy: Copy): string {
  if (seconds === null || seconds === undefined) return copy.none;
  if (seconds < 60) return copy.durationSecondsTemplate.replace("{value}", String(seconds));
  if (seconds < 3600) {
    return copy.durationMinutesTemplate
      .replace("{minutes}", String(Math.floor(seconds / 60)))
      .replace("{seconds}", String(seconds % 60));
  }
  return copy.durationHoursTemplate
    .replace("{hours}", String(Math.floor(seconds / 3600)))
    .replace("{minutes}", String(Math.floor((seconds % 3600) / 60)));
}

/** 毫秒级耗时不足一秒时保留毫秒精度，否则复用秒级格式化。 */
export function formatTraceDuration(durationMs: number | null | undefined, copy: Copy): string {
  if (durationMs === null || durationMs === undefined) return copy.none;
  if (durationMs < 1000) {
    return copy.traceDurationMsTemplate.replace("{value}", String(Math.round(durationMs)));
  }
  return formatDuration(Math.floor(durationMs / 1000), copy);
}

/** 格式化输出速度，未记录时显示占位文案。 */
export function formatOutputTps(value: number | null, copy: Copy): string {
  return value === null ? copy.none : copy.traceTpsTemplate.replace("{value}", value.toFixed(1));
}

/** 轨迹字段保存的是 JSON 文本，展示时缩进；无法解析时原样返回。 */
export function formatTraceJson(value: string | null | undefined): string {
  const parsed = parseTraceValue(value);
  return parsed === undefined ? value ?? "" : JSON.stringify(parsed, null, 2);
}

/** 拼接消息内容中的文本片段，非文本片段按 JSON 展示。 */
export function formatSessionContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asTraceRecord(part);
      if (record?.type === "text" && typeof record.text === "string") return record.text;
      return JSON.stringify(part, null, 2);
    })
    .filter(Boolean)
    .join("\n\n");
}

/** 把工具调用参数还原为可读的一行描述，未知工具回退为通用模板。 */
export function describeSessionTool(
  name: string,
  input: unknown,
  outputValue: string | null,
  copy: Copy,
): string {
  const record = asTraceRecord(input);
  const path = typeof record?.path === "string" && record.path ? record.path : copy.traceUnknownPath;
  switch (name) {
    case "read_file": {
      const startLine = record?.startLine;
      const maxLines = record?.maxLines;
      let start = typeof startLine === "number" && Number.isSafeInteger(startLine) && startLine > 0 ? startLine : 1;
      let end = start + (typeof maxLines === "number" && Number.isSafeInteger(maxLines) && maxLines > 0 ? maxLines : 200) - 1;
      const output = asTraceRecord(parseTraceValue(outputValue));
      const content = Array.isArray(output?.content) ? output.content : [];
      const outputText = content.map(asTraceRecord).find((part) => part?.type === "text")?.text;
      const actualRange = typeof outputText === "string" ? /^\[Lines (\d+)-(\d+)/.exec(outputText) : null;
      if (actualRange) {
        start = Number(actualRange[1]);
        end = Number(actualRange[2]);
      }
      return copy.traceToolReadFileRangeTemplate
        .replace("{path}", path)
        .replace("{start}", String(start))
        .replace("{end}", String(end));
    }
    case "read_dir":
      return copy.traceToolReadDirectoryTemplate.replace("{path}", path);
    case "stat":
      return copy.traceToolInspectPathTemplate.replace("{path}", path);
    case "search_text":
    case "git_grep": {
      const query = typeof record?.query === "string" && record.query ? record.query : copy.traceUnknownQuery;
      return copy.traceToolSearchTemplate
        .replace("{query}", query)
        .replace("{path}", path);
    }
    case "git_diff":
      return copy.traceToolGitDiffTemplate.replace("{path}", path);
    case "git_log": {
      const limit = typeof record?.limit === "number" && Number.isSafeInteger(record.limit) ? record.limit : 10;
      return copy.traceToolGitLogTemplate
        .replace("{count}", String(limit))
        .replace("{path}", path);
    }
    case "git_show": {
      const sha = typeof record?.sha === "string" && record.sha ? record.sha.slice(0, 12) : copy.traceUnknownPath;
      return copy.traceToolGitShowTemplate.replace("{sha}", sha);
    }
    case "web_fetch":
      return copy.traceToolFetchWebTemplate.replace(
        "{url}",
        typeof record?.url === "string" && record.url ? record.url : copy.traceUnknownPath,
      );
    default:
      return copy.traceToolGenericTemplate.replace("{name}", (name || copy.traceName).replaceAll(/[_-]+/g, " "));
  }
}

/** 解析模型回复，拆出文本与本次请求的工具调用摘要。 */
export function readAssistantOutput(value: string | null, copy: Copy): { text: string; toolCalls: string[] } {
  const parsed = asTraceRecord(parseTraceValue(value));
  const content = parsed && Array.isArray(parsed.content) ? parsed.content : undefined;
  if (!content) return { text: formatTraceJson(value), toolCalls: [] };
  const parts = content.map(asTraceRecord);
  const text = parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => String(part?.text))
    .join("\n\n");
  const reply = asTraceRecord(parseTraceValue(text));
  return {
    text: reply?.action === "reply" && typeof reply.reply === "string" ? reply.reply : text,
    toolCalls: parts
      .filter((part) => part?.type === "toolCall")
      .map((part) => describeSessionTool(String(part?.name ?? ""), part?.arguments, null, copy)),
  };
}

/** 格式化工具结果：文本数组按段落拼接，其余按 JSON 缩进展示。 */
export function formatSessionPayload(value: string | null): string {
  const parsed = parseTraceValue(value);
  if (parsed === undefined) return value ?? "";
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed)) return formatSessionContent(parsed);
  const record = asTraceRecord(parsed);
  if (record && Array.isArray(record.content)) return formatSessionContent(record.content);
  return JSON.stringify(parsed, null, 2);
}

/** 执行事件的输入输出按 JSON 展示，非 JSON 文本原样返回。 */
export function formatExecutionPayload(value: string | null | undefined): string {
  const parsed = parseTraceValue(value);
  if (parsed === undefined) return value ?? "";
  return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
}
