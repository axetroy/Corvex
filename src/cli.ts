import { initializeConfig, loadConfig, type ConfigRole } from "./config/config.js";
import { CorvexServer } from "./app/server.js";
import { Worker } from "./app/worker.js";
import { JobStore } from "./jobs/store.js";
import { jobStatuses, type JobStatus } from "./jobs/model.js";
import { GitLabClient } from "./gitlab/client.js";
import { GitManager } from "./git/manager.js";

interface CliOptions {
  configPath: string;
  mode: "server" | "worker" | "check-config";
  configRole: ConfigRole;
}

function isJobStatus(value: string): value is JobStatus {
  return jobStatuses.some((status) => status === value);
}

function parseArgs(args: string[]): CliOptions {
  let configPath = "configs/config.yaml";
  let configRole: ConfigRole | undefined;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--config") {
      const value = args[++index];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
    } else if (arg === "--for") {
      const value = args[++index];
      if (value !== "server" && value !== "worker") {
        throw new Error("--for must be server or worker");
      }
      configRole = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option "${arg}"`);
    } else {
      positional.push(arg);
    }
  }
  if (
    positional.length > 1 ||
    (positional[0] && !["server", "worker", "check-config"].includes(positional[0]))
  ) {
    throw new Error("usage: corvex [--config path] [--for server|worker] [server|worker|check-config]");
  }
  const mode = (positional[0] as CliOptions["mode"] | undefined) ?? "server";
  if (mode !== "check-config" && configRole && configRole !== mode) {
    throw new Error("--for is only valid with check-config");
  }
  return {
    configPath,
    mode,
    configRole: mode === "worker" ? "worker" : configRole ?? "server",
  };
}

function parseInitArgs(args: string[]): string {
  let configPath = "configs/config.yaml";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--config") throw new Error(`unknown init option "${arg}"`);
    const value = args[++index];
    if (!value) throw new Error("--config requires a path");
    configPath = value;
  }
  return configPath;
}

async function runBackup(args: string[]): Promise<void> {
  let database = "";
  let output = "";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--database") database = args[++index] ?? "";
    else if (arg === "--output") output = args[++index] ?? "";
    else throw new Error(`unknown backup option "${arg}"`);
  }
  if (!database || !output) {
    throw new Error("usage: corvex backup --database <path> --output <new-path>");
  }
  const store = await JobStore.open(database);
  try {
    await store.backup(output);
    console.info("SQLite backup created", { output });
  } finally {
    store.close();
  }
}

async function runJobs(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== "list" && action !== "retry") {
    throw new Error("usage: corvex jobs [list|retry <job-id>] --database <path>");
  }
  const jobId = action === "retry" ? args[1] : undefined;
  const optionStart = action === "retry" ? 2 : 1;
  let database = "";
  let status: JobStatus | undefined;
  let limit = 50;
  for (let index = optionStart; index < args.length; index++) {
    const arg = args[index]!;
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--database") {
      database = value;
    } else if (arg === "--status") {
      if (!isJobStatus(value)) throw new Error(`unknown job status "${value}"`);
      status = value;
    } else if (arg === "--limit") {
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) throw new Error("--limit must be an integer");
    } else {
      throw new Error(`unknown jobs option "${arg}"`);
    }
  }
  if (!database || (action === "retry" && !jobId)) {
    throw new Error("usage: corvex jobs [list|retry <job-id>] --database <path>");
  }
  const store = await JobStore.open(database);
  try {
    const result = action === "list"
      ? store.listJobs(status, limit)
      : store.retryFailedJob(jobId ?? "");
    console.info(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

async function runStorageCleanup(args: string[]): Promise<void> {
  let configPath = "configs/config.yaml";
  let olderThanDays = 1;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--config") {
      configPath = value;
    } else if (arg === "--older-than-days") {
      olderThanDays = Number(value);
      if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
        throw new Error("--older-than-days must be a positive number");
      }
    } else {
      throw new Error(`unknown storage option "${arg}"`);
    }
  }
  const config = await loadConfig(configPath, "storage");
  const store = await JobStore.open(config.storage.database);
  try {
    const manager = new GitManager(
      config.storage.root,
      config.gitlab.baseUrl,
      config.gitlab.readToken,
    );
    const plan = await manager.cleanupStorage(
      store.activeJobIds(),
      store.pendingProjectIds(),
      new Date(Date.now() - olderThanDays * 24 * 60 * 60_000),
      apply,
    );
    console.info(JSON.stringify({ olderThanDays, ...plan }, null, 2));
  } finally {
    store.close();
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "init") {
    const configPath = parseInitArgs(args.slice(1));
    await initializeConfig(configPath);
    console.info("Configuration template created", { path: configPath });
    return;
  }
  if (args[0] === "backup") {
    await runBackup(args.slice(1));
    return;
  }
  if (args[0] === "jobs") {
    await runJobs(args.slice(1));
    return;
  }
  if (args[0] === "storage") {
    if (args[1] !== "cleanup") {
      throw new Error("usage: corvex storage cleanup [--config path] [--older-than-days days] [--apply]");
    }
    await runStorageCleanup(args.slice(2));
    return;
  }
  const options = parseArgs(args);
  const config = await loadConfig(options.configPath, options.configRole);
  if (options.mode === "check-config") {
    console.info("Configuration is valid", { path: options.configPath });
    return;
  }
  const store = await JobStore.open(config.storage.database);
  const gitlab = new GitLabClient(
    config.gitlab.baseUrl,
    config.gitlab.readToken,
    config.gitlab.writeToken,
  );
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (options.mode === "server") {
      await new CorvexServer(config, store, gitlab).run(controller.signal);
    } else {
      await new Worker(config, store, gitlab).run(controller.signal);
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    store.close();
  }
}

run().catch((error: unknown) => {
  console.error("Corvex stopped", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
