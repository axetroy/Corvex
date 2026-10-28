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
    gitlab: {
      baseUrl: "https://gitlab.example.com",
      readToken: "read",
      writeToken: "write",
      webhookSecret: "secret",
      allowedProjectIds: [1],
      allowedUserIds: [2],
      botUsername: "corvex",
    },
    storage: { root: "./data", database: "./data/state.db", retentionDays: 90, auditRetentionDays: 365 },
    agent: {
      enabled: false,
      baseUrl: "https://api.openai.com/v1",
      model: "",
      apiKey: "",
      requestTimeout: 120000,
      maxOutputTokens: 4096,
      dailyTokenBudget: 0,
      mcpEnabled: false,
      skillPaths: [],
    },
    review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20 },
    worker: { pollInterval: 2000, jobTimeout: 30 * 60_000 },
    fix: { enabled: false, allowedUserIds: [], maxPatchBytes: 128 << 10 },
  };
}

describe("validateConfig", () => {
  it("initializes a config file from the packaged example template", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-init-"));
    const configPath = join(root, "config.yaml");
    try {
      await initializeConfig(configPath);
      const contents = await (await import("node:fs/promises")).readFile(configPath, "utf8");
      expect(contents).toContain("allowed_project_ids");
      expect(contents).toContain("allowed_user_ids");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a valid configuration with the agent disabled", () => {
    expect(() => validateConfig(validConfig())).not.toThrow();
  });

  it("rejects empty authorization allowlists", () => {
    const config = validConfig();
    config.gitlab.allowedProjectIds = [];
    expect(() => validateConfig(config)).toThrow("allowed_project_ids must not be empty");
  });

  it("rejects credential-bearing model URLs when the agent is enabled", () => {
    const config = validConfig();
    config.agent.enabled = true;
    config.agent.baseUrl = "https://user:pass@example.com/v1";
    config.agent.model = "model";
    config.agent.apiKey = "key";
    expect(() => validateConfig(config)).toThrow("agent.base_url");
  });

  it("applies the documented listener and GitLab URL environment overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-"));
    const configPath = join(root, "config.yaml");
    const names = [
      "CORVEX_LISTEN",
      "CORVEX_GITLAB_BASE_URL",
      "CORVEX_GITLAB_READ_TOKEN",
      "CORVEX_GITLAB_TOKEN",
      "CORVEX_WEBHOOK_SECRET",
    ] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      process.env.CORVEX_LISTEN = "127.0.0.1:9090";
      process.env.CORVEX_GITLAB_BASE_URL = "https://gitlab.override.example";
      process.env.CORVEX_GITLAB_READ_TOKEN = "read";
      process.env.CORVEX_GITLAB_TOKEN = "write";
      process.env.CORVEX_WEBHOOK_SECRET = "secret";
      await writeFile(
        configPath,
        JSON.stringify({
          gitlab: { allowed_project_ids: [1], allowed_user_ids: [2] },
          storage: { root, database: join(root, "state.db") },
        }),
      );
      const config = await loadConfig(configPath);
      expect(config.server.listen).toBe("127.0.0.1:9090");
      expect(config.gitlab.baseUrl).toBe("https://gitlab.override.example");
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires only the credentials used by the selected process role", async () => {
    const root = await mkdtemp(join(tmpdir(), "corvex-config-role-"));
    const configPath = join(root, "config.yaml");
    const names = [
      "CORVEX_GITLAB_READ_TOKEN",
      "CORVEX_GITLAB_TOKEN",
      "CORVEX_WEBHOOK_SECRET",
      "CORVEX_MODEL_API_KEY",
    ] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          gitlab: {
            base_url: "https://gitlab.example.com",
            allowed_project_ids: [1],
            allowed_user_ids: [2],
          },
          storage: { root, database: join(root, "state.db") },
          agent: { enabled: true, model: "test-model" },
        }),
      );
      process.env.CORVEX_GITLAB_READ_TOKEN = "";
      process.env.CORVEX_GITLAB_TOKEN = "write";
      process.env.CORVEX_WEBHOOK_SECRET = "webhook";
      process.env.CORVEX_MODEL_API_KEY = "";
      await expect(loadConfig(configPath, "server")).resolves.toMatchObject({
        gitlab: { readToken: "", writeToken: "write", webhookSecret: "webhook" },
      });

      process.env.CORVEX_GITLAB_READ_TOKEN = "read";
      process.env.CORVEX_WEBHOOK_SECRET = "";
      process.env.CORVEX_MODEL_API_KEY = "model-key";
      await expect(loadConfig(configPath, "worker")).resolves.toMatchObject({
        gitlab: { readToken: "read", writeToken: "write", webhookSecret: "" },
        agent: { apiKey: "model-key" },
      });
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
