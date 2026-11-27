/**
 * 会话文本附件的共享常量与 URL 构造：纯函数、无 Node 依赖，浏览器与服务端共用，
 * 避免前后端各写一份限额导致行为漂移。
 */

/** 单文件默认上限，与 read_file 的 maxReadBytes 对齐（256 KiB）。 */
export const maxUploadBytes = 256 << 10;
/** 单个图片附件的默认上限（4 MiB），与 SDK 的 Base64 自动缩放上限对齐。 */
export const imageUploadMaxBytes = 4 << 20;
/** 请求体硬顶：覆盖文本与图片两种上限，Fastify bodyLimit 用它。 */
export const maxUploadBytesCeiling = 8 << 20;
/** 单条消息最多附带的图片数；与文本附件共享同一上限时取更小值。 */
export const maxImagesPerMessage = 5;
/** 单条消息默认最多附带的附件数。 */
export const maxUploadsPerMessage = 10;
/** 单个会话默认累计保留的附件数；已发送附件仍占额度，留足余量避免误伤多轮协作。 */
export const maxUploadsPerConversation = 100;
/** 专用 content-type：避开 application/json（API body）与 application/zip（技能包）。 */
export const uploadContentType = "application/x-corvex-upload";

/** 已上传、等待随消息发送的附件摘要。 */
export interface PendingAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  /** 服务端按字节检测出的真实 MIME；image/* 表示图片附件。 */
  mime: string;
}

/** 构造上传端点 URL；文件名与 MIME 走 query，正文走原始 body。 */
export function uploadUrl(conversationId: string, filename: string, mime: string): string {
  const query = new URLSearchParams({ filename, mime });
  return `/api/ops/conversations/${encodeURIComponent(conversationId)}/uploads?${query.toString()}`;
}
