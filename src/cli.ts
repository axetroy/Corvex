import { initializeConfig, loadConfig, type ConfigRole } from "./config/config.js";
import { applyRuntimeSettingRows } from "./config/settings.js";
import { CorvexServer } from "./app/server.js";
import { AppStore } from "./store.js";
import { errorMessage } from "./errors.js";
import { GitManager } from "./git/manager.js";

interface CliOptions {
  configPath: string;
  mode: "server" | "check-config";
  configRole: ConfigRole;
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
      if (value !== "server" && value !== "storage") {
        throw new Error("--for must be server or storage");
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
    (positional[0] && !["server", "check-config"].includes(positional[0]))
  ) {
    throw new Error("usage: corvex [--env path] [--config path] [--for server|storage] [server|check-config]");
  }
  const mode = (positional[0] as CliOptions["mode"] | undefined) ?? "server";
  if (mode !== "check-config" && configRole) {
    throw new Error("--for is only valid with check-config");
  }
  return {
    configPath,
    mode,
    configRole: configRole ?? "server",
  };
}

function loadEnvironmentFile(args: string[]): string[] {
  let envPath: string | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--env") {
      if (envPath !== undefined) throw new Error("--env may only be specified once");
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--env requires a path");
      envPath = value;
      index++;
    } else {
      remaining.push(arg);
    }
  }
  if (envPath !== undefined) process.loadEnvFile(envPath);
  return remaining;
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
  const store = await AppStore.open(database);
  try {
    await store.backup(output);
    console.info("SQLite backup created", { output });
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
  const store = await AppStore.open(config.storage.database);
  try {
    // 控制台里改过的运行时设置存在同一个 SQLite 里，CLI 也要遵守。
    applyRuntimeSettingRows(config, store.listRuntimeSettings());
    const manager = new GitManager(config.storage.root, config.gitlab.baseUrl);
    const startedAt = new Date().toISOString();
    const plan = await manager.cleanupStorage(
      store.pendingProjectIds(),
      new Date(Date.now() - olderThanDays * 24 * 60 * 60_000),
      apply,
      store.activeConversationIds(),
    );
    store.recordStorageCleanup({
      startedAt,
      finishedAt: new Date().toISOString(),
      source: "cli",
      applied: apply,
      olderThanDays,
      removedWorkspaces: plan.workspaces.length,
      removedMirrors: plan.mirrors.length,
      error: "",
    });
    console.info(JSON.stringify({ olderThanDays, ...plan }, null, 2));
  } finally {
    store.close();
  }
}

async function run(): Promise<void> {
  const args = loadEnvironmentFile(process.argv.slice(2));
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
  if (args[0] === "storage") {
    if (args[1] !== "cleanup") {
      throw new Error("usage: corvex storage cleanup [--env path] [--config path] [--older-than-days days] [--apply]");
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
  const store = await AppStore.open(config.storage.database);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await new CorvexServer(config, store, options.configPath).run(controller.signal);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    store.close();
  }
}

run().catch((error: unknown) => {
  console.error("Corvex stopped", {
    error: errorMessage(error),
  });
  process.exitCode = 1;
});
