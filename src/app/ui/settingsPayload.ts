import type { SettingField, SettingValue } from "./types.js";

/**
 * 构造提交给服务端的设置负载。
 *
 * 只写回服务端在 `GET /api/ops/settings` 里实际报告过的键：前端 bundle 可能比服务端先更新
 * （灰度发布或忘记重启），此时提交新键会触发 `unknown setting` 并让整次保存失败。
 */
export function buildSettingsPayload(
  groups: readonly { fields: readonly SettingField[] }[],
  draft: Readonly<Record<string, SettingValue>>,
  knownKeys: ReadonlySet<string>,
): Record<string, SettingValue> {
  const payload: Record<string, SettingValue> = {};
  for (const group of groups) {
    for (const field of group.fields) {
      if (!knownKeys.has(field.key)) continue;
      const value = draft[field.key];
      if (value !== undefined) payload[field.key] = value;
    }
  }
  return payload;
}
