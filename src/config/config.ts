import { constants } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface CorvexConfig {
  server: {
    listen: string;
    readTimeout: number;
    shutdownTimeout: number;
  };
  operations: {
    username: string;
    password: string;
  };
  gitlab: {
    baseUrl: string;
    readToken: string;
    writeToken: string;
    webhookSecret: string;
    allowedProjectIds: number[];
    allowedUserIds: number[];
    botUsername: string;
  };
  storage: {
    root: string;
    database: string;
    retentionDays: number;
    auditRetentionDays: number;
  };
  agent: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKey: string;
    requestTimeout: number;
    maxOutputTokens: number;
    dailyTokenBudget: number;
    mcpEnabled: boolean;
    skillPaths: string[];
  };
  review: {
    maxFiles: number;
    maxFindings: number;
    maxContextBytes: number;
  };
  worker: {
    pollInterval: number;
    jobTimeout: number;
  };
  fix: {
    enabled: boolean;
    allowedUserIds: number[];
    maxPatchBytes: number;
  };
}

export type ConfigRole = "server" | "worker" | "storage";

type JsonObject = Record<string, unknown>;

const defaults: CorvexConfig = {
  server: { listen: "0.0.0.0:8080", readTimeout: 5_000, shutdownTimeout: 30_000 },
  operations: { username: "", password: "" },
  gitlab: {
    baseUrl: "",
    readToken: "",
    writeToken: "",
    webhookSecret: "",
    allowedProjectIds: [],
    allowedUserIds: [],
    botUsername: "",
  },
  storage: { root: "", database: "", retentionDays: 90, auditRetentionDays: 365 },
  agent: {
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
    requestTimeout: 120_000,
    maxOutputTokens: 4096,
    dailyTokenBudget: 0,
    mcpEnabled: false,
    skillPaths: [],
  },
  review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20 },
  worker: { pollInterval: 2000, jobTimeout: 30 * 60_000 },
  fix: { enabled: false, allowedUserIds: [], maxPatchBytes: 128 << 10 },
};

function object(value: unknown, label: string): JsonObject {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as JsonObject;
}

function string(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("configuration value must be a string");
  return value;
}

function number(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("configuration value must be a finite number");
  }
  return value;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("configuration value must be a boolean");
  return value;
}

function numberArray(value: unknown, fallback: number[]): number[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => Number.isSafeInteger(item))) {
    throw new Error("configuration value must be an array of safe integers");
  }
  return value;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("configuration value must be an array of strings");
  }
  return value;
}

function duration(value: unknown, fallback: number, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a duration string`);
  const match = /^([0-9]+(?:\.[0-9]+)?)(ns|us|µs|ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid duration "${value}" for ${label}`);
  const amount = Number(match[1]);
  const multipliers: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    "µs": 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  return amount * multipliers[match[2]!];
}

