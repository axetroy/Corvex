import type { FastifyInstance } from "fastify";
import { currentUser, requireAdmin } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";
import { parseSkillDocument, validateSkillDocument } from "../../../agent/skills.js";
import { skillImportLimits } from "../../../agent/skill-import.js";
import { fetchSkillsFromSource, type SkillSourceChannel } from "../../../agent/skill-sources.js";

/** 管理员提交的是完整 SKILL.md；解析与校验失败时返回错误文本。 */
function parseSkillDocumentBody(body: Record<string, unknown>): { document: string; name: string } | { error: string } {
  if (typeof body.document !== "string" || !body.document.trim()) {
    return { error: "document (SKILL.md) is required" };
  }
  try {
    const parsed = parseSkillDocument(body.document);
    const problems = validateSkillDocument(parsed);
    if (problems.length > 0) return { error: problems.join("; ") };
    return { document: body.document.trim(), name: parsed.name };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid SKILL.md" };
  }
}

/**
 * 管理员接口统一挂在 `/api/ops/admin` 命名空间下。
 * 插件内的 onRequest 钩子对整个命名空间校验管理员身份。
 */
export function registerAdminRoutes(app: FastifyInstance, ctx: OpsContext): void {
  app.register(
    async (admin) => {
      admin.addHook("onRequest", async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
      });

      admin.get("/users", async (_request, reply) => {
        sendJson(reply, 200, { items: ctx.store.listUsers() });
      });

      admin.put("/users/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const body = readJsonObject(request, reply);
        if (!body) return;
        const hasAdmin = body.admin !== undefined;
        const hasDisabled = body.disabled !== undefined;
        if (!hasAdmin && !hasDisabled) {
          sendJson(reply, 400, { error: "admin or disabled is required" });
          return;
        }
        if (hasAdmin && typeof body.admin !== "boolean") {
          sendJson(reply, 400, { error: "admin must be a boolean" });
          return;
        }
        if (hasDisabled && typeof body.disabled !== "boolean") {
          sendJson(reply, 400, { error: "disabled must be a boolean" });
          return;
        }
        const actor = currentUser(request);
        // 管理员不能取消自己的管理员身份，避免把自己锁在管理后台之外。
        if (hasAdmin && body.admin === false && actor?.id === id) {
          sendJson(reply, 403, { error: "you cannot revoke your own administrator access" });
          return;
        }
        // 管理员不能禁用自己；要禁用必须先由他人取消管理员身份。
        if (hasDisabled && body.disabled === true && actor?.id === id) {
          sendJson(reply, 403, { error: "an administrator cannot disable itself; revoke admin first" });
          return;
        }
        try {
          if (hasAdmin) {
            if (!ctx.store.setUserAdmin(id, body.admin as boolean, actor?.id)) {
              sendJson(reply, 404, { error: "user not found" });
              return;
            }
          }
          if (hasDisabled) {
            if (!ctx.store.setUserDisabled(id, body.disabled as boolean)) {
              sendJson(reply, 404, { error: "user not found" });
              return;
            }
          }
          sendJson(reply, 200, { userId: id, ...(hasAdmin ? { admin: body.admin } : {}), ...(hasDisabled ? { disabled: body.disabled } : {}) });
        } catch (error) {
          sendJson(reply, 409, { error: error instanceof Error ? error.message : "could not update user" });
        }
      });

      // 对话技能：磁盘文件是唯一来源，锁文件记录来源与内容哈希。
      admin.get("/skills", async (_request, reply) => {
        sendJson(reply, 200, { items: await ctx.skills.list() });
      });

      admin.post("/skills", async (request, reply) => {
        const body = readJsonObject(request, reply);
        if (!body) return;
        const parsed = parseSkillDocumentBody(body);
        if ("error" in parsed) {
          sendJson(reply, 400, { error: parsed.error });
          return;
        }
        if (await ctx.skills.get(parsed.name)) {
          sendJson(reply, 409, { error: "skill name already exists" });
          return;
        }
        sendJson(reply, 201, await ctx.skills.create(parsed.document));
      });

      admin.put("/skills/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const body = readJsonObject(request, reply);
        if (!body) return;
        const parsed = parseSkillDocumentBody(body);
        if ("error" in parsed) {
          sendJson(reply, 400, { error: parsed.error });
          return;
        }
        const existing = await ctx.skills.get(id);
        if (!existing) {
          sendJson(reply, 404, { error: "skill not found" });
          return;
        }
        // 磁盘目录名就是技能名；改名等于新建，走删除 + 新建避免目录与文档不一致。
        if (parsed.name !== id) {
          sendJson(reply, 400, { error: "renaming a skill is not supported; delete and create it again" });
          return;
        }
        const clash = await ctx.skills.get(parsed.name);
        if (clash && clash.name !== id) {
          sendJson(reply, 409, { error: "skill name already exists" });
          return;
        }
        sendJson(reply, 200, await ctx.skills.update(id, parsed.document));
      });

      // 技能包导入：ZIP 与解压后的文件都落盘，来源与哈希写入 skills-lock.json。
      admin.get("/skills/packs", async (_request, reply) => {
        sendJson(reply, 200, { items: await ctx.skills.listPacks() });
      });

      admin.post("/skills/import", async (request, reply) => {
        const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
        try {
          let archive: Buffer;
          let name: string;
          let source: "upload" | "url" | "github" | "gitlab";
          let sourceValue: string;
          let ref: string | undefined;
          let path: string | undefined;
          let overwrite = false;
          if (contentType.startsWith("application/zip") || contentType.startsWith("application/octet-stream")) {
            if (!Buffer.isBuffer(request.body)) {
              sendJson(reply, 400, { error: "ZIP archive body is required" });
              return;
            }
            archive = request.body;
            const query = request.query as { filename?: string };
            name = String(query.filename ?? "skill-pack.zip").replace(/\.zip$/i, "");
            source = "upload";
            sourceValue = String(query.filename ?? "skill-pack.zip");
          } else {
            const body = readJsonObject(request, reply);
            if (!body) return;
            const channel = String(body.channel ?? "") as SkillSourceChannel;
            const value = String(body.value ?? "").trim();
            if (!["url", "github", "gitlab"].includes(channel) || !value) {
              sendJson(reply, 400, { error: "channel and value are required" });
              return;
            }
            const result = await fetchSkillsFromSource(
              {
                channel,
                value,
                ...(typeof body.ref === "string" && body.ref.trim() ? { ref: body.ref.trim() } : {}),
                ...(typeof body.path === "string" && body.path.trim() ? { path: body.path.trim() } : {}),
              },
              {
                gitlab: ctx.gitlabForRequest(request),
                gitlabBaseUrl: ctx.config.gitlab.baseUrl,
              },
            );
            archive = result.archive!;
            name = value.split("/").filter(Boolean).pop() ?? "skill-pack";
            source = channel;
            sourceValue = value;
            ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim() : undefined;
            path = typeof body.path === "string" ? body.path : undefined;
            overwrite = body.overwrite === true;
          }
          if (archive.byteLength > skillImportLimits.maxArchiveBytes) {
            sendJson(reply, 413, { error: `ZIP exceeds the ${skillImportLimits.maxArchiveBytes} byte limit` });
            return;
          }
          const result = await ctx.skills.importPack({ name, archive, source, sourceValue, ref, path, overwrite });
          sendJson(reply, 201, result);
        } catch (cause) {
          sendJson(reply, 400, { error: cause instanceof Error ? cause.message : "skill import failed" });
        }
      });

      // 按锁文件校验磁盘状态；frozen 模式拒绝任何无法恢复的差异。
      admin.post("/skills/verify", async (request, reply) => {
        const frozen = (request.body as { frozen?: unknown } | undefined)?.frozen === true;
        try {
          const items = await ctx.skills.verifyAndRestore(frozen);
          sendJson(reply, 200, { items });
        } catch (cause) {
          sendJson(reply, 409, { error: cause instanceof Error ? cause.message : "skill verification failed" });
        }
      });

      admin.put("/skills/packs/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const body = readJsonObject(request, reply);
        if (!body) return;
        if (!await ctx.skills.setPackEnabled(id, body.enabled === true)) {
          sendJson(reply, 404, { error: "skill pack not found" });
          return;
        }
        sendJson(reply, 200, { updated: true });
      });

      admin.delete("/skills/packs/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        if (!await ctx.skills.deletePack(id)) {
          sendJson(reply, 404, { error: "skill pack not found" });
          return;
        }
        sendJson(reply, 200, { deleted: true });
      });

      admin.delete("/skills/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        if (!await ctx.skills.remove(id)) {
          sendJson(reply, 404, { error: "skill not found or protected" });
          return;
        }
        sendJson(reply, 200, { deleted: true });
      });

      // 执行环境配置：管理员专属，保存前走完整 fail-closed 校验。
      admin.get("/execution", async (_request, reply) => {
        sendJson(reply, 200, ctx.executionConfig.read());
      });

      admin.put("/execution", async (request, reply) => {
        const body = readJsonObject(request, reply);
        if (!body) return;
        const actor = currentUser(request)?.username ?? "admin";
        const result = ctx.executionConfig.save(body, actor);
        if (!result.ok) {
          sendJson(reply, 400, { error: result.error });
          return;
        }
        sendJson(reply, 200, result.payload);
      });

      admin.delete("/execution", async (_request, reply) => {
        sendJson(reply, 200, ctx.executionConfig.reset());
      });

      // 存储管理：只读扫描镜像与工作树目录，大小/修改时间为扫描瞬间的近似值。
      admin.get("/storage", async (_request, reply) => {
        try {
          const storage = await ctx.conversations.describeStorage();
          sendJson(reply, 200, {
            ...storage,
            workspaceSizeLimitBytes: ctx.config.storage.conversationWorkspaceMaxMb * 1024 * 1024,
          });
        } catch (error) {
          sendJson(reply, 500, { error: error instanceof Error ? error.message.slice(0, 8000) : "storage scan failed" });
        }
      });
    },
    { prefix: "/api/ops/admin" },
  );
}
