/** 执行环境的请求与结果类型；自由命令在 Corvex 代码里受控执行，模型不接触执行环境本身。 */

export interface ExecutionRequest {
  /** 自由命令字符串；由后端在受控环境中执行（沙箱是安全边界）。 */
  command: string;
  /** 工作目录：会话的 pinned worktree。 */
  cwd: string;
  /** 超时（毫秒），调用方已按配置上限裁剪。 */
  timeoutMs: number;
  /** 输出上限（字节），调用方已按配置上限裁剪。 */
  maxOutputBytes: number;
}

export interface ExecutionResult {
  command: string;
  backend: "local" | "sandbox";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  /** 被取消或超时时为 true。 */
  aborted: boolean;
}

export interface ExecutionBackend {
  readonly kind: "local" | "sandbox";
  run(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
}
