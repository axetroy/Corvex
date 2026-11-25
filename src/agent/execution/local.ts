import { spawn, type ChildProcess } from "node:child_process";
import { errorMessage } from "../../errors.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "./types.js";

/** 本地后端：在 worktree 里执行自由命令，env 白名单，超时与输出上限。仅限开发，不是安全边界。 */
export class LocalExecutionBackend implements ExecutionBackend {
  readonly kind = "local" as const;

  async run(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const env = sanitizeEnv();
    return new Promise<ExecutionResult>((resolve) => {
      const child = spawn(request.command, {
        cwd: request.cwd,
        env,
        // 自由命令由 shell 解释（支持管道/重定向）；安全性由沙箱后端提供，本地后端仅限开发。
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        // 独立进程组，便于超时/取消时整组 kill。
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      const append = (which: "stdout" | "stderr", chunk: Buffer) => {
        const budget = request.maxOutputBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
        if (budget <= 0) {
          truncated = true;
          return;
        }
        const piece = chunk.subarray(0, budget);
        if (piece.length < chunk.length) truncated = true;
        if (which === "stdout") stdout += piece.toString("utf8");
        else stderr += piece.toString("utf8");
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      let abortReason: "timeout" | "cancel" | undefined;
      const timer = setTimeout(() => {
        abortReason = "timeout";
        kill(child);
      }, request.timeoutMs);
      const onSignal = () => {
        abortReason = "cancel";
        kill(child);
      };
      signal?.addEventListener("abort", onSignal, { once: true });
      const finish = (exitCode: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onSignal);
        if (error && !abortReason) stderr += `\n[execution error: ${errorMessage(error)}]`;
        resolve({
          command: request.command,
          backend: this.kind,
          exitCode,
          stdout,
          stderr,
          truncated,
          durationMs: Date.now() - startedAt,
          aborted: abortReason !== undefined,
        });
      };
      child.on("error", (error) => finish(null, error));
      child.on("close", (code) => finish(abortReason ? null : code));
    });
  }
}

/** env 白名单：剥离凭据/代理/Git 注入类变量，只保留命令运行所需的最小集合。 */
function sanitizeEnv(): NodeJS.ProcessEnv {
  const allow = new Set([
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ",
    "CI", "NODE_ENV", "NODE_PATH", "USER", "LOGNAME", "SHELL", "TERM",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = process.env.TMPDIR ?? "/tmp";
  return env;
}

/** Node 在非 Windows 的 detached 子进程需用负 PID kill 整组。 */
function kill(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // 进程可能已退出。
  }
}
