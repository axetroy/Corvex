/**
 * 路由地址（不含 `#`）：应用由 react-router 的 HashRouter 驱动，
 * 这里只保留把页面状态序列化为路径/查询串的纯函数，避免各处手写 URL。
 */

/** 对话地址；有 ID 时聚焦该对话，否则进入新建/欢迎态。 */
export function conversationsPath(id = ""): string {
  return id ? `/conversations/${encodeURIComponent(id)}` : "/conversations";
}

/** 管理后台子页面地址。 */
export function adminPath(section: string): string {
  return `/admin/${section}`;
}

/** 页面种类，供侧栏选中态、主区域布局与“未知路由回对话页”守卫使用。 */
export type PageKind = "conversations" | "settings" | "scheduled" | "unknown";

/** 把 hash 路由路径归类；计划任务必须被识别为已知页面，否则会被守卫重定向到对话页。 */
export function pageKindOf(pathname: string): PageKind {
  const path = pathname.replace(/^\/+/, "");
  if (path === "" || path === "conversations" || path.startsWith("conversations/")) return "conversations";
  if (path === "settings") return "settings";
  if (path === "scheduled-tasks") return "scheduled";
  return "unknown";
}
