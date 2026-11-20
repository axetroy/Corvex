import { describe, expect, it } from "vitest";
import {
  applyActiveModel,
  applyRuntimeSettingRows,
  applyRuntimeSettings,
  copyRuntimeSettings,
  isRuntimeSettingKey,
  runtimeSettingDefinitions,
  runtimeSettingsEffective,
  runtimeSettingsView,
  validateRuntimeSettings,
} from "../../src/config/settings.js";
import { settingGroups } from "../../src/app/ui/types.js";
import type { CorvexConfig } from "../../src/config/config.js";

/** 一份完整的 agent 配置，作为测试基准；每个用例取一份独立副本。 */
function agentConfig(): CorvexConfig["agent"] {
  return {
    responseLanguage: "en",
    enabled: true,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-test",
    apiKey: "",
    requestTimeout: 120_000,
    sessionTimeout: 30 * 60_000,
    maxOutputTokens: 4_096,
    dailyTokenBudget: 0,
    mcpEnabled: false,
    webEnabled: true,
    webBlockedHosts: [],
    skillPaths: [],
    contextWindow: 131_072,
    maxInputTokens: 0,
    historyTokenBudget: 24_000,
    turnToolResultBytes: 512 << 10,
    compactionReserveTokens: 16_384,
    compactionKeepRecentTokens: 20_000,
    summaryEnabled: true,
  };
}

/** 只包含设置相关段的配置对象；其余段不参与运行时设置测试。 */
function settingsConfig(): CorvexConfig {
  return {
    agent: agentConfig(),
    review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
    chat: { historyComments: 20 },
    issue: { implementEnabled: false, historyComments: 20 },
    fix: { enabled: false, maxPatchBytes: 128 << 10 },
    storage: {
      root: "",
      database: "",
      retentionDays: 90,
      auditRetentionDays: 365,
      conversationWorkspaceTtlMinutes: 60,
      conversationWorkspaceMax: 8,
    },
    worker: { pollInterval: 2_000, eventTimeout: 30 * 60_000 },
    gitlab: {
      baseUrl: "https://gitlab.example.com",
      readToken: "read",
      writeToken: "write",
      webhookSecret: "secret",
      blockedUserIds: [7],
      botUsername: "corvex-bot",
    },
  } as CorvexConfig;
}

describe("validateRuntimeSettings", () => {
  it("接受合法覆盖项", () => {
    expect(validateRuntimeSettings({ context_window: "200000", summary_enabled: "false" })).toEqual([]);
  });

  it("拒绝未知键", () => {
    expect(validateRuntimeSettings({ nope: "1" })).toEqual(['unknown setting "nope"']);
  });

  it("允许没有密钥的本地模型", () => {
    expect(validateRuntimeSettings({ model_api_key: "" })).toEqual([]);
    expect(validateRuntimeSettings({ response_language: "" })).toEqual(["response_language must not be empty"]);
  });

  it("拒绝越界与类型错误的数字", () => {
    expect(validateRuntimeSettings({ context_window: "10" })).toEqual(["context_window must be at least 1024"]);
    expect(validateRuntimeSettings({ context_window: "1.5" })).toEqual(["context_window must be an integer"]);
    expect(validateRuntimeSettings({ max_output_tokens: "999999" })).toEqual(["max_output_tokens must be at most 8192"]);
  });

  it("拒绝非布尔值", () => {
    expect(validateRuntimeSettings({ summary_enabled: "yes" })).toEqual(['summary_enabled must be "true" or "false"']);
  });

  it("校验字符串类型的枚举与长度", () => {
    expect(validateRuntimeSettings({ model: "gpt-4o" })).toEqual([]);
    expect(validateRuntimeSettings({ response_language: "zh-CN" })).toEqual([]);
    expect(validateRuntimeSettings({ model: "   " })).toEqual(["model must not be empty"]);
    expect(validateRuntimeSettings({ response_language: "fr" })).toEqual(["response_language must be one of en, zh-CN"]);
    expect(validateRuntimeSettings({ model: "x".repeat(201) })).toEqual(["model must be at most 200 characters"]);
  });

  it("校验列表项", () => {
    expect(validateRuntimeSettings({ gitlab_blocked_user_ids: "[7,8]" })).toEqual([]);
    expect(validateRuntimeSettings({ gitlab_blocked_user_ids: "[]" })).toEqual([]);
    expect(validateRuntimeSettings({ gitlab_blocked_user_ids: '["7"]' })).toEqual([]);
    expect(validateRuntimeSettings({ gitlab_blocked_user_ids: "[7.5]" })).toEqual([
      "gitlab_blocked_user_ids items must be positive integers",
    ]);
    expect(validateRuntimeSettings({ gitlab_blocked_user_ids: "7,8" })).toEqual([
      "gitlab_blocked_user_ids must be a JSON array",
    ]);
    expect(validateRuntimeSettings({ web_blocked_hosts: '["https://example.com/a"]' })).toEqual([
      "web_blocked_hosts items must be bare hostnames",
    ]);
    expect(validateRuntimeSettings({ web_blocked_hosts: '["example.com"]' })).toEqual([]);
  });

  it("校验带单位的时长", () => {
    expect(validateRuntimeSettings({ agent_request_timeout: "600" })).toEqual([]);
    expect(validateRuntimeSettings({ agent_request_timeout: "0" })).toEqual([
      "agent_request_timeout must be at least 1",
    ]);
    expect(validateRuntimeSettings({ worker_poll_interval: "1.5" })).toEqual([]);
  });

  it("校验跨字段约束", () => {
    expect(validateRuntimeSettings({ context_window: "8000", max_input_tokens: "8000" }))
      .toEqual(["max_input_tokens must be 0 or less than context_window"]);
    expect(validateRuntimeSettings({ context_window: "8000", compaction_reserve_tokens: "9000" }))
      .toEqual(["compaction_reserve_tokens must be less than context_window"]);
  });
});

