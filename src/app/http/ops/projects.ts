import type { FastifyInstance } from "fastify";
import { repositoryCloneUrl, repositoryWebUrl } from "../../../gitlab/client.js";
import type { OpsContext } from "../context.js";
import { optionalInteger, queryParam, sendGitLabReadError, sendJson } from "../respond.js";

/** 项目与分支查询：控制台用只读 Token 发现可用的仓库。 */
export function registerProjectRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.get("/api/ops/projects", async (request, reply) => {
    const page = optionalInteger(queryParam(request.query, "page"), 1, 10_000) ?? 1;
    const search = queryParam(request.query, "search") ?? "";
    if (page === false || search.length > 100) {
      sendJson(reply, 400, { error: "invalid project search" });
      return;
    }
    try {
      sendJson(reply, 200, await ctx.gitlabForRequest(request).listProjects(search, page));
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
      sendJson(reply, 200, await ctx.gitlabForRequest(request).listBranches(projectId, search, page));
    } catch (error) {
      sendGitLabReadError(reply, error);
    }
  });
}
