import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../../errors.js";
import { redactSensitiveText } from "../../redact.js";
import type { ExecStream, ExecutionBackend, ExecutionResult } from "./types.js";

/** 一条命令的流式事件；execId 即工具调用 ID，逐段追加输出，done 带终态。 */
export interface ExecDelta {
  execId: string;
  stream: ExecStream;
  chunk: string;
  done?: boolean;
  exitCode?: number | null;
  aborted?: boolean;
  reason?: string;
  truncated?: boolean;
}

/** 命令字符串最大字符数。 */
const maxCommandCharacters = 4_096;
/** 审计/过程展示里保留的命令前缀长度，避免把敏感值写进轨迹。 */
const commandPreviewChars = 240;

export interface RunCommandToolOptions {
  backend: ExecutionBackend;
  cwd: string;
  /** 项目镜像裸库路径；沙箱只读挂载以便 linked worktree 的 gitdir 可解析。 */
  mirrorPath?: string;
  signal?: AbortSignal;
  /** 配置给出的超时/输出上限；工具参数只能进一步收紧，不能放宽。 */
  maxTimeoutMs: number;
  maxOutputBytes: number;
  /** 执行审计回调；由 Runner 传入以写入 audit_events。 */
  onExecuted?: (result: ExecutionResult) => void;
  /** 命令开始：把该命令的独立停止回调登记到 Runner，用于 UI 单命令停止。 */
  onExecStart?: (execId: string, stop: (reason: string) => void) => void;
  /** 命令结束：从 Runner 注销停止回调。 */
  onExecEnd?: (execId: string) => void;
  /** 命令输出增量与终态，供 SSE 终端实时展示。 */
  onExecDelta?: (delta: ExecDelta) => void;
}

/** 截断并脱敏命令，用于审计与展示。 */
export function previewCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  const redacted = redactSensitiveText(flat);
  return redacted.length > commandPreviewChars ? `${redacted.slice(0, commandPreviewChars)}…` : redacted;
}

/**
 * 注册 run_command：自由命令在受控后端执行，模型不接触 shell。
 * 只注册在显式启用 execution 的对话轮次里（由 pi.ts 按配置决定）。
 */
export function createExecutionExtension(options: RunCommandToolOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "run_command",
      label: "Run command",
      executionMode: "sequential",
      description:
        `Run a command inside this conversation's pinned worktree via the ${options.backend.kind} backend. ` +
        "Shell syntax (pipes, redirects, &&) is supported; execution is isolated by the configured backend. " +
        "Use it to run typechecks, linters, tests or git inspection. " +
        `The command is limited to ${maxCommandCharacters} characters, a ${options.maxTimeoutMs}ms timeout and ${options.maxOutputBytes} output bytes. ` +
        "Output is redacted and bounded; report only what the tool actually returned.",
      promptSnippet:
        `run_command: Run a bounded command in the pinned worktree (${options.backend.kind} backend).`,
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: maxCommandCharacters }),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: options.maxTimeoutMs })),
        maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: options.maxOutputBytes })),
      }),
      execute: async (toolCallId, params) => {
        // 每条命令用自己的 AbortController：停止单条命令不能 abort 整个 turn 的 signal。
        // 但与 turn signal 关联，整轮取消时命令同样被 kill。
        const controller = new AbortController();
        const commandSignal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal;
        options.onExecStart?.(toolCallId, (reason) => controller.abort(reason));
        const emit = (delta: ExecDelta) => {
          try { options.onExecDelta?.(delta); } catch (error) {
            console.warn("exec stream callback failed", { error: errorMessage(error) });
          }
        };
        let result: ExecutionResult;
        try {
          result = await options.backend.run(
            {
              command: params.command,
              cwd: options.cwd,
              ...(options.mirrorPath ? { mirrorPath: options.mirrorPath } : {}),
              timeoutMs: params.timeoutMs ?? options.maxTimeoutMs,
              maxOutputBytes: params.maxOutputBytes ?? options.maxOutputBytes,
            },
            commandSignal,
            (stream, text) => emit({ execId: toolCallId, stream, chunk: redactSensitiveText(text) }),
          );
        } finally {
          options.onExecEnd?.(toolCallId);
        }
        // 终态：chunk 为空，done=true；前端据此收起终端并把状态定为成功/失败/已停止。
        emit({
          execId: toolCallId,
          stream: "stdout",
          chunk: "",
          done: true,
          exitCode: result.exitCode,
          aborted: result.aborted,
          reason: result.reason,
          truncated: result.truncated,
        });
        options.onExecuted?.(result);
        const body = [
          `backend: ${result.backend}`,
          `command: ${previewCommand(result.command)}`,
          `exitCode: ${result.exitCode ?? "null"}${result.aborted ? ` (aborted${result.reason ? `: ${result.reason}` : ""})` : ""}`,
          `durationMs: ${result.durationMs}`,
          result.truncated ? "output: TRUNCATED" : "",
          "--- stdout ---",
          redactSensitiveText(result.stdout),
          "--- stderr ---",
          redactSensitiveText(result.stderr),
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text: body }],
          details: {},
        };
      },
    });
  };
}
