/** 命令终端的纯显示数据与变换：不依赖 React / xterm，便于单测与回放复用。 */

/** 一条命令的可视状态：按 execId 聚合流式 chunk 与终态。 */
export interface ExecDisplay {
  execId: string;
  command: string;
  stdout: string;
  stderr: string;
  done: boolean;
  exitCode?: number | null;
  aborted?: boolean;
  reason?: string;
  truncated?: boolean;
  startedAt: number;
  finishedAt?: number;
}

/**
 * 把毫秒格式化为紧凑的耗时文本：未到 1 秒显示毫秒，之后用秒/分，便于运行中快速判读。
 * 负值与非法值统一回退为 0ms，避免回放数据（无时间戳）出现负耗时。
 */
export function formatExecDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1_000) return `${Math.floor(ms)}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function createExecDisplay(execId: string, command: string, now = Date.now()): ExecDisplay {
  return { execId, command, stdout: "", stderr: "", done: false, startedAt: now };
}

/** 把 exec 事件追加到显示状态；返回新的条目（不可变更新）。 */
export function applyExecDelta(entry: ExecDisplay, delta: {
  stream: "stdout" | "stderr";
  chunk: string;
  done?: boolean;
  exitCode?: number | null;
  aborted?: boolean;
  reason?: string;
  truncated?: boolean;
}, now = Date.now()): ExecDisplay {
  if (delta.done) {
    return {
      ...entry,
      done: true,
      exitCode: delta.exitCode,
      aborted: delta.aborted,
      reason: delta.reason,
      truncated: delta.truncated,
      finishedAt: now,
    };
  }
  return delta.stream === "stdout"
    ? { ...entry, stdout: entry.stdout + delta.chunk }
    : { ...entry, stderr: entry.stderr + delta.chunk };
}

/**
 * 从工具参数里取出命令原文（脱敏后的 JSON 文本），失败时回退到原文。
 * 与 ConversationsPage 的回放共用，避免两处各写一份解析。
 */
export function commandFromToolInput(input: string | null): string {
  if (!input) return "";
  try {
    const parsed = JSON.parse(input) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : input;
  } catch {
    return input;
  }
}

/** 从落库的过程快照还原终端（输出已随 collectProcess 落库）。 */
export function replayExecsFromProcess(process: ReadonlyArray<{
  kind: string;
  id?: string;
  name?: string;
  input?: string | null;
  execOutput?: {
    stdout: string;
    stderr: string;
    exitCode?: number | null;
    aborted?: boolean;
    reason?: string;
    truncated?: boolean;
  };
}>): Map<string, ExecDisplay> {
  const result = new Map<string, ExecDisplay>();
  for (const entry of process) {
    if (entry.kind !== "tool" || entry.name !== "run_command" || !entry.id || !entry.execOutput) continue;
    const output = entry.execOutput;
    result.set(entry.id, {
      execId: entry.id,
      command: commandFromToolInput(entry.input ?? null),
      stdout: output.stdout,
      stderr: output.stderr,
      done: true,
      exitCode: output.exitCode,
      aborted: output.aborted,
      reason: output.reason,
      truncated: output.truncated,
      startedAt: 0,
      finishedAt: 0,
    });
  }
  return result;
}
