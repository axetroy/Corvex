import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initializeConfig,
  loadConfig,
  validateConfig,
  type CorvexConfig,
} from "../../src/config/config.js";

function validConfig(): CorvexConfig {
  return {
    server: { listen: "127.0.0.1:8080", readTimeout: 5000, shutdownTimeout: 30000 },
    operations: { username: "", password: "" },
    gitlab: {
      baseUrl: "https://gitlab.example.com",
      readToken: "read",
      writeToken: "write",
      oauthClientId: "",
      oauthClientSecret: "",
      oauthRedirectUri: "",
    },
    storage: {
      root: "./data", database: "./data/state.db", retentionDays: 90, auditRetentionDays: 365,
      conversationWorkspaceTtlMinutes: 60, conversationWorkspaceMax: 8,
    },
    agent: {
      responseLanguage: "en",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      apiKey: "",
      requestTimeout: 120000,
      sessionTimeout: 30 * 60_000,
      responseStallTimeout: 3 * 60_000,
      maxOutputTokens: 4096,
      dailyTokenBudget: 0,
      webEnabled: true,
      webBlockedHosts: [],
      skillPaths: [],
      contextWindow: 131_072,
      maxInputTokens: 0,
      historyTokenBudget: 24_000,
      turnToolResultBytes: 256 << 10,
      compactionReserveTokens: 16_384,
      compactionKeepRecentTokens: 20_000,
      summaryEnabled: true,
    },
  };
}

