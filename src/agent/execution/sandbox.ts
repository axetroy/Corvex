import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ExecutionConfig } from "../../config/config.js";
import { errorMessage } from "../../errors.js";
import type { ExecChunkCallback, ExecutionBackend, ExecutionRequest, ExecutionResult } from "./types.js";

/**
 * 沙箱后端：通过容器运行时（docker / podman）执行自由命令。
 *
 * 安全边界来自容器：网络命名空间与宿主隔离（默认 bridge 允许外网以安装依赖）、
 * 非 root、丢能力、只读 rootfs、只挂 worktree、资源限额。
 * 容器不可用时明确报错，绝不静默回退到本地后端（fail-closed）。
 *
 * 注意：`--mount type=bind` 让容器只能看到 worktree 这一个宿主目录；`df` 等命令在
 * 该挂载点上显示的是底层文件系统的容量（Linux bind mount 的 statvfs 语义），
 * 这不等于容器能读取宿主其它路径。除此之外不注入任何宿主路径或凭据。
 */

/** 容器内 worktree 的挂载点。 */
const workspaceMount = "/workspace";
/** 容器内临时目录与缓存根目录：全部落在 tmpfs，不写宿主 worktree。 */
const cacheMount = "/tmp/corvex-cache";

export function buildContainerArgs(
  config: ExecutionConfig["sandbox"],
  request: ExecutionRequest,
  containerName: string,
): string[] {
  const args: string[] = [
    "run",
    "--rm",
    "--name", containerName,
    "--network", config.network,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--read-only",
    // tmpfs 大小必须与 maxOutputBytes 解耦：后者是输出捕获上限（默认 256 KiB），
    // 不能当作临时文件系统容量，否则 npm/yarn/pip 的缓存写不进去，必然 ENOSPC。
    "--tmpfs", `/tmp:rw,size=${config.tmpfsSizeMb}m`,
    "--memory", config.memory,
    "--cpus", String(config.cpus),
    "--pids-limit", String(config.pidsLimit),
    "--mount", `type=bind,source=${request.cwd},target=${workspaceMount}`,
    "--workdir", workspaceMount,
    "--env", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    // HOME 与各类缓存变量都指向容器内的 tmpfs：既不污染宿主 worktree，也不把宿主路径暴露给命令。
    "--env", "HOME=/tmp",
    "--env", "TMPDIR=/tmp",
    "--env", `XDG_CACHE_HOME=${cacheMount}/xdg`,
    "--env", `npm_config_cache=${cacheMount}/npm`,
    "--env", `YARN_CACHE_FOLDER=${cacheMount}/yarn`,
    "--env", `PIP_CACHE_DIR=${cacheMount}/pip`,
    "--env", "CI=1",
    "--env", "NODE_ENV=production",
  ];
  for (const mount of config.readOnlyMounts) {
    args.push("--mount", `type=bind,source=${mount},target=${mount},readonly`);
  }
  args.push(config.image, "/bin/sh", "-c", request.command);
  return args;
}

/** docker CLI 的主机地址；socket 路径来自配置，避免依赖宿主默认。 */
function runtimeEnv(socket: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (socket.trim()) env.DOCKER_HOST = `unix://${socket.replace(/^unix:\/\//, "")}`;
  return env;
}

export class SandboxExecutionBackend implements ExecutionBackend {
  readonly kind = "sandbox" as const;

  constructor(private readonly config: ExecutionConfig["sandbox"]) {}

  async run(request: ExecutionRequest, signal?: AbortSignal, onChunk?: ExecChunkCallback): Promise<ExecutionResult> {
    const containerName = `corvex-exec-${randomUUID()}`;
    const args = buildContainerArgs(this.config, request, containerName);
    const startedAt = Date.now();
    return new Promise<ExecutionResult>((resolve) => {
      const child = spawn(this.config.runtime, args, {
        env: runtimeEnv(this.config.socket),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      let abortReason: string | undefined;
      const append = (which: "stdout" | "stderr", chunk: Buffer) => {
        const budget = request.maxOutputBytes - Buffer.byteLength(stdout) - Buffer.byteLength(stderr);
        if (budget <= 0) {
          truncated = true;
          return;
        }
        const piece = chunk.subarray(0, budget);
        if (piece.length < chunk.length) truncated = true;
        const text = piece.toString("utf8");
        if (which === "stdout") stdout += text;
        else stderr += text;
        if (text) onChunk?.(which, text);
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));

      const cleanup = () => {
        // 容器可能因超时/取消仍在运行；强制删除，避免残留。
        void spawn(this.config.runtime, ["rm", "--force", containerName], {
          env: runtimeEnv(this.config.socket),
          stdio: "ignore",
          shell: false,
        });
      };
      const timer = setTimeout(() => {
        abortReason = "timeout";
        kill(child);
        cleanup();
      }, request.timeoutMs);
      const onSignal = () => {
        abortReason = typeof signal?.reason === "string" && signal.reason ? signal.reason : "cancelled";
        kill(child);
        cleanup();
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
          ...(abortReason ? { reason: abortReason } : {}),
        });
      };
      child.on("error", (error) => finish(null, error));
      child.on("close", (code) => finish(abortReason ? null : code));
    });
  }
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
