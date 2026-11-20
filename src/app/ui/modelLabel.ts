/** 早期版本把 Pi 的内部 Provider ID 写进了消息与轨迹的展示字段。 */
const internalProviderPrefix = "corvex-openai-compatible/";

/**
 * 归一化模型展示名：新数据由服务端写入“供应商/模型”，旧数据带内部 Provider ID，
 * 渲染时去掉该前缀，避免界面出现与设置无关的固定供应商名。
 */
export function displayModelName(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim();
  return trimmed.startsWith(internalProviderPrefix)
    ? trimmed.slice(internalProviderPrefix.length)
    : trimmed;
}
