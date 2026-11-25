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
