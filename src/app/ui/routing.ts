import { eventTypes, statuses } from "./types.js";
import type { EventQueue } from "./types.js";

/** 运维台页面路由，由地址栏 hash 解析得到。 */
export type Route =
  | { kind: "overview" }
  | { kind: "events" }
  | { kind: "conversations"; id?: string }
  | { kind: "event"; id: string }
  | { kind: "unknown" };

/** 解析结果：页面路由与查询参数（事件列表筛选条件）。 */
export interface ParsedHash {
  page: Route;
  params: URLSearchParams;
}

/** 解码路由中的事件 ID；非法转义返回 undefined。 */
export function decodeEventId(value: string): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** 解析 hash 的路径部分；无法识别的路径与缺失/非法事件 ID 返回 `unknown`。 */
function parsePath(route: string): Route {
  if (route === "" || route === "conversations") return { kind: "conversations" };
  if (route === "overview") return { kind: "overview" };
  if (route === "events") return { kind: "events" };
  if (route.startsWith("conversations/")) {
    const id = decodeEventId(route.slice("conversations/".length));
    return id ? { kind: "conversations", id } : { kind: "unknown" };
  }
  if (route.startsWith("events/")) {
    const id = decodeEventId(route.slice("events/".length));
    return id ? { kind: "event", id } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/** 把地址栏 hash 解析为页面路由与查询参数；空 hash 视为对话页。 */
export function parseHash(hash: string): ParsedHash {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf("?");
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : raw.slice(queryIndex + 1);
  return { page: parsePath(path), params: new URLSearchParams(query) };
}

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

/** 把筛选条件序列化为 hash 查询串；空条件不写入，保持默认 URL 简洁。 */
export function eventQueueQuery(queue: EventQueue): string {
  const params = new URLSearchParams();
  if (queue.status) params.set("status", queue.status);
  if (queue.type) params.set("type", queue.type);
  if (queue.search) params.set("search", queue.search);
  if (queue.offset > 0) params.set("offset", String(queue.offset));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** 事件列表的 hash，导航与筛选更新共用。 */
export function eventsHash(queue: EventQueue): string {
  return `#events${eventQueueQuery(queue)}`;
}

/** 对话页 hash；有 ID 时指向该对话，无 ID 时进入新建视图。 */
export function conversationsHash(id = ""): string {
  return id ? `#conversations/${encodeURIComponent(id)}` : "#conversations";
}

/** 事件详情 hash，携带列表筛选条件以便返回时恢复。 */
export function eventHash(id: string, queue: EventQueue): string {
  return `#events/${encodeURIComponent(id)}${eventQueueQuery(queue)}`;
}

/** 详情页返回列表的 hash。 */
export function eventsBackHash(params: URLSearchParams): string {
  const query = params.toString();
  return `#events${query ? `?${query}` : ""}`;
}
