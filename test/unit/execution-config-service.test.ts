import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { ExecutionConfigService } from "../../src/app/execution-config-service.js";
import { AppStore } from "../../src/store.js";

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
      sandbox: { runtime: "docker", image: "", socket: "", memory: "2g", cpus: 1, pidsLimit: 256, network: "bridge", readOnlyMounts: [], timeoutMs: 120_000, maxOutputBytes: 256 << 10 },
      local: { allowUnsafe: false, timeoutMs: 120_000, maxOutputBytes: 256 << 10 },
    },
  };
}

describe("ExecutionConfigService", () => {
  let store: AppStore | undefined;
  afterEach(() => { store?.close(); store = undefined; });

  it("reads the file config when no DB override exists", async () => {
    const realStore = await AppStore.open(":memory:");
    store = realStore;
    const config = baseConfig();
    const service = new ExecutionConfigService(config, realStore, structuredClone(config));
    const payload = service.read();
    expect(payload.source).toBe("file");
    expect(payload.config.enabled).toBe(false);
    // 接口返回 snake_case（UI 期望的形态），不能是内部 camelCase。
    const sandbox = (payload.config as unknown as Record<string, Record<string, unknown>>).sandbox;
    expect(sandbox).toHaveProperty("pids_limit");
    expect(sandbox).toHaveProperty("timeout_ms");
    expect(sandbox).toHaveProperty("max_output_bytes");
    expect(sandbox).toHaveProperty("read_only_mounts");
    expect(sandbox).not.toHaveProperty("pidsLimit");
  });

  it("saves a valid sandbox config and applies it immediately", async () => {
    const realStore = await AppStore.open(":memory:");
    store = realStore;
    const config = baseConfig();
    const service = new ExecutionConfigService(config, realStore, structuredClone(config));
    const result = service.save({
      enabled: true,
      backend: "sandbox",
      sandbox: { image: "corvex-exec:latest", socket: "/var/run/docker.sock", cpus: 2, pids_limit: 512 },
      local: {},
    }, "admin");
    expect(result.ok).toBe(true);
    expect(config.execution.enabled).toBe(true);
    expect(config.execution.sandbox.image).toBe("corvex-exec:latest");
    expect(config.execution.sandbox.cpus).toBe(2);
    expect(service.read().source).toBe("database");
  });

  it("rejects an invalid config without changing anything", async () => {
    const realStore = await AppStore.open(":memory:");
    store = realStore;
    const config = baseConfig();
    const service = new ExecutionConfigService(config, realStore, structuredClone(config));
    // local backend outside development is fail-closed (CORVEX_DEV not set in tests)
    const result = service.save({ enabled: true, backend: "local", local: { allow_unsafe: true } }, "admin");
    expect(result.ok).toBe(false);
    expect(config.execution.backend).toBe("sandbox");
    expect(service.read().source).toBe("file");
  });

  it("resets to the file config", async () => {
    const realStore = await AppStore.open(":memory:");
    store = realStore;
    const config = baseConfig();
    const service = new ExecutionConfigService(config, realStore, structuredClone(config));
    service.save({ enabled: true, backend: "sandbox", sandbox: { image: "x", socket: "y" } }, "admin");
    const payload = service.reset();
    expect(payload.source).toBe("file");
    expect(config.execution.enabled).toBe(false);
  });
});
