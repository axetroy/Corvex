import { fetchWebResponse, createPinnedRequest, validateWebUrl } from "./web-read.js";
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
      resolve: async (hostname) => [{ address: hostname, family: hostname.includes(":") ? 6 : 4 }],
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

function filterResult(result: SkillImportResult, input: Pick<SkillSourceInput, "path" | "ref"> & { skill?: string }): SkillImportResult {
  const pathPrefix = input.path?.replace(/\/+$/, "");
  const skills = result.skills.filter((skill) => {
    if (pathPrefix && !skill.sourcePath.startsWith(`${pathPrefix}/`)) return false;
    if (input.skill && skill.name !== input.skill) return false;
    return true;
  });
  return { skills, issues: result.issues, archive: result.archive };
}

/** 从 GitHub 仓库（公开）下载 ZIP 并发现技能。 */
async function fromGithub(input: SkillSourceInput, options: SkillSourceOptions): Promise<SkillImportResult> {
  const parsed = parseGithubSource(input.value);
  const ref = input.ref ?? parsed.ref ?? "HEAD";
  const url = `https://codeload.github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/zip/${encodeURIComponent(ref)}`;
  const archive = await downloadArchive(url, options);
  return filterResult(await discoverSkillsFromZip(archive), {
    ...input,
    path: input.path ?? parsed.path,
    skill: parsed.skill,
  });
}

/** 从已配置的 GitLab 实例下载项目归档；使用当前登录用户的 OAuth 令牌。 */
async function fromGitlab(input: SkillSourceInput, options: SkillSourceOptions): Promise<SkillImportResult> {
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
  return filterResult(await discoverSkillsFromZip(body), input);
}

/** 统一入口：URL / GitHub / GitLab 三种远程来源都归一成同一份发现结果。 */
export async function fetchSkillsFromSource(
  input: SkillSourceInput,
  options: SkillSourceOptions = {},
): Promise<SkillImportResult> {
  switch (input.channel) {
    case "url": {
      const value = input.value.trim();
      if (!/^https?:\/\//i.test(value)) throw new Error("URL source must start with http:// or https://");
      const archive = await downloadArchive(value, options);
      return filterResult(await discoverSkillsFromZip(archive), input);
    }
    case "github":
      return fromGithub(input, options);
    case "gitlab":
      return fromGitlab(input, options);
    default: {
      const exhaustive: never = input.channel;
      throw new Error(`unsupported skill source ${String(exhaustive)}`);
    }
  }
}