describe("applyRuntimeSettings", () => {
  it("把覆盖项写回配置对象的对应字段", () => {
    const config = settingsConfig();
    applyRuntimeSettings(config, {
      context_window: "200000",
      summary_enabled: "false",
      max_output_tokens: "2048",
      review_max_files: "42",
      fix_enabled: "true",
      model: "gpt-4o",
      response_language: "zh-CN",
      agent_request_timeout: "300",
      gitlab_blocked_user_ids: "[7,8]",
      web_blocked_hosts: '["example.com","example.org"]',
      skill_paths: '["/opt/skills"]',
    });
    expect(config.agent.contextWindow).toBe(200_000);
    expect(config.agent.summaryEnabled).toBe(false);
    expect(config.agent.maxOutputTokens).toBe(2_048);
    expect(config.review.maxFiles).toBe(42);
    expect(config.fix.enabled).toBe(true);
    expect(config.agent.model).toBe("gpt-4o");
    expect(config.agent.responseLanguage).toBe("zh-CN");
    // 界面单位是秒，配置内部仍是毫秒。
    expect(config.agent.requestTimeout).toBe(300_000);
    expect(config.gitlab.blockedUserIds).toEqual([7, 8]);
    expect(config.agent.webBlockedHosts).toEqual(["example.com", "example.org"]);
    expect(config.agent.skillPaths).toEqual(["/opt/skills"]);
  });

  it("忽略未知键与未覆盖的字段", () => {
    const config = settingsConfig();
    const before = config.agent.model;
    applyRuntimeSettings(config, { nope: "1" });
    expect(config.agent.model).toBe(before);
  });
});

