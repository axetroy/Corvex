import type { FastifyInstance } from "fastify";
import { currentUser, requireAdmin } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";
import { parseSkillDocument, validateSkillDocument } from "../../../agent/skills.js";
import { discoverSkillsFromZip, skillImportLimits } from "../../../agent/skill-import.js";
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
        if (typeof body.admin !== "boolean") {
          sendJson(reply, 400, { error: "admin must be a boolean" });
          return;
        }
        try {
          if (!ctx.store.setUserAdmin(id, body.admin)) {
            sendJson(reply, 404, { error: "user not found" });
            return;
          }
          sendJson(reply, 200, { userId: id, admin: body.admin });
        } catch (error) {
          sendJson(reply, 409, { error: error instanceof Error ? error.message : "could not update administrator" });
        }
      });

      // 对话技能：管理员在此维护斜杠命令的名称、说明与提示词模板。
      admin.get("/skills", async (_request, reply) => {
        sendJson(reply, 200, { items: ctx.store.listConversationSkills() });
      });

      admin.post("/skills", async (request, reply) => {
        const body = readJsonObject(request, reply);
        if (!body) return;
        const parsed = parseSkillDocumentBody(body);
        if ("error" in parsed) {
          sendJson(reply, 400, { error: parsed.error });
          return;
        }
        if (ctx.store.getConversationSkill(parsed.name)) {
          sendJson(reply, 409, { error: "skill name already exists" });
          return;
        }
        sendJson(reply, 201, ctx.store.createConversationSkill(parsed.document));
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
        if (!ctx.store.listConversationSkills().some((skill) => skill.id === id)) {
          sendJson(reply, 404, { error: "skill not found" });
          return;
        }
        const clash = ctx.store.getConversationSkill(parsed.name);
        if (clash && clash.id !== id) {
          sendJson(reply, 409, { error: "skill name already exists" });
          return;
        }
        sendJson(reply, 200, ctx.store.updateConversationSkill(id, parsed.document));
      });

      // 技能包导入：ZIP 原样入库，包内 SKILL.md 派生为可调用的对话技能。
      admin.get("/skills/packs", async (_request, reply) => {
        sendJson(reply, 200, { items: ctx.store.listSkillPacks() });
      });

      admin.post("/skills/import", async (request, reply) => {
        const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
        try {
          let archive: Buffer;
          let name: string;
          let source: string;
          let sourceValue: string;
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
            path = typeof body.path === "string" ? body.path : undefined;
            overwrite = body.overwrite === true;
          }
          if (archive.byteLength > skillImportLimits.maxArchiveBytes) {
            sendJson(reply, 413, { error: `ZIP exceeds the ${skillImportLimits.maxArchiveBytes} byte limit` });
            return;
          }
          const discovered = await discoverSkillsFromZip(archive, path);
          const result = ctx.store.createSkillPack({
            name,
            archive,
            source,
            sourceValue,
            documents: discovered.skills.map((skill) => skill.document),
            overwrite,
          });
          sendJson(reply, 201, { ...result, issues: discovered.issues });
        } catch (cause) {
          sendJson(reply, 400, { error: cause instanceof Error ? cause.message : "skill import failed" });
        }
      });

      admin.put("/skills/packs/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const body = readJsonObject(request, reply);
        if (!body) return;
        if (!ctx.store.setSkillPackEnabled(id, body.enabled === true)) {
          sendJson(reply, 404, { error: "skill pack not found" });
          return;
        }
        sendJson(reply, 200, { updated: true });
      });

      admin.delete("/skills/packs/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        if (!ctx.store.deleteSkillPack(id)) {
          sendJson(reply, 404, { error: "skill pack not found" });
          return;
        }
        sendJson(reply, 200, { deleted: true });
      });

      admin.delete("/skills/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        if (!ctx.store.deleteConversationSkill(id)) {
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
    },
    { prefix: "/api/ops/admin" },
  );
}
