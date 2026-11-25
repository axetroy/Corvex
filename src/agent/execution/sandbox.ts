import { errorMessage } from "../../errors.js";
import type { ExecutionConfig } from "../../config/config.js";
import type { ExecutionBackend, ExecutionRequest, ExecutionResult } from "./types.js";

/**
 * 沙箱后端：通过容器运行时执行自由命令。
 *
 * P1 阶段只提供接口与 fail-closed 行为；真正的容器调用在 P2 实现（见 execution-design.md）。
 * 任何调用都会明确报错，绝不静默回退到本地后端。
 */
export class SandboxExecutionBackend implements ExecutionBackend {
  readonly kind = "sandbox" as const;

  constructor(private readonly config: ExecutionConfig["sandbox"]) {}

  async run(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    // P1 阶段不执行任何命令；引用参数避免类型检查器误认为遗漏。
    void request;
    void signal;
    throw new Error(
      `sandbox execution is not available yet (runtime=${this.config.runtime}, image=${this.config.image || "<unset>"}): ` +
      `${this.describeMissing()}. ${errorMessage(new Error("P2 pending"))}`,
    );
  }

  private describeMissing(): string {
    const missing: string[] = [];
    if (!this.config.image.trim()) missing.push("execution.sandbox.image");
    if (!this.config.socket.trim()) missing.push("execution.sandbox.socket");
    return missing.length > 0 ? `missing config: ${missing.join(", ")}` : "container backend not implemented";
  }
}
