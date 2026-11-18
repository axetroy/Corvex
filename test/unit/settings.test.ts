import { describe, expect, it } from "vitest";
import {
  applyRuntimeSettings,
  copyRuntimeSettings,
  isRuntimeSettingKey,
  runtimeSettingDefinitions,
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

describe("validateRuntimeSettings", () => {
  it("接受合法覆盖项", () => {
    expect(validateRuntimeSettings({ context_window: "200000", summary_enabled: "false" })).toEqual([]);
  });

  it("拒绝未知键", () => {
    expect(validateRuntimeSettings({ nope: "1" })).toEqual(['unknown setting "nope"']);
  });

  it("拒绝越界与类型错误的数字", () => {
    expect(validateRuntimeSettings({ context_window: "10" })).toEqual(["context_window must be at least 1024"]);
    expect(validateRuntimeSettings({ context_window: "1.5" })).toEqual(["context_window must be an integer"]);
    expect(validateRuntimeSettings({ max_output_tokens: "999999" })).toEqual(["max_output_tokens must be at most 8192"]);
  });

  it("拒绝非布尔值", () => {
    expect(validateRuntimeSettings({ summary_enabled: "yes" })).toEqual(['summary_enabled must be "true" or "false"']);
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
    const config = { agent: agentConfig() } as CorvexConfig;
    applyRuntimeSettings(config, { context_window: "200000", summary_enabled: "false", max_output_tokens: "2048" });
    expect(config.agent.contextWindow).toBe(200_000);
    expect(config.agent.summaryEnabled).toBe(false);
    expect(config.agent.maxOutputTokens).toBe(2_048);
  });

  it("忽略未知键与未覆盖的字段", () => {
    const config = { agent: agentConfig() } as CorvexConfig;
    const before = config.agent.model;
    applyRuntimeSettings(config, { nope: "1" });
    expect(config.agent.model).toBe(before);
  });
});

describe("runtimeSettingsView", () => {
  it("把配置字段映射为设置键", () => {
    const view = runtimeSettingsView(agentConfig());
    expect(view).toMatchObject({
      context_window: 131_072,
      history_token_budget: 24_000,
      summary_enabled: true,
    });
  });
});

describe("copyRuntimeSettings", () => {
  it("把可编辑字段从源配置复制到目标配置", () => {
    const from = agentConfig();
    from.contextWindow = 300_000;
    from.summaryEnabled = false;
    const to = agentConfig();
    copyRuntimeSettings(from, to);
    expect(to.contextWindow).toBe(300_000);
    expect(to.summaryEnabled).toBe(false);
  });
});

describe("isRuntimeSettingKey", () => {
  it("只识别已知设置键", () => {
    expect(isRuntimeSettingKey("context_window")).toBe(true);
    expect(isRuntimeSettingKey("model")).toBe(false);
  });
});

describe("设置页与服务端设置键的一致性", () => {
  const serverKeys = runtimeSettingDefinitions.map((definition) => definition.key);
  const uiFields = settingGroups.flatMap((group) => group.fields);

  it("设置页只暴露服务端接受的键", () => {
    expect(uiFields.map((field) => field.key).filter((key) => !isRuntimeSettingKey(key))).toEqual([]);
  });

  it("设置页覆盖每一个可覆盖的服务端键，避免遗漏", () => {
    expect(new Set(uiFields.map((field) => field.key))).toEqual(new Set(serverKeys));
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
