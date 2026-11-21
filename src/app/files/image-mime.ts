/** 图片预览的 Node 侧格式校验，供 GitLab 与本地 worktree 两个适配器共用。 */

/** 图片预览上限：GitLab 的 base64 响应仍受 20 MiB 的 HTTP 响应上限保护。 */
export const MAX_IMAGE_BYTES = 12 << 20;

/** 各 MIME 允许的扩展名；检测出的文件头必须与扩展名一致，避免伪装成图片的任意文件。 */
const imageExtensionsByMime: Record<string, readonly string[]> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/bmp": [".bmp"],
  "image/avif": [".avif"],
  "image/x-icon": [".ico"],
  "image/svg+xml": [".svg"],
};

/**
 * SVG 是文本，文件头可能是 XML 声明、注释或 DOCTYPE 的组合；先剥掉这些前导节点，
 * 再确认根元素是 svg。用较大窗口兼容带版权注释的导出文件。
 */
function isSvg(bytes: Buffer): boolean {
  const text = bytes.subarray(0, 4_096).toString("utf8").replace(/^\uFEFF/, "");
  const root = text.replace(
    /^(?:\s*<\?xml[\s\S]*?\?>|\s*<!--[\s\S]*?-->|\s*<!DOCTYPE[^>]*>|\s+)+/i,
    "",
  );
  return /^<svg[\s>]/i.test(root);
}

/** 按文件头识别图片，并要求扩展名与真实格式一致；非图片或伪装文件返回 null。 */
export function detectImageMime(path: string, bytes: Buffer): string | null {
  const matches = (offset: number, ...expected: number[]): boolean =>
    expected.every((value, index) => bytes[offset + index] === value);
  let mime: string | null = null;
  if (matches(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) mime = "image/png";
  else if (matches(0, 0xff, 0xd8, 0xff)) mime = "image/jpeg";
  else if (matches(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || matches(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) mime = "image/gif";
  else if (matches(0, 0x52, 0x49, 0x46, 0x46) && matches(8, 0x57, 0x45, 0x42, 0x50)) mime = "image/webp";
  else if (matches(0, 0x42, 0x4d)) mime = "image/bmp";
  else if (matches(4, 0x66, 0x74, 0x79, 0x70) && matches(8, 0x61, 0x76, 0x69, 0x66)) mime = "image/avif";
  // ICO/ANI 的 ICONDIR 头保留，扩展名由下面的映射限定为 .ico。
  else if (matches(0, 0x00, 0x00, 0x01, 0x00)) mime = "image/x-icon";
  else if (isSvg(bytes)) mime = "image/svg+xml";
  if (!mime) return null;
  const lower = path.toLowerCase();
  return imageExtensionsByMime[mime]?.some((extension) => lower.endsWith(extension)) ? mime : null;
}