describe("applyActiveModel", () => {
  it("把选中模型的供应商展示名与连接参数一并写入运行时配置", () => {
    const config = { agent: agentConfig() } as CorvexConfig;
    const now = "2026-01-01T00:00:00.000Z";
    applyActiveModel(config, {
      provider: {
        id: "provider-1",
        name: "Acme Models",
        baseUrl: "https://acme.example/v1",
        apiKey: "secret",
        createdAt: now,
        updatedAt: now,
      },
      model: {
        id: "model-1",
        providerId: "provider-1",
        name: "gpt-4.1",
        contextWindow: 65_536,
        maxOutputTokens: 2_048,
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    expect(config.agent).toMatchObject({
      model: "gpt-4.1",
      providerName: "Acme Models",
      baseUrl: "https://acme.example/v1",
      apiKey: "secret",
      contextWindow: 65_536,
      maxOutputTokens: 2_048,
    });
  });
});

describe("applyRuntimeSettingRows", () => {
  it("应用合法行并跳过损坏行", () => {
    const config = settingsConfig();
    const applied = applyRuntimeSettingRows(config, [
      { key: "review_max_findings", value: "12" },
      { key: "unknown_key", value: "1" },
      { key: "context_window", value: "not-a-number" },
    ]);
    expect(applied).toEqual(["review_max_findings"]);
    expect(config.review.maxFindings).toBe(12);
    expect(config.agent.contextWindow).toBe(131_072);
  });
});

describe("runtimeSettingsView", () => {
  it("把配置字段映射为设置键", () => {
    const view = runtimeSettingsView(settingsConfig());
    expect(view).toMatchObject({
      context_window: 131_072,
      history_token_budget: 24_000,
      summary_enabled: true,
      review_max_files: 100,
      fix_max_patch_bytes: 128 << 10,
      agent_request_timeout: 120,
      worker_poll_interval: 2,
      gitlab_blocked_user_ids: ["7"],
      web_blocked_hosts: [],
    });
  });
});

describe("runtimeSettingsEffective", () => {
  it("推导输入上限、工具预算与压缩阈值", () => {
    const config = settingsConfig();
    const view = runtimeSettingsEffective(config);
    expect(view.effective.max_input_tokens).toBe(131_072 - 4_096 - 2_000);
    expect(view.effective.turn_tool_result_bytes).toBe(256 << 10);
    expect(view.effective.compaction_reserve_tokens).toBe(40_960);
    expect(view.derived).toMatchObject({
      toolRoundBytes: 64 << 10,
      toolCallBytes: 32 << 10,
      compactionTriggerTokens: 131_072 - 40_960,
    });
    expect(view.adjusted).toContain("compaction_reserve_tokens");
  });

  it("配置值更大时按配置生效", () => {
    const config = settingsConfig();
    config.agent.turnToolResultBytes = 32 << 10;
    config.agent.compactionReserveTokens = 64 << 10;
    config.agent.maxInputTokens = 90_000;
    const view = runtimeSettingsEffective(config);
    expect(view.effective.turn_tool_result_bytes).toBe(32 << 10);
    expect(view.effective.compaction_reserve_tokens).toBe(64 << 10);
    expect(view.effective.max_input_tokens).toBe(90_000);
    expect(view.adjusted).toEqual([]);
  });
});

describe("copyRuntimeSettings", () => {
  it("把可编辑字段从源配置复制到目标配置", () => {
    const from = settingsConfig();
    from.agent.contextWindow = 300_000;
    from.agent.summaryEnabled = false;
    from.review.maxFiles = 10;
    const to = settingsConfig();
    copyRuntimeSettings(from, to);
    expect(to.agent.contextWindow).toBe(300_000);
    expect(to.agent.summaryEnabled).toBe(false);
    expect(to.review.maxFiles).toBe(10);
  });
});

describe("isRuntimeSettingKey", () => {
  it("只识别已知设置键", () => {
    expect(isRuntimeSettingKey("context_window")).toBe(true);
    expect(isRuntimeSettingKey("model")).toBe(true);
    expect(isRuntimeSettingKey("base_url")).toBe(false);
  });
});

describe("设置页与服务端设置键的一致性", () => {
  // hidden 是升级兼容的旧模型键，模型列表接管后不再展示，也不要求出现在界面上。
  const serverKeys = runtimeSettingDefinitions.filter((definition) => !definition.hidden).map((definition) => definition.key);
  const uiFields = settingGroups.flatMap((group) => group.fields);

  it("设置页只暴露服务端接受的键", () => {
    expect(uiFields.map((field) => field.key).filter((key) => !isRuntimeSettingKey(key))).toEqual([]);
  });

  it("设置页覆盖每一个可覆盖的服务端键，避免遗漏", () => {
    expect(new Set(uiFields.map((field) => field.key))).toEqual(new Set(serverKeys));
  });

  it("隐藏键不出现在设置页", () => {
    const hidden = runtimeSettingDefinitions.filter((definition) => definition.hidden).map((definition) => definition.key);
    expect(hidden.length).toBeGreaterThan(0);
    expect(uiFields.map((field) => field.key).filter((key) => hidden.includes(key))).toEqual([]);
  });

  it("设置页的键在界面中唯一", () => {
    const keys = uiFields.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("布尔字段与服务端类型一致", () => {
    for (const field of uiFields) {
      const definition = runtimeSettingDefinitions.find((item) => item.key === field.key);
      expect(definition?.type, field.key).toBe(field.kind);
    }
  });
});
