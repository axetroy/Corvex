import { fetchWebResponse, createPinnedRequest, defaultDependencies, validateWebUrl } from "./web-read.js";
import { discoverSkillsFromZip, skillImportLimits, type SkillImportResult } from "./skill-import.js";
import type { GitLabClient } from "../gitlab/client.js";

export type SkillSourceChannel = "url" | "github" | "gitlab";

export interface SkillSourceInput {
  channel: SkillSourceChannel;
  value: string;
  /** 分支、标签或提交；省略时用默认分支。 */
  ref?: string;
  /** 只导入压缩包内该前缀下的 SKILL.md。 */
  path?: string;
}

export interface SkillSourceOptions {
  signal?: AbortSignal;
  gitlab?: GitLabClient;
  gitlabBaseUrl?: string;
}

const zipAccept = "application/zip,application/octet-stream;q=0.9,text/plain;q=0.8";

function isZip(body: Buffer): boolean {
  return body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b &&
    (body[2] === 0x03 || body[2] === 0x05 || body[2] === 0x07);
}

/** 下载 ZIP 并发现其中的 SKILL.md。 */
async function downloadArchive(urlValue: string, options: SkillSourceOptions): Promise<Buffer> {
  const url = validateWebUrl(urlValue, new Set());
  const { response } = await fetchWebResponse(url.toString(), {
    signal: options.signal,
    dependencies: {
      // 必须用真实 DNS 解析出 IP：SSRF 校验要求所有地址都是公网 IP，
      // 把域名当地址返回会直接触发「does not resolve exclusively to public IP addresses」。
      resolve: defaultDependencies.resolve,
      request: createPinnedRequest(skillImportLimits.maxArchiveBytes, zipAccept),
    },
  });
  if (!isZip(response.body)) throw new Error("source did not return a ZIP archive");
  return response.body;
}

/** 解析 GitHub shorthand、仓库 URL 与 /tree/<ref>/<path> 子路径。 */
export function parseGithubSource(value: string): { owner: string; repo: string; ref?: string; path?: string; skill?: string } {
  const trimmed = value.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  let rest = trimmed;
  if (/^https?:\/\/github\.com\//i.test(rest)) rest = rest.replace(/^https?:\/\/github\.com\//i, "");
  const parts = rest.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("GitHub source must be owner/repo or a github.com URL");
  const [owner, repo, tree, ref, ...pathParts] = parts;
  if (tree && tree.toLowerCase() !== "tree") throw new Error("unsupported GitHub source path");
  const skill = repo.includes("@") ? repo.slice(repo.indexOf("@") + 1) : undefined;
  return {
    owner,
    repo: repo.split("@")[0],
    ...(tree ? { ref } : {}),
    ...(pathParts.length ? { path: pathParts.join("/") } : {}),
    ...(skill ? { skill } : {}),
  };
}

/** 远程来源下载结果；archive 只在当前请求内短暂存在，调用方必须立即写盘。 */
export interface SourceArchive {
  archive: Buffer;
  sourceUrl?: string;
  commit?: string;
  /** 归一化后的子目录前缀。 */
  path?: string;
}

function filterResult(result: SkillImportResult, pathPrefix?: string): SkillImportResult {
  if (!pathPrefix) return result;
  const prefix = pathPrefix.replace(/\/+$/, "");
  return {
    skills: result.skills.filter((skill) => skill.sourcePath.startsWith(`${prefix}/`)),
    issues: result.issues,
  };
}

/** 从 GitHub 仓库下载 ZIP；ref 可以是分支、tag 或提交。 */
async function archiveFromGithub(input: SkillSourceInput, options: SkillSourceOptions): Promise<SourceArchive> {
  const parsed = parseGithubSource(input.value);
  const ref = input.ref ?? parsed.ref ?? "HEAD";
  const sourceUrl = `https://codeload.github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zip/${encodeURIComponent(ref)}`;
  const archive = await downloadArchive(sourceUrl, options);
  return {
    archive,
    sourceUrl,
    ...(input.ref ? { commit: input.ref } : {}),
    path: input.path ?? parsed.path,
  };
}

/** 从已配置的 GitLab 实例下载项目归档；使用当前登录用户的 OAuth 令牌。 */
async function archiveFromGitlab(input: SkillSourceInput, options: SkillSourceOptions): Promise<SourceArchive> {
  const client = options.gitlab;
  if (!client?.authToken) throw new Error("GitLab source requires a signed-in user");
  const baseUrl = options.gitlabBaseUrl?.replace(/\/+$/, "") ?? "";
  if (!baseUrl) throw new Error("GitLab base URL is not configured");

  let project = input.value.trim();
  let projectId: number | string | undefined;
  if (/^\d+$/.test(project)) {
    projectId = Number(project);
  } else {
    const match = /^https?:\/\/[^/]+\/(.+?)(?:\/-\/[^#?]*)?(?:[?#].*)?$/.exec(project);
    if (match) project = match[1].replace(/\.git$/, "");
    const found = (await client.listProjects(project, 1, options.signal))
      .find((item) => item.path_with_namespace === project);
    if (!found) throw new Error(`GitLab project "${project}" was not found`);
    projectId = found.id;
  }

  const archiveUrl = new URL(`${baseUrl}/api/v4/projects/${encodeURIComponent(String(projectId))}/repository/archive.zip`);
  if (input.ref) archiveUrl.searchParams.set("sha", input.ref);
  const response = await fetch(archiveUrl, {
    headers: { authorization: `Bearer ${client.authToken}` },
    signal: options.signal,
  });
  if (!response.ok) throw new Error(`GitLab archive request failed with HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > skillImportLimits.maxArchiveBytes) {
    throw new Error("GitLab archive exceeds the download limit");
  }
  if (!isZip(body)) throw new Error("GitLab did not return a ZIP archive");
  return {
    archive: body,
    sourceUrl: archiveUrl.toString(),
    ...(input.ref ? { commit: input.ref } : {}),
    path: input.path,
  };
}

/** 只负责下载 ZIP 与解析来源信息；不缓存、不常驻内存。 */
export async function fetchSourceArchive(
  input: SkillSourceInput,
  options: SkillSourceOptions = {},
): Promise<SourceArchive> {
  switch (input.channel) {
    case "url": {
      const value = input.value.trim();
      if (!/^https?:\/\//i.test(value)) throw new Error("URL source must start with http:// or https://");
      return { archive: await downloadArchive(value, options), sourceUrl: value, path: input.path };
    }
    case "github":
      return archiveFromGithub(input, options);
    case "gitlab":
      return archiveFromGitlab(input, options);
    default: {
      const exhaustive: never = input.channel;
      throw new Error(`unsupported skill source ${String(exhaustive)}`);
    }
  }
}

/** 完整发现流程：下载后立刻解析，结果里不再带 ZIP。 */
export async function fetchSkillsFromSource(
  input: SkillSourceInput,
  options: SkillSourceOptions = {},
): Promise<SkillImportResult> {
  const source = await fetchSourceArchive(input, options);
  return filterResult(await discoverSkillsFromZip(source.archive, source.path), source.path);
}
