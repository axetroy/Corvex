import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SkillStore } from "../../src/agent/skill-store.ts";
import { registerSkillManagementRoutes } from "../../src/app/http/ops/skill-management.ts";

describe("skill import preview route", () => {
  let directory = "";
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function setup(): Promise<void> {
    directory = await mkdtemp(join(tmpdir(), "corvex-skill-routes-"));
    const store = new SkillStore(join(directory, "skills"));
    app = Fastify();
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    app.register(
      async (scope) => registerSkillManagementRoutes(scope, {
        storeForRequest: () => store,
        gitlabForRequest: () => ({ authToken: "test" } as never),
        gitlabBaseUrl: "https://gitlab.example.com",
      }),
      { prefix: "/api/ops/admin" },
    );
    await app.ready();
  }

  it("parses the JSON body before reading channel and value", async () => {
    await setup();
    // 损坏的 JSON 会走到统一解析器；旧实现把 Buffer 当对象读，会误报 channel and value。
    const response = await app.inject({
      method: "POST",
      url: "/api/ops/admin/skills/import/preview",
      headers: { "content-type": "application/json" },
      payload: "{broken",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).not.toBe("channel and value are required");
  });

  it("reads channel and value from a valid JSON body", async () => {
    await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/ops/admin/skills/import/preview",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ channel: "url", value: "not-a-url" }),
    });
    // 走到 URL 校验说明 JSON 里的 channel/value 已被正确读取（旧实现会误报缺少字段）。
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("URL source must start with http:// or https://");
  });
});
