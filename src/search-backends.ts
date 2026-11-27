/** 前后端共用的免费搜索后端 ID 列表；纯常量，不引入运行时依赖。 */
export const searchBackendIds = [
  "tavily", "exa", "you", "wikipedia", "hackernews", "duckduckgo", "searxng",
] as const;

export type SearchBackendId = (typeof searchBackendIds)[number];
