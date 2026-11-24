import type { ModelProviderDetails, ProviderModel } from "./types.js";

/** 思考等级下拉项：值是与 Pi SDK 一致的稳定标识，文案 key 直接写在源码便于 i18n 完整性检查。 */
export const thinkingLevelOptions = [
  { value: "off", labelKey: "thinkingLevelOff" },
  { value: "minimal", labelKey: "thinkingLevelMinimal" },
  { value: "low", labelKey: "thinkingLevelLow" },
  { value: "medium", labelKey: "thinkingLevelMedium" },
  { value: "high", labelKey: "thinkingLevelHigh" },
  { value: "xhigh", labelKey: "thinkingLevelXhigh" },
  { value: "max", labelKey: "thinkingLevelMax" },
] as const;

/** 输入框模型选择项的取值：`<供应商 ID>/<模型 ID>`，两者都是服务端生成的 UUID。 */
export function modelOptionValue(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** 一个可选中的模型，保留其所属供应商以便切换时构造接口路径。 */
export interface ModelSelection {
  provider: ModelProviderDetails;
  model: ProviderModel;
}

/** 把上下文窗口格式化为 K 单位（1K = 1024 tokens）。 */
export function formatContextWindowK(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "-";
  if (tokens < 1024) return `${tokens}`;
  const k = tokens / 1024;
  return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10}K`;
}

/** 摊平供应商目录；全局只有一个模型处于使用中。 */
export function modelSelections(providers: readonly ModelProviderDetails[]): ModelSelection[] {
  return providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
}

/** 当前使用中的模型；目录为空或尚未选择时返回 undefined。 */
export function activeModelSelection(providers: readonly ModelProviderDetails[]): ModelSelection | undefined {
  return modelSelections(providers).find(({ model }) => model.active);
}

/** 按选择项取值定位模型，用于处理下拉框的选中回调。 */
export function findModelSelection(
  providers: readonly ModelProviderDetails[],
  value: string,
): ModelSelection | undefined {
  return modelSelections(providers).find(
    ({ provider, model }) => modelOptionValue(provider.id, model.id) === value,
  );
}

/** 下拉框分组：每个供应商一组，没有模型的供应商不展示。 */
export interface ModelSelectGroup {
  label: string;
  /** 系统级供应商：共享且对所有用户可读。 */
  system: boolean;
  options: Array<{ label: string; value: string; context: string }>;
}

/** 把供应商目录转换成下拉框分组，供应商顺序即服务端返回顺序。 */
export function modelSelectGroups(providers: readonly ModelProviderDetails[]): ModelSelectGroup[] {
  return providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      label: provider.name,
      system: provider.ownerUserId === "",
      options: provider.models.map((model) => ({
        label: model.name,
        value: modelOptionValue(provider.id, model.id),
        context: formatContextWindowK(model.contextWindow),
      })),
    }));
}
