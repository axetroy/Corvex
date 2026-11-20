import { describe, expect, it } from "vitest";
import {
  activeModelSelection,
  findModelSelection,
  modelOptionValue,
  modelSelections,
  modelSelectGroups,
} from "../../src/app/ui/modelPicker.ts";
import type { ModelProviderDetails, ProviderModel } from "../../src/app/ui/types.ts";

function model(id: string, name: string, active = false): ProviderModel {
  return {
    id,
    providerId: "provider",
    name,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    active,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function provider(id: string, name: string, models: ProviderModel[]): ModelProviderDetails {
  return {
    id,
    name,
    baseUrl: "https://example.com/v1",
    apiKey: "••••••",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    models,
  };
}

const catalog: ModelProviderDetails[] = [
  provider("openai", "OpenAI", [model("gpt-4.1", "gpt-4.1", true), model("gpt-4o", "gpt-4o")]),
  provider("empty", "Empty", []),
  provider("local", "Local", [model("qwen3", "qwen3")]),
];

describe("operations UI model picker", () => {
  it("encodes a selection value from the provider and model ids", () => {
    expect(modelOptionValue("openai", "gpt-4.1")).toBe("openai/gpt-4.1");
  });

  it("flattens the catalog into provider/model pairs", () => {
    expect(modelSelections(catalog).map(({ model: entry }) => entry.name)).toEqual([
      "gpt-4.1",
      "gpt-4o",
      "qwen3",
    ]);
  });

  it("finds the single active model", () => {
    const active = activeModelSelection(catalog);
    expect(active?.provider.name).toBe("OpenAI");
    expect(active?.model.name).toBe("gpt-4.1");
    expect(activeModelSelection([provider("empty", "Empty", [])])).toBeUndefined();
  });

  it("locates a model by its selection value", () => {
    expect(findModelSelection(catalog, "local/qwen3")?.model.name).toBe("qwen3");
    expect(findModelSelection(catalog, "local/missing")).toBeUndefined();
  });

  it("groups options by provider and skips providers without models", () => {
    expect(modelSelectGroups(catalog)).toEqual([
      {
        label: "OpenAI",
        options: [
          { label: "gpt-4.1", value: "openai/gpt-4.1" },
          { label: "gpt-4o", value: "openai/gpt-4o" },
        ],
      },
      { label: "Local", options: [{ label: "qwen3", value: "local/qwen3" }] },
    ]);
  });
});
