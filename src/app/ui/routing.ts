import { jobTypes, statuses } from "./types.js";
import type { JobQueue } from "./types.js";

/** 运维台页面路由，由地址栏 hash 解析得到。 */
export type Route =
  | { kind: "overview" }
  | { kind: "jobs" }
  | { kind: "job"; id: string }
  | { kind: "unknown" };

/** 解析结果：页面路由与查询参数（任务列表筛选条件）。 */
export interface ParsedHash {
  page: Route;
  params: URLSearchParams;
}

/** 解码路由中的任务 ID；非法转义返回 undefined。 */
export function decodeJobId(value: string): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** 解析 hash 的路径部分；无法识别的路径与缺失/非法任务 ID 返回 `unknown`。 */
function parsePath(route: string): Route {
  if (route === "" || route === "overview") return { kind: "overview" };
  if (route === "jobs") return { kind: "jobs" };
  if (route.startsWith("jobs/")) {
    const id = decodeJobId(route.slice("jobs/".length));
    return id ? { kind: "job", id } : { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/** 把地址栏 hash 解析为页面路由与查询参数；空 hash 视为概览。 */
export function parseHash(hash: string): ParsedHash {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf("?");
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : raw.slice(queryIndex + 1);
  return { page: parsePath(path), params: new URLSearchParams(query) };
}

/** 从查询参数还原筛选条件；非法状态、类型与偏移回退为默认值。 */
export function jobQueueFromParams(params: URLSearchParams): JobQueue {
  const status = params.get("status") ?? "";
  const type = params.get("type") ?? "";
  const search = (params.get("search") ?? "").slice(0, 100);
  const offsetValue = Number(params.get("offset") ?? "0");
  return {
    status: (statuses as readonly string[]).includes(status) ? status : "",
    type: (jobTypes as readonly string[]).includes(type) ? type : "",
    search,
    offset: Number.isSafeInteger(offsetValue) && offsetValue > 0 ? offsetValue : 0,
  };
}

/** 把筛选条件序列化为 hash 查询串；空条件不写入，保持默认 URL 简洁。 */
export function jobQueueQuery(queue: JobQueue): string {
  const params = new URLSearchParams();
  if (queue.status) params.set("status", queue.status);
  if (queue.type) params.set("type", queue.type);
  if (queue.search) params.set("search", queue.search);
  if (queue.offset > 0) params.set("offset", String(queue.offset));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** 任务列表的 hash，导航与筛选更新共用。 */
export function jobsHash(queue: JobQueue): string {
  return `#jobs${jobQueueQuery(queue)}`;
}

/** 任务详情 hash，携带列表筛选条件以便返回时恢复。 */
export function jobHash(id: string, queue: JobQueue): string {
  return `#jobs/${encodeURIComponent(id)}${jobQueueQuery(queue)}`;
}

/** 详情页返回列表的 hash。 */
export function jobsBackHash(params: URLSearchParams): string {
  const query = params.toString();
  return `#jobs${query ? `?${query}` : ""}`;
}
