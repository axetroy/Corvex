/** 判断外部数据是否为非数组对象，用于在边界处收窄 unknown。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
