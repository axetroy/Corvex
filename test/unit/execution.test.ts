import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { validateConfig } from "../../src/config/config.js";
import { LocalExecutionBackend } from "../../src/agent/execution/local.js";
import { previewCommand } from "../../src/agent/execution/tool.js";

function baseConfig(): CorvexConfig {
  return {
    server: { listen: "0.0.0.0:8080", readTimeout: 5_000, shutdownTimeout: 30_000 },
    operations: { username: "", password: "" },
    gitlab: { baseUrl: "", oauthClientId: "", oauthClientSecret: "", oauthRedirectUri: "" },
    storage: { root: "/tmp/corvex", database: "/tmp/corvex.db", retentionDays: 90, auditRetentionDays: 365, conversationWorkspaceTtlMinutes: 60, conversationWorkspaceMax: 8 },
    agent: {
      responseLanguage: "en", baseUrl: "", model: "", apiKey: "", requestTimeout: 1_000,
      sessionTimeout: 1_000, responseStallTimeout: 0, maxOutputTokens: 4_096, dailyTokenBudget: 0,
      webEnabled: false, webBlockedHosts: [], webSearchEnabled: false, webSearchMaxQueries: 5,
      gitToolCallLimit: 40, autoCreateMergeRequest: false, reasoningEnabled: false, thinkingLevel: "medium",
      taskMaxRounds: 0, taskMaxOutputTokens: 0, skillPaths: [], contextWindow: 131_072,
      maxInputTokens: 0, historyTokenBudget: 24_000, turnToolResultBytes: 256 << 10,
      compactionReserveTokens: 0, compactionKeepRecentTokens: 20_000, compactionTriggerPercent: 85,
      compactionDynamicThreshold: false, summaryEnabled: true, followupsEnabled: false, followupsCount: 3,
      projectAgentsMd: false, projectAgentsMdMaxBytes: 32 << 10, contextInspectEnabled: false,
      contextInspectMaxItems: 80, contextInspectMaxPreviewChars: 2_048,
    },
    execution: {
      enabled: false, backend: "sandbox",
      sandbox: { runtime: "docker", image: "", socket: "", memory: "2g", cpus: 1, pidsLimit: 256, tmpfsSizeMb: 512, logMaxSizeMb: 4, logMaxFile: 2, network: "none", readOnlyMounts: [], timeoutMs: 120_000, maxOutputBytes: 256 << 10 },
      local: { allowUnsafe: false, timeoutMs: 120_000, maxOutputBytes: 256 << 10 },
    },
  };
}

describe("execution config validation", () => {
  it("accepts a disabled execution config", () => {
    expect(() => validateConfig(baseConfig())).not.toThrow();
  });

  it("requires sandbox image and socket when enabled", () => {
    const config = baseConfig();
    config.execution.enabled = true;
    expect(() => validateConfig(config)).toThrow(/execution\.sandbox\.image is required/);
    expect(() => validateConfig(config)).toThrow(/execution\.sandbox\.socket is required/);
  });

  it("fail-closes the local backend outside development", () => {
    const config = baseConfig();
    config.execution.enabled = true;
    config.execution.backend = "local";
    config.execution.local.allowUnsafe = true;
    expect(() => validateConfig(config, "server")).toThrow(/only allowed in development/);
  });

  it("accepts local backend in development when explicitly allowed", () => {
    const config = baseConfig();
    config.execution.enabled = true;
    config.execution.backend = "local";
    config.execution.local.allowUnsafe = true;
    const previous = process.env.CORVEX_DEV;
    process.env.CORVEX_DEV = "1";
    try {
      expect(() => validateConfig(config, "server")).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.CORVEX_DEV;
      else process.env.CORVEX_DEV = previous;
    }
  });
});

describe("command preview", () => {
  it("redacts secrets and bounds length", () => {
    const preview = previewCommand("curl -H 'Authorization: Bearer abcdef1234567890' https://x");
    expect(preview).toContain("[REDACTED]");
    expect(preview.length).toBeLessThanOrEqual(300);
  });
});

describe("local execution backend", () => {
  let directory = "";
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("runs a command and supports shell syntax", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-exec-"));
    await writeFile(join(directory, "file.txt"), "hello\n");
    const backend = new LocalExecutionBackend();
    const result = await backend.run({
      command: "echo ok && cat file.txt",
      cwd: directory,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\nhello\n");
    expect(result.aborted).toBe(false);
  });

  it("truncates oversized output", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-exec-"));
    const backend = new LocalExecutionBackend();
    const result = await backend.run({
      command: "node -e 'process.stdout.write(\"x\".repeat(100))'",
      cwd: directory,
      timeoutMs: 5_000,
      maxOutputBytes: 10,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(10);
  });

  it("kills a command that exceeds the timeout", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-exec-"));
    const backend = new LocalExecutionBackend();
    const result = await backend.run({
      command: "node -e 'setTimeout(() => {}, 5000)'",
      cwd: directory,
      timeoutMs: 100,
      maxOutputBytes: 1_024,
    });
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("honors cancellation", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-exec-"));
    const backend = new LocalExecutionBackend();
    const controller = new AbortController();
    const pending = backend.run({
      command: "node -e 'setTimeout(() => {}, 5000)'",
      cwd: directory,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    }, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.aborted).toBe(true);
  });
});
