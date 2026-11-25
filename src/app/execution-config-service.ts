import { validateConfig, type CorvexConfig, type ExecutionConfig } from "../config/config.js";
import type { AppStore } from "../store.js";
import { errorMessage } from "../errors.js";

/**
 * 执行环境配置服务：管理员 UI 保存到 SQLite，启动时与保存后应用到内存配置。
 *
 * 执行配置是安全边界，保存前必须走完整 validateConfig（含 fail-closed）；
 * 不进通用 runtime_settings，也不接受普通用户修改（路由层 requireAdmin）。
 */

export interface ExecutionConfigPayload {
  config: ExecutionConfig;
  source: "database" | "file";
  updatedAt?: string;
  updatedBy?: string;
  /** 保存后是否需重启才生效（后端在每轮重建，实际立即生效）。 */
  effectiveImmediately: true;
}

export class ExecutionConfigService {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store: AppStore,
    /** 启动时的配置快照（含 YAML 初始值），用作校验基准与回退。 */
    private readonly baseline: CorvexConfig,
    private readonly onApplied?: (config: CorvexConfig) => void,
  ) {}

  /** 启动时应用数据库中的覆盖项；无覆盖时保留 YAML 初始值。 */
  applyStored(): void {
    const stored = this.store.getExecutionConfig();
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored.value) as unknown;
      const candidate = structuredClone(this.baseline);
      candidate.execution = this.normalize(parsed);
      validateConfig(candidate, "server");
      this.config.execution = candidate.execution;
      this.onApplied?.(this.config);
      console.info("applied stored execution config", { updatedBy: stored.updatedBy });
    } catch (error) {
      // 覆盖项已损坏或不合法：保留 YAML 值，不阻断启动。
      console.error("apply stored execution config failed; keeping file config", { error: errorMessage(error) });
    }
  }

  /** 读取当前生效配置与来源。 */
  read(): ExecutionConfigPayload {
    const stored = this.store.getExecutionConfig();
    return {
      config: structuredClone(this.config.execution),
      source: stored ? "database" : "file",
      ...(stored ? { updatedAt: stored.updatedAt, updatedBy: stored.updatedBy } : {}),
      effectiveImmediately: true,
    };
  }

  /** 管理员保存：先合并到基线，完整校验通过才落库并生效。 */
  save(incoming: unknown, actor: string): { ok: true; payload: ExecutionConfigPayload } | { ok: false; error: string } {
    try {
      const merged = this.normalize(incoming);
      const candidate = structuredClone(this.baseline);
      candidate.execution = merged;
      validateConfig(candidate, "server");
      this.store.saveExecutionConfig(JSON.stringify(merged), actor);
      this.config.execution = merged;
      this.onApplied?.(this.config);
      console.info("execution config updated", { actor, backend: merged.backend, enabled: merged.enabled });
      return { ok: true, payload: this.read() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /** 清除覆盖，回退到 YAML 初始值。 */
  reset(): ExecutionConfigPayload {
    this.store.clearExecutionConfig();
    this.config.execution = structuredClone(this.baseline.execution);
    this.onApplied?.(this.config);
    return this.read();
  }

  /** 把外部提交的对象规整为 ExecutionConfig；缺失字段用当前 YAML 基线补齐，拒绝未知字段。 */
  private normalize(value: unknown): ExecutionConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("execution config must be an object");
    }
    const input = value as Record<string, unknown>;
    const base = structuredClone(this.baseline.execution);
    const known = new Set(["enabled", "backend", "sandbox", "local"]);
    for (const key of Object.keys(input)) {
      if (!known.has(key)) throw new Error(`unknown execution config field "${key}"`);
    }
    const enabled = boolField(input, "enabled", base.enabled);
    const backend = enumField(input, "backend", ["local", "sandbox"] as const, base.backend);
    const sandboxInput = objectField(input, "sandbox");
    const baseSandbox = base.sandbox;
    const sandbox: ExecutionConfig["sandbox"] = {
      runtime: enumField(sandboxInput, "runtime", ["docker", "podman"] as const, baseSandbox.runtime),
      image: stringField(sandboxInput, "image", baseSandbox.image),
      socket: stringField(sandboxInput, "socket", baseSandbox.socket),
      memory: stringField(sandboxInput, "memory", baseSandbox.memory),
      cpus: numField(sandboxInput, "cpus", baseSandbox.cpus),
      pidsLimit: numField(sandboxInput, "pids_limit", baseSandbox.pidsLimit),
      network: enumField(sandboxInput, "network", ["none", "bridge"] as const, baseSandbox.network),
      readOnlyMounts: listField(sandboxInput, "read_only_mounts", baseSandbox.readOnlyMounts),
      timeoutMs: numField(sandboxInput, "timeout_ms", baseSandbox.timeoutMs),
      maxOutputBytes: numField(sandboxInput, "max_output_bytes", baseSandbox.maxOutputBytes),
    };
    const localInput = objectField(input, "local");
    const local: ExecutionConfig["local"] = {
      allowUnsafe: boolField(localInput, "allow_unsafe", base.local.allowUnsafe),
      timeoutMs: numField(localInput, "timeout_ms", base.local.timeoutMs),
      maxOutputBytes: numField(localInput, "max_output_bytes", base.local.maxOutputBytes),
    };
    return { enabled, backend, sandbox, local };
  }
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (field === undefined) return {};
  if (!field || typeof field !== "object" || Array.isArray(field)) throw new Error(`execution.${key} must be an object`);
  return field as Record<string, unknown>;
}
function boolField(value: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "boolean") throw new Error(`execution.${key} must be a boolean`);
  return field;
}
function numField(value: Record<string, unknown>, key: string, fallback: number): number {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "number" || !Number.isFinite(field)) throw new Error(`execution.${key} must be a number`);
  return field;
}
function stringField(value: Record<string, unknown>, key: string, fallback: string): string {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "string") throw new Error(`execution.${key} must be a string`);
  return field;
}
function listField(value: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const field = value[key];
  if (field === undefined) return fallback;
  if (!Array.isArray(field) || !field.every((item) => typeof item === "string")) throw new Error(`execution.${key} must be an array of strings`);
  return field as string[];
}
function enumField<T extends string>(value: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const field = value[key];
  if (field === undefined) return fallback;
  if (typeof field !== "string" || !(allowed as readonly string[]).includes(field)) {
    throw new Error(`execution.${key} must be one of ${allowed.join(", ")}`);
  }
  return field as T;
}
