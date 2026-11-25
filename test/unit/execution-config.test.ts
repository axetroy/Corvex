import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";

describe("execution config parsing", () => {
  let directory = "";
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  async function configWith(yaml: string) {
    directory = await mkdtemp(join(tmpdir(), "corvex-exec-config-"));
    const path = join(directory, "config.yaml");
    await writeFile(path, yaml);
    return loadConfig(path, "server");
  }

  const base = `
server:
  listen: "127.0.0.1:8080"
storage:
  root: "./data/corvex"
  database: "./data/state.db"
`;

  it("defaults execution to disabled with sandbox backend", async () => {
    const config = await configWith(base);
    expect(config.execution).toMatchObject({
      enabled: false,
      backend: "sandbox",
      sandbox: { runtime: "docker", network: "bridge", timeoutMs: 120_000, maxOutputBytes: 256 << 10 },
      local: { allowUnsafe: false },
    });
  });

  it("parses sandbox config and duration strings", async () => {
    const config = await configWith(base + `
execution:
  enabled: true
  backend: sandbox
  sandbox:
    image: "corvex-exec:latest"
    socket: "/var/run/docker.sock"
    runtime: podman
    memory: "4g"
    cpus: 2
    pids_limit: 512
    network: bridge
    timeout: 2m
    max_output_bytes: 1048576
`);
    expect(config.execution).toMatchObject({
      enabled: true,
      backend: "sandbox",
      sandbox: {
        image: "corvex-exec:latest",
        socket: "/var/run/docker.sock",
        runtime: "podman",
        cpus: 2,
        pidsLimit: 512,
        network: "bridge",
        timeoutMs: 120_000,
        maxOutputBytes: 1_048_576,
      },
    });
  });

  it("rejects an invalid backend value", async () => {
    await expect(configWith(base + `
execution:
  backend: vm
`)).rejects.toThrow(/execution.backend must be one of/);
  });
});