function parseConfig(raw: unknown): CorvexConfig {
  const root = object(raw, "configuration");
  const server = object(root.server, "server");
  const gitlab = object(root.gitlab, "gitlab");
  const storage = object(root.storage, "storage");
  const agent = object(root.agent, "agent");
  const review = object(root.review, "review");
  const worker = object(root.worker, "worker");
  const fix = object(root.fix, "fix");
  return {
    server: {
      listen: process.env.CORVEX_LISTEN ?? string(server.listen, defaults.server.listen),
      readTimeout: duration(server.read_timeout, defaults.server.readTimeout, "server.read_timeout"),
      shutdownTimeout: duration(
        server.shutdown_timeout,
        defaults.server.shutdownTimeout,
        "server.shutdown_timeout",
      ),
    },
    operations: {
      username: process.env.CORVEX_OPS_USERNAME ?? defaults.operations.username,
      password: process.env.CORVEX_OPS_PASSWORD ?? defaults.operations.password,
    },
    gitlab: {
      baseUrl:
        process.env.CORVEX_GITLAB_BASE_URL ?? string(gitlab.base_url, defaults.gitlab.baseUrl),
      readToken: process.env.CORVEX_GITLAB_READ_TOKEN ?? "",
      writeToken: process.env.CORVEX_GITLAB_TOKEN ?? "",
      webhookSecret: process.env.CORVEX_WEBHOOK_SECRET ?? "",
      allowedProjectIds: numberArray(gitlab.allowed_project_ids, defaults.gitlab.allowedProjectIds),
      allowedUserIds: numberArray(gitlab.allowed_user_ids, defaults.gitlab.allowedUserIds),
      botUsername: string(gitlab.bot_username, defaults.gitlab.botUsername),
    },
    storage: {
      root: process.env.CORVEX_STORAGE_ROOT ?? string(storage.root, defaults.storage.root),
      database:
        process.env.CORVEX_DATABASE ?? string(storage.database, defaults.storage.database),
      retentionDays: number(storage.retention_days, defaults.storage.retentionDays),
      auditRetentionDays: number(
        storage.audit_retention_days,
        defaults.storage.auditRetentionDays,
      ),
    },
    agent: {
      enabled: boolean(agent.enabled, defaults.agent.enabled),
      baseUrl:
        process.env.CORVEX_MODEL_BASE_URL ?? string(agent.base_url, defaults.agent.baseUrl),
      model: process.env.CORVEX_MODEL_NAME ?? string(agent.model, defaults.agent.model),
      apiKey: process.env.CORVEX_MODEL_API_KEY ?? "",
      requestTimeout: duration(
        agent.request_timeout,
        defaults.agent.requestTimeout,
        "agent.request_timeout",
      ),
      maxOutputTokens: number(agent.max_output_tokens, defaults.agent.maxOutputTokens),
      dailyTokenBudget: number(agent.daily_token_budget, defaults.agent.dailyTokenBudget),
      mcpEnabled: boolean(agent.mcp_enabled, defaults.agent.mcpEnabled),
      skillPaths: stringArray(agent.skill_paths, defaults.agent.skillPaths),
    },
    review: {
      maxFiles: number(review.max_files, defaults.review.maxFiles),
      maxFindings: number(review.max_findings, defaults.review.maxFindings),
      maxContextBytes: number(review.max_context_bytes, defaults.review.maxContextBytes),
    },
    worker: {
      pollInterval: duration(worker.poll_interval, defaults.worker.pollInterval, "worker.poll_interval"),
      jobTimeout: duration(worker.job_timeout, defaults.worker.jobTimeout, "worker.job_timeout"),
    },
    fix: {
      enabled: boolean(fix.enabled, defaults.fix.enabled),
      allowedUserIds: numberArray(fix.allowed_user_ids, defaults.fix.allowedUserIds),
      maxPatchBytes: number(fix.max_patch_bytes, defaults.fix.maxPatchBytes),
    },
  };
}

function validHttpUrl(value: string, allowCredentials = false): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname !== "" &&
      (allowCredentials || (!url.username && !url.password && !url.search && !url.hash))
    );
  } catch {
    return false;
  }
}

