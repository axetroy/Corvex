import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/**
 * 单轮工具输出的确定性预算。
 *
 * Pi SDK 只在两次请求之间按 chars/4 估算上下文：真实的 provider 用量是准的，但
 * 「最后一条回复之后新增的工具结果」只能估算。中文、压缩代码和 JSON 转义会明显低估，
 * 于是一轮里几个大工具结果就可能在压缩检查之前把 128K 窗口顶爆。
 *
 * 这里在工具结果进入会话历史之前按 UTF-8 字节截断：每个助手消息（一次工具调用批次）
 * 的累计输出有硬上界，压缩预留再由该上界推导，从而保证「上次真实用量 + 本轮新增」
 * 始终落在窗口内。
 */

/** 单轮工具输出相对上下文窗口的字节比例；128K 窗口对应 32 KiB。 */
const roundBytesPerContextToken = 0.25;
const minRoundBytes = 4 << 10;
const maxRoundBytes = 128 << 10;
/** 单个工具结果的字节上限占单轮预算的比例。 */
const callShareOfRound = 0.5;
const minCallBytes = 4 << 10;
/** 工具结果按最坏 2 字节/token 估算（中文、压缩代码与 JSON 转义）。 */
const worstBytesPerToken = 2;
/** 压缩预留的固定余量：覆盖 system 提示、转向消息与分帧开销。 */
const reserveMarginTokens = 4 << 10;
/** 用户显式配置的预留最多占窗口的比例；防止旧的固定 16K 数值在小窗口里主导阈值。 */
const maxRequestedReserveShare = 0.25;
/** 压缩后至少保留的最近 token。 */
const minKeepRecentTokens = 4 << 10;
/**
 * 最近上下文同样只能估算，按最坏 2 倍低估收缩可保留量，避免压缩后立刻再次接近窗口。
 */
const worstEstimateFactor = 2;

/** 单轮内全部工具结果允许进入上下文的字节数。 */
export function resolveToolRoundBytes(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return minRoundBytes;
  const scaled = Math.floor(contextWindow * roundBytesPerContextToken);
  return Math.min(maxRoundBytes, Math.max(minRoundBytes, scaled));
}

/** 单个工具结果允许进入上下文的字节数；至少留出两次调用，避免一个大结果吃掉整轮预算。 */
export function resolveToolCallBytes(roundBytes: number): number {
  return Math.max(minCallBytes, Math.floor(roundBytes * callShareOfRound));
}

/**
 * 压缩预留 token：必须覆盖「完整一轮工具结果最坏增量 + 输出预留 + 固定余量」，
 * 否则这一轮工具结果追加后，下一次请求会在压缩前就超窗。工具结果预算本身随窗口
 * 按比例缩放（见 resolveToolRoundBytes），因此小窗口不会被固定的大预算顶到 50% 阈值。
 * 用户配置更大时保留用户值。
 */
export function resolveCompactionReserveTokens(
  contextWindow: number,
  maxOutputTokens: number,
  configured: number,
): number {
  const roundTokens = Math.ceil(resolveToolRoundBytes(contextWindow) / worstBytesPerToken);
  const output = Number.isFinite(maxOutputTokens) ? Math.max(0, maxOutputTokens) : 0;
  const safe = roundTokens + output + reserveMarginTokens;
  // 预留不能吃掉整个窗口：至少给压缩后的最近上下文和 system 提示留一点空间。
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : safe * 2;
  const ceiling = Math.max(1_024, window - minKeepRecentTokens - reserveMarginTokens);
  const requested = Number.isFinite(configured) ? Math.max(0, configured) : 0;
  const requestedCap = Math.floor(window * maxRequestedReserveShare);
  return Math.min(ceiling, Math.max(Math.min(requested, requestedCap), safe));
}

/** 压缩后保留的最近 token：窗口较小时不允许把窗口全部占满。 */
export function resolveCompactionKeepRecentTokens(
  contextWindow: number,
  configured: number,
  reserveTokens: number,
): number {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
  const reserve = Number.isFinite(reserveTokens) ? Math.max(0, reserveTokens) : 0;
  const ceiling = window > 0
    ? Math.max(minKeepRecentTokens, Math.floor((window - reserve - reserveMarginTokens) / worstEstimateFactor))
    : minKeepRecentTokens;
  const requested = Number.isFinite(configured) ? Math.max(0, configured) : 0;
  return Math.min(requested, ceiling);
}

/**
 * 单轮软检查点的字节阈值：达到后提示模型先记录进展，再改用更聚焦的读取。
 *
 * 它只是提醒，不截断也不中止本轮；为了在压缩发生前就提示到模型，上限收敛为
 * 四个「单轮工具预算」，配置更大时也不会等到窗口快满才提示。`0` 表示关闭提醒。
 */
export function resolveTurnToolResultBytes(contextWindow: number, configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  return Math.min(configured, resolveToolRoundBytes(contextWindow) * 4);
}

/** 按 UTF-8 字节截断，且不把多字节字符切成半个。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // 0b10xxxxxx 是 UTF-8 续字节；退到字符起始字节，避免出现替换字符。
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function truncationNote(toolName: string, limitBytes: number, roundExhausted: boolean): string {
  if (roundExhausted) {
    return `[Corvex blocked the rest of the "${toolName}" result: the tool-output budget for this round is used up. ` +
      "Continue with narrower requests (a specific path or line range, or a focused search) in the next round.]";
  }
  return `[Corvex truncated the "${toolName}" result to ${limitBytes} bytes so this request stays inside the model context window. ` +
    "Request the remaining part with a narrower path or line range instead of re-reading everything.]";
}

/**
 * 注册工具结果预算扩展：每个助手消息开启一轮新的工具预算；每条工具结果在进入会话
 * 历史前按「单次上限」和「本轮剩余额度」截断。截断只影响模型看到的内容，不影响审计
 * 轨迹的事件类型或工具本身的行为。
 */
export function createToolResultBudgetExtension(contextWindow: number): (pi: ExtensionAPI) => void {
  const roundLimit = resolveToolRoundBytes(contextWindow);
  const callLimit = resolveToolCallBytes(roundLimit);
  let roundRemaining = roundLimit;
  return (pi) => {
    pi.on("message_start", (event) => {
      if (event.message.role === "assistant") roundRemaining = roundLimit;
    });
    pi.on("tool_result", (event) => {
      const content = event.content ?? [];
      let callRemaining = callLimit;
      let changed = false;
      const next: (TextContent | ImageContent)[] = [];
      for (const part of content) {
        if (part.type !== "text") {
          next.push(part);
          continue;
        }
        const bytes = Buffer.byteLength(part.text, "utf8");
        const allowed = Math.min(callRemaining, roundRemaining);
        if (bytes <= allowed) {
          callRemaining -= bytes;
          roundRemaining -= bytes;
          next.push(part);
          continue;
        }
        const note = truncationNote(event.toolName, allowed, allowed <= 0);
        const noteBytes = Buffer.byteLength(`${note}\n\n`, "utf8");
        const prefix = allowed > noteBytes
          ? truncateUtf8(part.text, allowed - noteBytes)
          : "";
        const text = prefix ? `${note}\n\n${prefix}` : note;
        const used = Buffer.byteLength(text, "utf8");
        callRemaining = Math.max(0, callRemaining - used);
        roundRemaining = Math.max(0, roundRemaining - used);
        next.push({ ...part, text });
        changed = true;
      }
      return changed ? { content: next } : undefined;
    });
  };
}
