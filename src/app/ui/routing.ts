import { eventTypes, statuses } from "./types.js";
import type { EventQueue } from "./types.js";

/**
 * 路由地址（不含 `#`）：应用由 react-router 的 HashRouter 驱动，
 * 这里只保留把页面状态序列化为路径/查询串的纯函数，避免各处手写 URL。
 */

/** 从查询参数还原筛选条件；非法状态、类型与偏移回退为默认值。 */
export function eventQueueFromParams(params: URLSearchParams): EventQueue {
  const status = params.get("status") ?? "";
  const type = params.get("type") ?? "";
  const search = (params.get("search") ?? "").slice(0, 100);
  const offsetValue = Number(params.get("offset") ?? "0");
  return {
    status: (statuses as readonly string[]).includes(status) ? status : "",
    type: (eventTypes as readonly string[]).includes(type) ? type : "",
    search,
    offset: Number.isSafeInteger(offsetValue) && offsetValue > 0 ? offsetValue : 0,
  };
}

/** 把筛选条件序列化为查询串（不含 `?`），不写默认值，保持 URL 简洁。 */
export function eventQueueQuery(queue: EventQueue): string {
  const params = new URLSearchParams();
  if (queue.status) params.set("status", queue.status);
  if (queue.type) params.set("type", queue.type);
  if (queue.search) params.set("search", queue.search);
  if (queue.offset > 0) params.set("offset", String(queue.offset));
  return params.toString();
}

function withQuery(path: string, query: string): string {
  return query ? `${path}?${query}` : path;
}

/** 事件列表地址。 */
export function eventsPath(queue: EventQueue): string {
  return withQuery("/events", eventQueueQuery(queue));
}

/** 对话地址；有 ID 时聚焦该对话，否则进入新建/欢迎态。 */
export function conversationsPath(id = ""): string {
  return id ? `/conversations/${encodeURIComponent(id)}` : "/conversations";
}

/** 事件详情地址，携带列表筛选条件以便返回时还原。 */
export function eventPath(id: string, queue: EventQueue): string {
  return withQuery(`/events/${encodeURIComponent(id)}`, eventQueueQuery(queue));
}

/** 事件列表的返回地址，沿用详情 URL 上的查询串。 */
export function eventsBackPath(params: URLSearchParams): string {
  return withQuery("/events", params.toString());
}

/** 管理后台子页面地址。 */
export function adminPath(section: string): string {
  return `/admin/${section}`;
}
