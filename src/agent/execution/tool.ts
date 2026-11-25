import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactSensitiveText } from "../../redact.js";
import type { ExecutionBackend, ExecutionResult } from "./types.js";

/** 命令字符串最大字符数。 */
const maxCommandCharacters = 4_096;
/** 审计/过程展示里保留的命令前缀长度，避免把敏感值写进轨迹。 */
const commandPreviewChars = 240;

export interface RunCommandToolOptions {
  backend: ExecutionBackend;
  cwd: string;
  signal?: AbortSignal;
  /** 配置给出的超时/输出上限；工具参数只能进一步收紧，不能放宽。 */
  maxTimeoutMs: number;
  maxOutputBytes: number;
  /** 执行审计回调；由 Runner 传入以写入 audit_events。 */
  onExecuted?: (result: ExecutionResult) => void;
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
      execute: async (_toolCallId, params) => {
        const result = await options.backend.run(
          {
            command: params.command,
            cwd: options.cwd,
            timeoutMs: params.timeoutMs ?? options.maxTimeoutMs,
            maxOutputBytes: params.maxOutputBytes ?? options.maxOutputBytes,
          },
          options.signal,
        );
        options.onExecuted?.(result);
        const body = [
          `backend: ${result.backend}`,
          `command: ${previewCommand(result.command)}`,
          `exitCode: ${result.exitCode ?? "null"}${result.aborted ? " (aborted)" : ""}`,
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
