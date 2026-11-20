/** 为中间省略号保留的尾部字符数：路径的末段通常足以辨认文件。 */
const defaultTailChars = 20;

/**
 * 把长文本拆成「前半段 + 尾部」，前半段交给 CSS 裁剪，中间用显式省略号连接，
 * 这样无论容器多窄都能同时看到开头和结尾。短文本原样返回。
 */
export function splitForMiddleEllipsis(text: string, tailChars = defaultTailChars): { head: string; tail: string } {
  if (!Number.isSafeInteger(tailChars) || tailChars < 1) return { head: text, tail: "" };
  if (text.length <= tailChars * 2) return { head: text, tail: "" };
  return { head: text.slice(0, text.length - tailChars), tail: text.slice(-tailChars) };
}
