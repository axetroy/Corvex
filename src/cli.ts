import { loadConfig } from "./config/config.js";
import { CorvexServer } from "./app/server.js";
import { Worker } from "./app/worker.js";
import { JobStore } from "./jobs/store.js";
import { GitLabClient } from "./gitlab/client.js";

interface CliOptions {
  configPath: string;
  mode: "server" | "worker";
}

function parseArgs(args: string[]): CliOptions {
  let configPath = "configs/config.yaml";
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--config") {
      const value = args[++index];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option "${arg}"`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1 || (positional[0] && !["server", "worker"].includes(positional[0]))) {
    throw new Error("usage: corvex [--config path] [server|worker]");
  }
  return { configPath, mode: (positional[0] as CliOptions["mode"] | undefined) ?? "server" };
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

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "backup") {
    await runBackup(args.slice(1));
    return;
  }
  const options = parseArgs(args);
  const config = await loadConfig(options.configPath);
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
