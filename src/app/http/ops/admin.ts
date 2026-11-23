import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";
import { parseSkillDocument, validateSkillDocument } from "../../../agent/skills.js";

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

      admin.delete("/skills/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        if (!ctx.store.deleteConversationSkill(id)) {
          sendJson(reply, 404, { error: "skill not found or protected" });
          return;
        }
        sendJson(reply, 200, { deleted: true });
      });
    },
    { prefix: "/api/ops/admin" },
  );
}
