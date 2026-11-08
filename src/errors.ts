/** 把未知的抛出值转换为可展示、可记录的错误文本。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
