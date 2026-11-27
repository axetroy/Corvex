import type { FastifyInstance } from "fastify";
import { repositoryCloneUrl, repositoryWebUrl } from "../../../gitlab/client.js";
import type { OpsContext } from "../context.js";
import { optionalInteger, queryParam, sendGitLabReadError, sendJson } from "../respond.js";
import { rankProjects } from "./project-ranking.js";
import { rankBranches } from "./branch-ranking.js";

/** 项目与分支查询：用当前登录用户的 GitLab 令牌发现可见仓库。 */
export function registerProjectRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/projects", async (request, reply) => {
    const page = optionalInteger(queryParam(request.query, "page"), 1, 10_000) ?? 1;
    const search = queryParam(request.query, "search") ?? "";
    if (page === false || search.length > 100) {
      sendJson(reply, 400, { error: "invalid project search" });
      return;
    }
    try {
      // 先取足够多的候选项目，再按相似度/活跃度/最近会话全局排序，最后按页切片。
      const candidates = await ctx.gitlabForRequest(request).listProjectCandidates(search);
      const ranked = rankProjects(candidates, search, ctx.store.projectActivity());
      const pageSize = 50;
      sendJson(reply, 200, ranked.slice((page - 1) * pageSize, page * pageSize));
    } catch (error) {
      sendGitLabReadError(reply, error);
    }
  });

  // 仓库详情：控制台点击右上角的仓库名时读取，只暴露展示所需的字段。
  app.get("/api/ops/projects/:id", async (request, reply) => {
    const rawId = (request.params as { id: string }).id;
    // 路径只接受纯数字，与原实现的正则匹配保持一致；非数字路径按未匹配处理。
    if (!/^[0-9]+$/.test(rawId)) {
      sendJson(reply, 404, { error: "not found" });
      return;
    }
    const projectId = Number(rawId);
    if (!Number.isSafeInteger(projectId) || projectId < 1) {
      sendJson(reply, 400, { error: "invalid project ID" });
      return;
    }
    try {
      const project = await ctx.gitlabForRequest(request).getProject(projectId);
      sendJson(reply, 200, {
        id: project.id,
        name: project.name ?? null,
        path_with_namespace: project.path_with_namespace ?? null,
        description: project.description ?? null,
        default_branch: project.default_branch ?? null,
        // 不暴露 GitLab 自己生成的 external_url 地址，统一用配置的地址派生。
        web_url: repositoryWebUrl(ctx.config.gitlab.baseUrl, project),
        http_url_to_repo: repositoryCloneUrl(ctx.config.gitlab.baseUrl, project),
      });
    } catch (error) {
      sendGitLabReadError(reply, error);
    }
  });

  app.get("/api/ops/projects/:id/branches", async (request, reply) => {
    const rawId = (request.params as { id: string }).id;
    if (!/^[0-9]+$/.test(rawId)) {
      sendJson(reply, 404, { error: "not found" });
      return;
    }
    const projectId = Number(rawId);
    const page = optionalInteger(queryParam(request.query, "page"), 1, 10_000) ?? 1;
    const search = queryParam(request.query, "search") ?? "";
    if (!Number.isSafeInteger(projectId) || projectId < 1 || page === false || search.length > 100) {
      sendJson(reply, 400, { error: "invalid branch search" });
      return;
    }
    try {
      // 短词本地过滤 + 全局综合排序后再分页，避免 GitLab 默认顺序把不相关分支排前面。
      const candidates = await ctx.gitlabForRequest(request).listBranchCandidates(projectId, search);
      const ranked = rankBranches(candidates, search, ctx.store.branchActivity(projectId));
      const pageSize = 50;
      const branches = ranked.slice((page - 1) * pageSize, page * pageSize)
        .map((branch) => ({ name: branch.name, commit: branch.commit }));
      sendJson(reply, 200, branches);
    } catch (error) {
      sendGitLabReadError(reply, error);
    }
  });
}
