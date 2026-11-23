import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../../auth/context.js";
import type { OpsContext } from "../context.js";
import { readJsonObject, sendJson } from "../respond.js";
import { validateSkillInput } from "../../../agent/skills.js";
import type { ConversationSkillInput } from "../../../model.js";

function parseSkillBody(body: Record<string, unknown>): ConversationSkillInput {
  const text = (key: string): string => typeof body[key] === "string" ? (body[key] as string).trim() : "";
  const metadata: Record<string, string> = {};
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    for (const [key, value] of Object.entries(body.metadata as Record<string, unknown>)) {
      if (typeof value === "string") metadata[key] = value;
    }
  }
  return {
    name: text("name"),
    description: text("description"),
    descriptionZh: text("descriptionZh"),
    content: text("content"),
    contentZh: text("contentZh"),
    argumentHint: text("argumentHint"),
    license: text("license"),
    compatibility: text("compatibility"),
    metadata,
    allowedTools: text("allowedTools"),
    enabled: body.enabled !== false,
  };
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
        const input = parseSkillBody(body);
        const problems = validateSkillInput(input);
        if (problems.length > 0) {
          sendJson(reply, 400, { error: problems.join("; ") });
          return;
        }
        if (ctx.store.getConversationSkill(input.name)) {
          sendJson(reply, 409, { error: "skill name already exists" });
          return;
        }
        sendJson(reply, 201, ctx.store.createConversationSkill(input));
      });

      admin.put("/skills/:id", async (request, reply) => {
        const id = (request.params as { id: string }).id;
        const body = readJsonObject(request, reply);
        if (!body) return;
        const input = parseSkillBody(body);
        const problems = validateSkillInput(input);
        if (problems.length > 0) {
          sendJson(reply, 400, { error: problems.join("; ") });
          return;
        }
        const existing = ctx.store.listConversationSkills().find((skill) => skill.id === id);
        if (!existing) {
          sendJson(reply, 404, { error: "skill not found" });
          return;
        }
        const clash = ctx.store.getConversationSkill(input.name);
        if (clash && clash.id !== id) {
          sendJson(reply, 409, { error: "skill name already exists" });
          return;
        }
        sendJson(reply, 200, ctx.store.updateConversationSkill(id, input));
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
