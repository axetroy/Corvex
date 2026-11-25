import { afterEach, describe, expect, it } from "vitest";
import type { ExecutionConfig } from "../../src/config/config.js";
import { buildContainerArgs, SandboxExecutionBackend } from "../../src/agent/execution/sandbox.js";

const sandboxConfig: ExecutionConfig["sandbox"] = {
  runtime: "docker",
  image: "alpine:3.20",
  socket: "/var/run/docker.sock",
  memory: "2g",
  cpus: 1,
  pidsLimit: 256,
  tmpfsSizeMb: 512,
  network: "bridge",
  readOnlyMounts: [],
  timeoutMs: 30_000,
  maxOutputBytes: 256 << 10,
};

const request = {
  command: "echo hello",
  cwd: "/tmp/worktree",
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
};

describe("sandbox container args", () => {
  it("builds an isolated container invocation", () => {
    const args = buildContainerArgs(sandboxConfig, request, "corvex-exec-test");
    expect(args).toContain("--network");
    expect(args[args.indexOf("--network") + 1]).toBe("bridge");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("--security-opt");
    expect(args).toContain("--read-only");
    const tmpfs = args[args.indexOf("--tmpfs") + 1];
    expect(tmpfs).toBe("/tmp:rw,size=512m");
    expect(args).toContain("HOME=/tmp");
    expect(args).toContain("npm_config_cache=/tmp/corvex-cache/npm");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("--rm");
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("corvex-exec-test");
    expect(args.some((arg) => arg.includes("type=bind") && arg.includes("target=/workspace"))).toBe(true);
    expect(args.at(-3)).toBe("/bin/sh");
    expect(args.at(-2)).toBe("-c");
    expect(args.at(-1)).toBe("echo hello");
  });

  it("supports a fully network-isolated mode when configured", () => {
    const args = buildContainerArgs({ ...sandboxConfig, network: "none" }, request, "c");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });
});

describe("sandbox execution backend (requires docker)", () => {
  let backend: SandboxExecutionBackend | undefined;
  afterEach(() => { backend = undefined; });

  const integrationImage = process.env.CORVEX_TEST_SANDBOX_IMAGE;
  const canRunIntegration = Boolean(integrationImage) && process.platform !== "win32";

  it("runs a command in a container when an image is provided", async () => {
    // 集成测试需要真实容器镜像，默认跳过；CI 的 docker-smoke job 设置 CORVEX_TEST_SANDBOX_IMAGE。
    if (!canRunIntegration) return;
    backend = new SandboxExecutionBackend({ ...sandboxConfig, image: integrationImage! });
    const result = await backend.run({ ...request, timeoutMs: 30_000 });
    expect(result.backend).toBe("sandbox");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.aborted).toBe(false);
  });

  it("fails closed when the container runtime is unavailable", async () => {
    backend = new SandboxExecutionBackend({
      ...sandboxConfig,
      runtime: "corvex-definitely-not-a-runtime",
    });
    const result = await backend.run(request);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("execution error");
  });
});
