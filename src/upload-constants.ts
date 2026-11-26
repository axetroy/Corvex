/**
 * 会话文本附件的共享常量与 URL 构造：纯函数、无 Node 依赖，浏览器与服务端共用，
 * 避免前后端各写一份限额导致行为漂移。
 */

/** 单文件上限，与 read_file 的 maxReadBytes 对齐（256 KiB）。 */
export const maxUploadBytes = 256 << 10;
/** 单条消息最多附带的附件数。 */
export const maxUploadsPerMessage = 10;
/** 单个会话累计保留的附件数；已发送附件仍占额度，留足余量避免误伤多轮协作。 */
export const maxUploadsPerConversation = 100;
/** 专用 content-type：避开 application/json（API body）与 application/zip（技能包）。 */
export const uploadContentType = "application/x-corvex-upload";

/** 已上传、等待随消息发送的附件摘要。 */
export interface PendingAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
}

/** 构造上传端点 URL；文件名与 MIME 走 query，正文走原始 body。 */
export function uploadUrl(conversationId: string, filename: string, mime: string): string {
  const query = new URLSearchParams({ filename, mime });
  return `/api/ops/conversations/${encodeURIComponent(conversationId)}/uploads?${query.toString()}`;
}
