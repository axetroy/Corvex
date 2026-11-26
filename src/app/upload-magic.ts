/** 按真实字节识别上传物类型：不信任文件名与声明的 MIME。 */

export type UploadByteKind = "text" | "image" | "pdf" | "archive" | "executable" | "binary";

const signatures: readonly { kind: UploadByteKind; bytes: readonly number[] }[] = [
  { kind: "image", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }, // PNG
  { kind: "image", bytes: [0xff, 0xd8, 0xff] }, // JPEG
  { kind: "image", bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF87a/89a
  { kind: "image", bytes: [0x42, 0x4d] }, // BMP
  { kind: "image", bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF（WebP/AVI，下面再确认 WEBP）
  { kind: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF-
  { kind: "archive", bytes: [0x50, 0x4b, 0x03, 0x04] }, // ZIP
  { kind: "archive", bytes: [0x1f, 0x8b] }, // gzip
  { kind: "archive", bytes: [0x42, 0x5a, 0x68] }, // bzip2
  { kind: "archive", bytes: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00] }, // xz
  { kind: "executable", bytes: [0x4d, 0x5a] }, // MZ（PE/DOS）
  { kind: "executable", bytes: [0x23, 0x21] }, // #! 脚本
  { kind: "executable", bytes: [0xca, 0xfe, 0xba, 0xbe] }, // Java class
  { kind: "executable", bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
];

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * 纯文本判定：无 NUL、可按严格 UTF-8 解码，且不包含已知二进制/可执行头。
 * 魔数优先于扩展名与声明的 MIME。
 */
export function detectUploadKind(bytes: Buffer): UploadByteKind {
  if (bytes.length === 0) return "binary";
  for (const signature of signatures) {
    if (!startsWith(bytes, signature.bytes)) continue;
    // RIFF 只有 WEBP 才是图片，其余按二进制处理。
    if (signature.kind === "image" && startsWith(bytes, [0x52, 0x49, 0x46, 0x46])) {
      return bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image" : "binary";
    }
    return signature.kind;
  }
  if (bytes.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "binary";
  }
  return "text";
}
