/** 执行环境的请求与结果类型；自由命令在 Corvex 代码里受控执行，模型不接触执行环境本身。 */

export interface ExecutionRequest {
  /** 自由命令字符串；由后端在受控环境中执行（沙箱是安全边界）。 */
  command: string;
  /** 工作目录：会话的 pinned worktree。 */
  cwd: string;
  /**
   * worktree 所属的项目镜像裸库路径（可选）。linked worktree 的 `.git` 文件指向它，
   * 沙箱按原路径只读挂载，容器内的 git 才能解析 gitdir，否则 `git status` 报
   * `fatal: not a git repository: (null)`。
   */
  mirrorPath?: string;
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
  /** 终止原因：用户手动停止时为 USER_STOPPED_REASON，超时为 timeout。 */
  reason?: string;
}

/** 用户手动停止命令时写入 signal.reason 与工具结果，供后续模型据此决定下一步。 */
export const USER_STOPPED_REASON = "user manually stopped this command";

/** 命令输出的增量流类型。 */
export type ExecStream = "stdout" | "stderr";
/** 后端把脱敏后的输出增量推给上层，用于终端实时展示。 */
export type ExecChunkCallback = (stream: ExecStream, text: string) => void;

export interface ExecutionBackend {
  readonly kind: "local" | "sandbox";
  run(request: ExecutionRequest, signal?: AbortSignal, onChunk?: ExecChunkCallback): Promise<ExecutionResult>;
}
