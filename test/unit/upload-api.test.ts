import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CorvexServer } from "../../src/app/server.js";
import { AppStore } from "../../src/store.js";
import { createTokenCipher } from "../../src/tokens.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { uploadContentType } from "../../src/app/upload.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

function config(root: string, gitlabBaseUrl = "http://127.0.0.1:1"): CorvexConfig {
  return {
    server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
    operations: { username: "", password: "" },
    gitlab: { baseUrl: gitlabBaseUrl, blockedUserIds: [], botUsername: "" },
    storage: { root, database: ":memory:", retentionDays: 90, auditRetentionDays: 365 },
    agent: {
      responseLanguage: "en", baseUrl: "https://api.openai.com/v1", model: "test", apiKey: "",
      requestTimeout: 1000, sessionTimeout: 1000, maxOutputTokens: 4096, dailyTokenBudget: 0,
      webEnabled: false, webBlockedHosts: [], skillPaths: [],
      uploadMaxBytes: 256 << 10, uploadMaxPerMessage: 10, uploadMaxPerConversation: 100,
    },
  };
}

function login(store: AppStore, gitlabUserId: number, username: string): { headers: Record<string, string>; id: string } {
  const cipher = createTokenCipher(store.getOrCreateSessionSecret());
  const user = store.upsertUser({
    gitlabUserId, username, name: username, avatarUrl: "", accessToken: "t",
    refreshToken: "", expiresAt: Date.now() + 3_600_000,
  }, cipher);
  return {
    headers: { cookie: `corvex_session=${store.createUserSession(user.id, Date.now() + 3_600_000)}` },
    id: user.id,
  };
}

