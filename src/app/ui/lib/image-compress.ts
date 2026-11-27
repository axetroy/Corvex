import { compressedImageTargetBytes } from "../../../upload-constants.js";

/**
 * 纯浏览器图片压缩：用 canvas 降采样并重新编码，避免把原图 base64 直传撑爆请求预算。
 * 不依赖任何原生模块；原图不再上传，预览看到的也是压缩后的版本。
 */

export interface CompressedImage {
  data: ArrayBuffer;
  mime: string;
  filename: string;
  originalBytes: number;
  width: number;
  height: number;
}

/** 长边上限，与主流 Agent 的标准视觉档一致（约 1600 tokens）。 */
const maxImageEdge = 1568;
/** 质量与尺寸迭代的下限，防止无限循环。 */
const minImageEdge = 512;
const minQuality = 0.5;

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") return await createImageBitmap(file);
  // 老浏览器回退：object URL + Image，释放时由调用方 close()。
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sizeOf(source: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas encoding failed"));
    }, mime, quality);
  });
}

function replaceExtension(filename: string, mime: string): string {
  const extension = mime === "image/webp" ? "webp" : "jpg";
  return filename.replace(/\.[^.]+$/, "") + `.${extension}`;
}

/** 压缩到目标字节数内；GIF（可能是动图）原样返回，避免丢帧。 */
export async function compressImageForUpload(file: File): Promise<CompressedImage> {
  if (file.type.toLowerCase() === "image/gif") {
    return {
      data: await file.arrayBuffer(), mime: file.type, filename: file.name,
      originalBytes: file.size, width: 0, height: 0,
    };
  }
  const source = await decode(file);
  try {
    const original = sizeOf(source);
    let scale = Math.min(1, maxImageEdge / Math.max(original.width, original.height, 1));
    let quality = 0.82;
    const canvas = document.createElement("canvas");
    let blob: Blob | undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const width = Math.max(1, Math.round(original.width * scale));
      const height = Math.max(1, Math.round(original.height * scale));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas is unavailable");
      // WebP 保留透明通道且体积更小；不支持时退回 JPEG（透明区域填白）。
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);
      const mime = canvas.toDataURL("image/webp").startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
      blob = await toBlob(canvas, mime, quality);
      if (blob.size <= compressedImageTargetBytes) break;
      if (Math.max(width, height) > minImageEdge) scale *= 0.82;
      else quality = Math.max(minQuality, quality - 0.1);
      if (quality <= minQuality && Math.max(width, height) <= minImageEdge) break;
    }
    if (!blob) throw new Error("image compression failed");
    return {
      data: await blob.arrayBuffer(),
      mime: blob.type || "image/jpeg",
      filename: replaceExtension(file.name, blob.type || "image/jpeg"),
      originalBytes: file.size,
      width: canvas.width,
      height: canvas.height,
    };
  } finally {
    if (typeof (source as ImageBitmap).close === "function") (source as ImageBitmap).close();
  }
}
