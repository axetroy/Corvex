import { isIP } from "node:net";

/**
 * 子模块是仓库内的不可信数据：这里把所有 URL 都收敛到「配置 GitLab 同源」或
 * 「管理员显式放行且凭据隔离的 origin」，其余一律跳过，绝不跟随重定向。
 */

export interface SubmodulePolicy {
  /** 配置 GitLab 的 origin，形如 https://gitlab.example.com:8443 */
  gitlabOrigin: string;
  /** 管理员显式放行的 origin；bare host 按 https 解释。 */
  allowedOrigins: ReadonlySet<string>;
  /** 第三方 origin 的专用只读 token；用户 OAuth token 绝不会出现在这里。 */
  hostTokens: ReadonlyMap<string, string>;
}

export interface SubmodulePlanItem {
  path: string;
  sha: string;
  /** 经过校验重建的 URL：只含 origin 与合法项目路径。 */
  url: string;
  origin: string;
  /** true 表示可用登录用户的 GitLab token，false 表示匿名或专用 token。 */
  sameOrigin: boolean;
  token?: string;
}

export interface SkippedSubmodule {
  path: string;
  url: string;
  reason: "scheme" | "credentials" | "path" | "origin" | "private" | "invalid";
}

export interface SubmodulePlan {
  items: SubmodulePlanItem[];
  skipped: SkippedSubmodule[];
}

function originOf(url: URL): string | undefined {
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url.origin;
}

/** 把设置里的 host[:port] 或完整 URL 归一化为 origin；无 scheme 按 https。 */
export function normalizeAllowedOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (candidate.includes("/") && candidate.slice(candidate.indexOf("://") + 3).includes("/")) return undefined;
  return originOf(url);
}

/** 把管理员提交的 `{"https://git.example.com":"token"}` 解析为安全的 token 表。 */
export function parseSubmoduleHostTokens(raw: string): Map<string, string> {
  const tokens = new Map<string, string>();
  if (!raw.trim()) return tokens;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("submodule host tokens must be a JSON object");
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (tokens.size >= 50) throw new Error("submodule host tokens must contain at most 50 entries");
    const origin = normalizeAllowedOrigin(key);
    if (!origin) throw new Error(`invalid submodule token origin: ${key}`);
    if (typeof value !== "string" || !value.trim() || value.length > 2_000) {
      throw new Error(`invalid submodule token for ${key}`);
    }
    tokens.set(origin, value);
  }
  return tokens;
}

/** 只接受 Git 仓库路径：不允许空段、. / ..、反斜杠与控制字符。 */
function repositoryPath(url: URL): string | undefined {
  const raw = decodeURIComponent(url.pathname).replace(/^\/+/, "").replace(/\/+$/, "");
  const withoutGit = raw.endsWith(".git") ? raw.slice(0, -4) : raw;
  if (!withoutGit || withoutGit.length > 1_000) return undefined;
  const segments = withoutGit.split("/");
  if (segments.some((segment) =>
    !segment || segment === "." || segment === ".." || segment.includes("\\") ||
    [...segment].some((char) => char.charCodeAt(0) < 32),
  )) {
    return undefined;
  }
  return withoutGit;
}

/** 私有/回环/链路本地/保留地址：除非管理员显式放行具体 origin，否则拒绝。 */
export function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(host);
  if (version === 4) {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") ||
      host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb") ||
      host.startsWith("::ffff:") || host.startsWith("ff");
  }
  return false;
}

/** 校验并分类单条子模块 URL。 */
export function classifySubmoduleUrl(
  rawUrl: string,
  gitlabOrigin: string,
  policy: SubmodulePolicy,
): { item: Pick<SubmodulePlanItem, "url" | "origin" | "sameOrigin" | "token"> } | { reason: SkippedSubmodule["reason"] } {
  // URL 构造器会先把 /../ 与 %2e%2e 归一化，必须在解析前拦住，避免同源被绕过。
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  if (/%2e/i.test(rawUrl) || rawPath.split("/").some((segment) => segment === ".." || segment === ".")) {
    return { reason: "path" };
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { reason: "invalid" };
  }
  const origin = originOf(url);
  if (!origin) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return { reason: "scheme" };
    return { reason: url.username || url.password ? "credentials" : "scheme" };
  }
  const path = repositoryPath(url);
  if (!path) return { reason: "path" };
  const sameOrigin = origin === gitlabOrigin;
  if (!sameOrigin && !policy.allowedOrigins.has(origin)) {
    return { reason: isPrivateAddress(url.hostname) ? "private" : "origin" };
  }
  return {
    item: {
      url: `${origin}/${path}.git`,
      origin,
      sameOrigin,
      ...(!sameOrigin && policy.hostTokens.get(origin) ? { token: policy.hostTokens.get(origin) } : {}),
    },
  };
}

/** 解析 .gitmodules 的有限子集：只取 submodule 段的 path/url，限制条目数。 */
export function parseGitmodules(raw: string, maxEntries = 50, maxChars = 64_000): Map<string, string> {
  const result = new Map<string, string>();
  if (raw.length > maxChars) return result;
  let path = "";
  let url = "";
  const commit = () => {
    if (path && url && !result.has(path) && result.size < maxEntries) result.set(path, url);
    path = "";
    url = "";
  };
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (/^\[submodule\s+"/i.test(trimmed)) {
      commit();
      continue;
    }
    if (trimmed.startsWith("[")) {
      commit();
      continue;
    }
    const match = /^(path|url)\s*=\s*(.*)$/i.exec(trimmed);
    if (!match) continue;
    const value = match[2].trim().replace(/\s+#.*$/, "");
    if (match[1].toLowerCase() === "path") path = value;
    else url = value;
  }
  commit();
  return result;
}

/** 用树中的 gitlink 与 .gitmodules 取交集；gitlink 才是可信的「当前需要哪些子模块」。 */
export function buildSubmodulePlan(
  gitlinks: readonly { path: string; sha: string }[],
  gitmodules: Map<string, string>,
  gitlabOrigin: string,
  policy: SubmodulePolicy,
): SubmodulePlan {
  const items: SubmodulePlanItem[] = [];
  const skipped: SkippedSubmodule[] = [];
  for (const link of gitlinks) {
    const rawUrl = gitmodules.get(link.path);
    if (!rawUrl) {
      // .gitmodules 没写，但 gitlink 存在时无法安全推导地址。
      skipped.push({ path: link.path, url: "", reason: "invalid" });
      continue;
    }
    const classified = classifySubmoduleUrl(rawUrl, gitlabOrigin, policy);
    if ("reason" in classified) {
      skipped.push({ path: link.path, url: rawUrl, reason: classified.reason });
      continue;
    }
    items.push({ path: link.path, sha: link.sha, ...classified.item });
  }
  return { items, skipped };
}