describe("upload API", () => {
  let temp = "";
  afterEach(async () => {
    vi.restoreAllMocks();
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  it("uploads text, validates it, isolates owners and deletes the file", async () => {
    temp = await mkdtemp(join(tmpdir(), "corvex-upload-"));
    const store = await AppStore.open(":memory:");
    const owner = login(store, 1, "owner");
    const other = login(store, 2, "other");
    const ownerHeaders = owner.headers;
    const otherHeaders = other.headers;
    const created = store.createConversation({
      ownerUserId: owner.id, projectId: 2, projectName: "g/p", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 1, request: "hi",
    });
    const id = created.conversationId;

    const runtimeConfig = config(temp);
    const application = new CorvexServer(runtimeConfig, store);
    const controller = new AbortController();
    const running = application.run(controller.signal);
    try {
      let base = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        try { base = `http://127.0.0.1:${application.getListeningAddress().port}`; break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      expect(base).not.toBe("");
      const limits = await fetch(`${base}/api/ops/me/upload-limits`, { headers: ownerHeaders });
      expect(limits.status).toBe(200);
      expect((await limits.json()) as Record<string, unknown>).toMatchObject({ maxBytes: 262144, maxPerMessage: 10 });

      const url = `${base}/api/ops/conversations/${id}/uploads?filename=notes.txt&mime=text/plain`;
      const post = (headers: Record<string, string>, body: Buffer, contentType = uploadContentType) =>
        fetch(url, { method: "POST", headers: { ...headers, "content-type": contentType }, body });

      expect((await post(ownerHeaders, Buffer.from(""), uploadContentType)).status).toBe(400);
      expect((await post(ownerHeaders, Buffer.from([0, 1]), uploadContentType)).status).toBe(400);
      expect((await post(ownerHeaders, Buffer.from("ok"), "text/plain")).status).toBe(415);
      expect((await post(otherHeaders, Buffer.from("ok"))).status).toBe(404);

      const createdResponse = await post(ownerHeaders, Buffer.from("hello 世界"));
      expect(createdResponse.status).toBe(201);
      const upload = (await createdResponse.json()) as { id: string; filename: string; storagePath: string };
      expect(upload.filename).toBe("notes.txt");
      expect(upload.storagePath).toContain(`uploads/${id}/${upload.id}/notes.txt`);

      const list = await fetch(`${base}/api/ops/conversations/${id}/uploads`, { headers: ownerHeaders });
      expect(list.status).toBe(200);
      expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
      expect((await fetch(`${base}/api/ops/conversations/${id}/uploads`, { headers: otherHeaders })).status).toBe(404);
      const textContent = await fetch(`${base}/api/ops/conversations/${id}/uploads/${upload.id}/content`, { headers: ownerHeaders });
      expect(textContent.status).toBe(200);
      expect(await textContent.text()).toBe("hello 世界");

      const removed = await fetch(`${base}/api/ops/conversations/${id}/uploads/${upload.id}`, {
        method: "DELETE", headers: ownerHeaders,
      });
      expect(removed.status).toBe(200);
      expect(store.getConversationUpload(upload.id)).toBeUndefined();
      expect(store.listConversationUploads(id)).toHaveLength(0);

      // 图片按魔数识别真实 MIME，并提供鉴权预览端点。
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      const imageUpload = await fetch(
        `${base}/api/ops/conversations/${id}/uploads?filename=shot.png&mime=image/png`,
        { method: "POST", headers: { ...ownerHeaders, "content-type": uploadContentType }, body: png },
      );
      expect(imageUpload.status).toBe(201);
      const imageMeta = (await imageUpload.json()) as { id: string; mime: string };
      expect(imageMeta.mime).toBe("image/png");
      const preview = await fetch(`${base}/api/ops/conversations/${id}/uploads/${imageMeta.id}/image`, { headers: ownerHeaders });
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);

      // 新建对话前的草稿上传：按用户暂存，可预览、可删除。
      const draft = await fetch(
        `${base}/api/ops/uploads/draft?filename=notes.txt&mime=text/plain`,
        { method: "POST", headers: { ...ownerHeaders, "content-type": uploadContentType }, body: Buffer.from("draft body") },
      );
      expect(draft.status).toBe(201);
      const draftMeta = (await draft.json()) as { id: string; filename: string; mime: string };
      expect(draftMeta).toMatchObject({ filename: "notes.txt", mime: "text/plain" });
      expect((await fetch(`${base}/api/ops/uploads/draft?filename=notes.txt`, {
        method: "POST", headers: { ...otherHeaders, "content-type": uploadContentType }, body: Buffer.from("x"),
      })).status).toBe(201);
      const draftPreview = await fetch(`${base}/api/ops/uploads/draft/${draftMeta.id}/image`, { headers: ownerHeaders });
      expect(draftPreview.status).toBe(404); // 文本草稿没有图片预览
      const draftContent = await fetch(`${base}/api/ops/uploads/draft/${draftMeta.id}/content`, { headers: ownerHeaders });
      expect(draftContent.status).toBe(200);
      expect(await draftContent.text()).toBe("draft body");
      expect((await fetch(`${base}/api/ops/uploads/draft/${draftMeta.id}`, {
        method: "DELETE", headers: ownerHeaders,
      })).status).toBe(200);

      // 运行时设置改小后立即生效：Server 持有同一 config 对象引用。
      runtimeConfig.agent.uploadMaxBytes = 4;
      const tooLarge = await post(ownerHeaders, Buffer.from("hello"));
      expect(tooLarge.status).toBe(400);
      expect(((await tooLarge.json()) as { error: string }).error).toContain("4-byte limit");
    } finally {
      controller.abort();
      await running;
    }
  });

  it("claims draft uploads when a new conversation is created", async () => {
    temp = await mkdtemp(join(tmpdir(), "corvex-draft-claim-"));
    const fakeGitLab = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const replies: Record<string, unknown> = {
        "/api/v4/projects/2": {
          id: 2, name: "Project", path_with_namespace: "group/project",
          http_url_to_repo: "http://127.0.0.1:1/group/project.git", default_branch: "main",
        },
        "/api/v4/projects/2/repository/branches/main": { name: "main", commit: { id: "b".repeat(40) } },
      };
      response.writeHead(path in replies ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(replies[path] ?? { message: "not found" }));
    });
    const glPort = await listen(fakeGitLab);
    const store = await AppStore.open(":memory:");
    const headers = login(store, 1, "owner").headers;
    const application = new CorvexServer(config(temp, `http://127.0.0.1:${glPort}`), store);
    const controller = new AbortController();
    const running = application.run(controller.signal);
    try {
      let base = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          base = `http://127.0.0.1:${application.getListeningAddress().port}`;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const draft = await fetch(`${base}/api/ops/uploads/draft?filename=plan.txt&mime=text/plain`, {
        method: "POST", headers: { ...headers, "content-type": uploadContentType }, body: Buffer.from("plan body"),
      });
      expect(draft.status).toBe(201);
      const { id: draftId } = (await draft.json()) as { id: string };
      const created = await fetch(`${base}/api/ops/conversations`, {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          projectId: 2, targetBranch: "main", message: "do it", draftUploadIds: [draftId],
        }),
      });
      expect([201, 202]).toContain(created.status);
      const conversation = (await created.json()) as { conversationId: string };
      const userMessage = store.getConversation(conversation.conversationId)?.messages.find((m) => m.role === "user");
      expect(userMessage?.attachments).toMatchObject([{ id: draftId, filename: "plan.txt", mime: "text/plain" }]);
      expect(store.listConversationUploads(conversation.conversationId)).toHaveLength(1);
    } finally {
      controller.abort();
      await running;
      fakeGitLab.close();
    }
  });
});
