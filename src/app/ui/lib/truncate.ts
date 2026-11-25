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

/**
 * 按实际字宽把长文本拆成尽量等宽的开头与结尾，中间由调用方插入省略号。
 * `measure` 由调用方提供（通常是 canvas 的 measureText），因此中文与等宽字体都能正确计算。
 */
export function fitMiddleEllipsis(
  text: string,
  measure: (value: string) => number,
  availableWidth: number,
  ellipsis = "...",
): { head: string; tail: string } {
  if (availableWidth <= 0) return { head: "", tail: "" };
  if (measure(text) <= availableWidth) return { head: text, tail: "" };
  const budget = Math.max(1, (availableWidth - measure(ellipsis)) / 2);
  const chars = [...text];
  let head = "";
  let headWidth = 0;
  for (const char of chars) {
    const width = measure(char);
    if (headWidth + width > budget) break;
    head += char;
    headWidth += width;
  }
  let tail = "";
  let tailWidth = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const width = measure(char);
    if (tailWidth + width > budget) break;
    tail = char + tail;
    tailWidth += width;
  }
  if (!head) head = chars[0] ?? "";
  if (!tail) tail = chars.at(-1) ?? "";
  return { head, tail };
}