describe("validateConfig", () => {
  it("defaults the response stall watchdog to three minutes", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-stall-"));
    const configPath = join(root, "config.yaml");
    try {
      await writeFile(configPath, JSON.stringify({
        gitlab: { base_url: "https://gitlab.example.com" },
        storage: { root, database: join(root, "state.db") },
      }));
      await expect(loadConfig(configPath, "storage")).resolves.toMatchObject({
        agent: { responseStallTimeout: 180_000 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults the per-turn tool result budget to 256 KiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-tool-budget-"));
    const configPath = join(root, "config.yaml");
    try {
      await writeFile(configPath, JSON.stringify({
        gitlab: { base_url: "https://gitlab.example.com" },
        storage: { root, database: join(root, "state.db") },
      }));
      await expect(loadConfig(configPath, "storage")).resolves.toMatchObject({
        agent: { turnToolResultBytes: 256 << 10 },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes a config file from the packaged example template", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-init-"));
    const configPath = join(root, "config.yaml");
    try {
      await initializeConfig(configPath);
      const contents = await (await import("node:fs/promises")).readFile(configPath, "utf8");
      expect(contents).not.toContain("allowed_project_ids");
      // 模板只保留启动必需项；可调项（含 GitLab 地址）改由控制台写入 SQLite。
      expect(contents).not.toContain("base_url");
      expect(contents).not.toContain("session_timeout");
      expect(contents).not.toContain("retention_days");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a valid configuration with the agent disabled", () => {
    expect(() => validateConfig(validConfig())).not.toThrow();
  });

  it("parses request and session timeouts independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-timeouts-"));
    const configPath = join(root, "config.yaml");
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          gitlab: {
            base_url: "https://gitlab.example.com",
          },
          storage: { root, database: join(root, "state.db") },
          agent: { request_timeout: "45s", session_timeout: "20m" },
        }),
      );
      const config = await loadConfig(configPath, "storage");
      expect(config.agent.requestTimeout).toBe(45_000);
      expect(config.agent.sessionTimeout).toBe(20 * 60_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults model response language to English and accepts Simplified Chinese", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-language-"));
    const configPath = join(root, "config.yaml");
    try {
      const base = {
        gitlab: {
          base_url: "https://gitlab.example.com",
        },
        storage: { root, database: join(root, "state.db") },
      };
      await writeFile(configPath, JSON.stringify(base));
      const defaultConfig = await loadConfig(configPath, "storage");
      expect(defaultConfig.agent).toHaveProperty("responseLanguage", "en");

      await writeFile(configPath, JSON.stringify({ ...base, agent: { response_language: "zh-CN" } }));
      const chineseConfig = await loadConfig(configPath, "storage");
      expect(chineseConfig.agent).toHaveProperty("responseLanguage", "zh-CN");

      await writeFile(configPath, JSON.stringify({ ...base, agent: { response_language: "fr" } }));
      await expect(loadConfig(configPath, "storage")).rejects.toThrow(
        'agent.response_language must be "en" or "zh-CN"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires operations credentials to be set together and validates them when present", () => {
    const config = validConfig();
    config.operations.username = "operator";
    expect(() => validateConfig(config)).toThrow("both operations username and password must be set together");

    config.operations.password = "short";
    expect(() => validateConfig(config)).not.toThrow();

    config.operations.username = "bad:name";
    expect(() => validateConfig(config)).toThrow("operations console credentials contain invalid characters");
  });

  it("requires all GitLab OAuth settings together when configured", () => {
    const config = validConfig();
    config.gitlab.oauthClientId = "client";
    expect(() => validateConfig(config)).toThrow("GitLab OAuth requires client ID");

    config.gitlab.oauthClientSecret = "secret";
    config.gitlab.oauthRedirectUri = "https://corvex.example.com/auth/gitlab/callback";
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("defers the GitLab base URL to the console settings", () => {
    const config = validConfig();
    config.gitlab.baseUrl = "";
    expect(() => validateConfig(config, "server")).not.toThrow();

    config.gitlab.baseUrl = "not-a-url";
    expect(() => validateConfig(config, "server")).toThrow("gitlab.base_url must be a valid HTTP(S) URL");
  });

  it("allows GitLab credentials to be configured later in the console", () => {
    const config = validConfig();
    config.gitlab.readToken = "";
    config.gitlab.writeToken = "";
    expect(() => validateConfig(config, "server")).not.toThrow();
  });

  it("rejects credential-bearing model URLs", () => {
    const config = validConfig();
    config.agent.baseUrl = "https://user:pass@example.com/v1";
    config.agent.model = "model";
    config.agent.apiKey = "key";
    expect(() => validateConfig(config)).toThrow("agent.base_url");
  });

  it("validates optional blocked hostnames", () => {
    const config = validConfig();
    config.agent.webBlockedHosts = ["*.corp.dev"];
    expect(() => validateConfig(config)).toThrow("web_blocked_hosts must contain DNS hostnames");

    config.agent.webBlockedHosts = ["127.0.0.1"];
    expect(() => validateConfig(config)).toThrow("web_blocked_hosts must contain DNS hostnames");

    config.agent.webBlockedHosts = ["untrusted.corp.dev"];
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("applies the documented listener and GitLab URL environment overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-"));
    const configPath = join(root, "config.yaml");
    const names = ["CORVEX_LISTEN", "CORVEX_GITLAB_BASE_URL"] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.CORVEX_LISTEN = "127.0.0.1:9090";
      process.env.CORVEX_GITLAB_BASE_URL = "https://gitlab.override.example";
      await writeFile(
        configPath,
        JSON.stringify({
          storage: { root, database: join(root, "state.db") },
        }),
      );
      const config = await loadConfig(configPath);
      expect(config.server.listen).toBe("127.0.0.1:9090");
      expect(config.gitlab.baseUrl).toBe("https://gitlab.override.example");
      expect(config.operations).toEqual({ username: "", password: "" });
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores the removed GitLab token environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-role-"));
    const configPath = join(root, "config.yaml");
    const names = ["CORVEX_GITLAB_READ_TOKEN", "CORVEX_GITLAB_TOKEN"] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          gitlab: { base_url: "https://gitlab.example.com" },
          storage: { root, database: join(root, "state.db") },
          agent: { model: "test-model" },
        }),
      );
      process.env.CORVEX_GITLAB_READ_TOKEN = "read";
      process.env.CORVEX_GITLAB_TOKEN = "write";
      const server = await loadConfig(configPath, "server");
      // GitLab 访问只使用当前登录用户的 OAuth token，配置层不再暴露任何 PAT。
      expect(server.gitlab).not.toHaveProperty("readToken");
      expect(server.gitlab).not.toHaveProperty("writeToken");
      expect(server.agent).toMatchObject({ webEnabled: true, webBlockedHosts: [] });
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
