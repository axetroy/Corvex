/** 用于识别并脱敏凭证类字段名的匹配规则。 */
export const sensitiveField = /token|secret|password|api[_-]?key|authorization|cookie|credential/i;

/**
 * 脱敏宿主机绝对路径。虚拟协议 URI（worktree:// / upload:// / skill://）不含这些前缀，不受影响。
 * 用于轨迹、过程快照与命令输出等一切会二次进入模型上下文的文本。
 */
export function redactHostPaths(value: string): string {
  return value
    // Windows 盘符路径与 POSIX 常见宿主家目录/临时目录。
    .replace(/[A-Za-z]:[\\/](?![\\/])[^\s"'`,)\]}]+/g, "<path>")
    .replace(/(?:\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|\/root\/)[^\s"'`,)\]}]+/g, "<path>")
    // JSON.stringify 后斜杠可能被转义为 \\/。
    .replace(/(?:\\\/Users\\\/|\\\/home\\\/|\\\/private\\\/var\\\/)[^\s"'`,)\]}]+/g, "<path>");
}

/**
 * 对自由文本做凭证脱敏：Bearer、常见 token 前缀、key=value、JSON 字段、URL 查询参数与内嵌认证。
 * 只做保守匹配，宁可漏掉未知格式的密钥，也不破坏正常内容。
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b(?:glpat-|glrt-|gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}\b/gi, "[REDACTED]")
    .replace(/\b(token|secret|api[_-]?key|password|authorization|private[_-]?token|client[_-]?secret)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    // 调用方常把对象 JSON.stringify 成字符串，字段名后带引号，上面按裸名的规则匹配不到。
    .replace(/("(?:[^"]*(?:token|secret|api[_-]?key|password|authorization|cookie|credential)[^"]*)"\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}]+)/gi, "$1\"[REDACTED]\"")
    .replace(/([?&](?:access[_-]?token|token|key|secret|password|signature|auth)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
}

/** 凭证 + 宿主路径的统一脱敏入口：所有写入轨迹/过程/命令输出的文本都走它。 */
export function redactModelFacingText(value: string): string {
  return redactHostPaths(redactSensitiveText(value));
}

/** 深度优先清洗结构化数据：敏感字段名整值替换，其余字符串做文本脱敏。 */
export function sanitizeSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeSensitiveValue(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 500).map(([key, item]) => [
        key,
        sensitiveField.test(key) ? "[REDACTED]" : sanitizeSensitiveValue(item, depth + 1),
      ]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return String(value);
  return value;
}

/**
 * 清洗一段可能已被调用方 JSON.stringify 过的文本。
 * 能解析为 JSON 时按结构递归脱敏（字段名 + 文本），否则按自由文本脱敏。
 */
export function sanitizeSensitiveText(value: string): string {
  try {
    return JSON.stringify(sanitizeSensitiveValue(JSON.parse(value) as unknown));
  } catch {
    return redactSensitiveText(value);
  }
}