export function validateConfig(config: CorvexConfig, role?: ConfigRole): void {
  const problems: string[] = [];
  if (!config.server.listen.trim()) problems.push("server.listen is required");
  if (config.server.readTimeout <= 0 || config.server.shutdownTimeout <= 0) {
    problems.push("server timeouts must be positive");
  }
  const operationsUsername = config.operations.username.trim();
  const operationsPassword = config.operations.password;
  if (Boolean(operationsUsername) !== Boolean(operationsPassword)) {
    problems.push("both CORVEX_OPS_USERNAME and CORVEX_OPS_PASSWORD must be set to enable the operations dashboard");
  }
  const operationsCredentials = operationsUsername + operationsPassword;
  const hasControlCharacters = [...operationsCredentials].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (operationsUsername.includes(":") || hasControlCharacters) {
    problems.push("operations dashboard credentials contain invalid characters");
  }
  if (!validHttpUrl(config.gitlab.baseUrl)) {
    problems.push("gitlab.base_url must be a valid HTTP(S) URL");
  }
  if (role !== "server" && role !== "storage" && !config.gitlab.readToken.trim()) {
    problems.push("CORVEX_GITLAB_READ_TOKEN is required");
  }
  if (role !== "storage" && !config.gitlab.writeToken.trim()) {
    problems.push("CORVEX_GITLAB_TOKEN is required");
  }
  if (role !== "worker" && role !== "storage" && !config.gitlab.webhookSecret.trim()) {
    problems.push("CORVEX_WEBHOOK_SECRET is required");
  }
  if (config.gitlab.allowedProjectIds.length === 0) {
    problems.push("gitlab.allowed_project_ids must not be empty");
  }
  if (config.gitlab.allowedUserIds.length === 0) {
    problems.push("gitlab.allowed_user_ids must not be empty");
  }
  if (!config.storage.root.trim()) problems.push("storage.root is required");
  if (!config.storage.database.trim()) problems.push("storage.database is required");
  if (config.storage.retentionDays < 1 || config.storage.retentionDays > 36_500) {
    problems.push("storage.retention_days must be between 1 and 36500");
  }
  if (config.storage.auditRetentionDays < 1 || config.storage.auditRetentionDays > 36_500) {
    problems.push("storage.audit_retention_days must be between 1 and 36500");
  }
  if (config.review.maxFiles <= 0 || config.review.maxFiles > 1000) {
    problems.push("review.max_files must be between 1 and 1000");
  }
  if (config.review.maxFindings <= 0 || config.review.maxFindings > 100) {
    problems.push("review.max_findings must be between 1 and 100");
  }
  if (config.review.maxContextBytes <= 0 || config.review.maxContextBytes > 8 << 20) {
    problems.push("review.max_context_bytes must be between 1 byte and 8 MiB");
  }
  if (config.worker.pollInterval <= 0 || config.worker.jobTimeout <= 0) {
    problems.push("worker poll interval and job timeout must be positive");
  }
  if (config.fix.enabled && config.fix.allowedUserIds.length === 0) {
    problems.push("fix.allowed_user_ids must not be empty when fix.enabled is true");
  }
  if (config.fix.enabled && !config.agent.enabled) {
    problems.push("agent.enabled must be true when fix.enabled is true");
  }
  if (config.fix.maxPatchBytes <= 0 || config.fix.maxPatchBytes > 256 << 10) {
    problems.push("fix.max_patch_bytes must be between 1 byte and 256 KiB");
  }
  if (role === "worker" && !config.agent.enabled) {
    problems.push("agent.enabled must be true for worker mode");
  }
  if (config.agent.enabled && role !== "server" && role !== "storage") {
    if (!validHttpUrl(config.agent.baseUrl)) {
      problems.push("agent.base_url must be a valid HTTP(S) URL without credentials");
    }
    if (!config.agent.model.trim()) problems.push("agent.model is required when the agent is enabled");
    if (!config.agent.apiKey.trim()) {
      problems.push("CORVEX_MODEL_API_KEY is required when the agent is enabled");
    }
    if (config.agent.requestTimeout <= 0) problems.push("agent.request_timeout must be positive");
    if (config.agent.maxOutputTokens <= 0 || config.agent.maxOutputTokens > 8192) {
      problems.push("agent.max_output_tokens must be between 1 and 8192");
    }
    if (config.agent.dailyTokenBudget < 0 || config.agent.dailyTokenBudget > 1_000_000_000) {
      problems.push("agent.daily_token_budget must be between 0 and 1000000000");
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
}

export async function loadConfig(path: string, role?: ConfigRole): Promise<CorvexConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`read config "${path}": ${String(error)}`, { cause: error });
  }
  let config: CorvexConfig;
  try {
    config = parseConfig(parse(contents));
  } catch (error) {
    throw new Error(`parse config "${path}": ${String(error)}`, { cause: error });
  }
  validateConfig(config, role);
  await mkdir(dirname(config.storage.database), { recursive: true });
  await mkdir(join(config.storage.root, "mirrors"), { recursive: true });
  await mkdir(join(config.storage.root, "workspaces"), { recursive: true });
  return config;
}

export async function initializeConfig(path: string): Promise<void> {
  if (!path.trim()) throw new Error("config path is required");
  const template = fileURLToPath(new URL("../../configs/config.example.yaml", import.meta.url));
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(template, output, constants.COPYFILE_EXCL);
}
