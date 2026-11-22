/** 输入框历史：最新一条在最前，去重且有上限，写入失败只忽略。 */
export const inputHistoryLimit = 100;

type HistoryStorage = Pick<Storage, "getItem" | "setItem">;

export function appendInputHistory(history: readonly string[], message: string): string[] {
  const value = message.trim();
  if (!value) return [...history];
  return [value, ...history.filter((item) => item !== value)].slice(0, inputHistoryLimit);
}

export function readInputHistory(storage: HistoryStorage, key: string): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, inputHistoryLimit);
  } catch {
    return [];
  }
}

export function writeInputHistory(storage: HistoryStorage, key: string, history: readonly string[]): void {
  try {
    storage.setItem(key, JSON.stringify(history));
  } catch {
    // 隐私模式下 localStorage 不可写；历史只在当前会话内保留。
  }
}
