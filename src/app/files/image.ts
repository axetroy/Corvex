/**
 * 文件浏览器的图片类型判定；这个模块不依赖 Node API，浏览器与服务端共用。
 * 仅按扩展名做「是否尝试预览」的判断，真正的 MIME 由服务端按文件头校验。
 */

/** 允许预览的图片扩展名（小写，含点）。 */
const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg"];

/** 路径看起来是图片时返回 true；仅用于决定是否走图片预览端点。 */
export function isImagePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return imageExtensions.some((extension) => normalized.endsWith(extension));
}
