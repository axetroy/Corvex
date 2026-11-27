import type { FastifyInstance, FastifyRequest } from "fastify";
import { readJsonObject, sendJson } from "../respond.js";
import { parseSkillDocument, validateSkillDocument } from "../../../agent/skills.js";
import { skillImportLimits } from "../../../agent/skill-import.js";
import { fetchSkillsFromSource, type SkillSourceChannel } from "../../../agent/skill-sources.js";
import type { SkillStore } from "../../../agent/skill-store.js";
import type { GitLabClient } from "../../../gitlab/client.js";

/** 管理员维护全局技能；登录用户维护自己的技能。两者共用同一套路由实现。 */
export interface SkillManagementOptions {
  storeForRequest(request: FastifyRequest): SkillStore;
  gitlabForRequest(request: FastifyRequest): GitLabClient;
  gitlabBaseUrl: string;
}

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

/** 注册在某个带前缀的 Fastify 实例上；路由均为 /skills、/skills/packs、/skills/import、/skills/verify。 */
export function registerSkillManagementRoutes(app: FastifyInstance, options: SkillManagementOptions): void {
  app.get("/skills", async (request, reply) => {
    sendJson(reply, 200, { items: await options.storeForRequest(request).list() });
  });

  // 磁盘被直接编辑时先按指纹刷新，再返回解析/发现诊断。
  app.get("/skills/diagnostics", async (request, reply) => {
    const store = options.storeForRequest(request);
    await store.refreshIfStale();
    sendJson(reply, 200, { items: store.diagnostics() });
  });

  app.post("/skills", async (request, reply) => {
    const body = readJsonObject(request, reply);
    if (!body) return;
    const parsed = parseSkillDocumentBody(body);
    if ("error" in parsed) {
      sendJson(reply, 400, { error: parsed.error });
      return;
    }
    const store = options.storeForRequest(request);
    if (await store.get(parsed.name)) {
      sendJson(reply, 409, { error: "skill name already exists" });
      return;
    }
    sendJson(reply, 201, await store.create(parsed.document));
  });

  app.put("/skills/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = readJsonObject(request, reply);
    if (!body) return;
    const parsed = parseSkillDocumentBody(body);
    if ("error" in parsed) {
      sendJson(reply, 400, { error: parsed.error });
      return;
    }
    const store = options.storeForRequest(request);
    const existing = await store.get(id);
    if (!existing) {
      sendJson(reply, 404, { error: "skill not found" });
      return;
    }
    // 磁盘目录名就是技能名；改名等于新建，走删除 + 新建避免目录与文档不一致。
    if (parsed.name !== id) {
      sendJson(reply, 400, { error: "renaming a skill is not supported; delete and create it again" });
      return;
    }
    sendJson(reply, 200, await store.update(id, parsed.document));
  });

  app.delete("/skills/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!await options.storeForRequest(request).remove(id)) {
      sendJson(reply, 404, { error: "skill not found or protected" });
      return;
    }
    sendJson(reply, 200, { deleted: true });
  });

  // 技能包：ZIP 与解压后的文件落盘，来源与哈希写入对应的锁文件。
  app.get("/skills/packs", async (request, reply) => {
    sendJson(reply, 200, { items: await options.storeForRequest(request).listPacks() });
  });

  app.post("/skills/import", async (request, reply) => {
    const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
    try {
      let archive: Buffer;
      let name: string;
      let source: "upload" | "url" | "github" | "gitlab";
      let sourceValue: string;
      let sourceUrl: string | undefined;
      let commit: string | undefined;
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
          { gitlab: options.gitlabForRequest(request), gitlabBaseUrl: options.gitlabBaseUrl },
        );
        archive = result.archive!;
        sourceUrl = result.sourceUrl;
        commit = result.commit;
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
      const result = await options.storeForRequest(request).importPack({
        name, archive, source, sourceValue, ref, sourceUrl, commit, path, overwrite,
      });
      sendJson(reply, 201, result);
    } catch (cause) {
      sendJson(reply, 400, { error: cause instanceof Error ? cause.message : "skill import failed" });
    }
  });

  // 按锁里记录的远程来源重新拉取并更新技能包。
  app.post("/skills/packs/:id/update", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    try {
      const result = await options.storeForRequest(request).updatePack(id, async (entry) => {
        if (entry.source !== "url" && entry.source !== "github" && entry.source !== "gitlab") {
          throw new Error("this pack was uploaded locally and has no remote source");
        }
        const fetched = await fetchSkillsFromSource(
          {
            channel: entry.source,
            value: entry.sourceUrl || entry.sourceValue || "",
            ...(entry.ref || entry.commit ? { ref: entry.ref ?? entry.commit! } : {}),
            ...(entry.skillPath ? { path: entry.skillPath.replace(/\/[^/]+$/, "") } : {}),
          },
          { gitlab: options.gitlabForRequest(request), gitlabBaseUrl: options.gitlabBaseUrl },
        );
        if (!fetched.archive) throw new Error("source did not return a ZIP archive");
        return { archive: fetched.archive, sourceUrl: fetched.sourceUrl, commit: fetched.commit };
      });
      sendJson(reply, 200, result);
    } catch (cause) {
      sendJson(reply, 400, { error: cause instanceof Error ? cause.message : "skill pack update failed" });
    }
  });

  // 按锁文件校验磁盘状态；frozen 模式拒绝任何无法恢复的差异。
  app.post("/skills/verify", async (request, reply) => {
    const frozen = (request.body as { frozen?: unknown } | undefined)?.frozen === true;
    try {
      const items = await options.storeForRequest(request).verifyAndRestore(frozen);
      sendJson(reply, 200, { items });
    } catch (cause) {
      sendJson(reply, 409, { error: cause instanceof Error ? cause.message : "skill verification failed" });
    }
  });

  app.put("/skills/packs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = readJsonObject(request, reply);
    if (!body) return;
    if (!await options.storeForRequest(request).setPackEnabled(id, body.enabled === true)) {
      sendJson(reply, 404, { error: "skill pack not found" });
      return;
    }
    sendJson(reply, 200, { updated: true });
  });

  app.delete("/skills/packs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!await options.storeForRequest(request).deletePack(id)) {
      sendJson(reply, 404, { error: "skill pack not found" });
      return;
    }
    sendJson(reply, 200, { deleted: true });
  });
}
