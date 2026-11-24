import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { PiAgent } from "../../src/agent/pi.js";
import { AppStore } from "../../src/store.js";

describe("PiAgent conversation session persistence", () => {
  let directory = "";
  let store: AppStore | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  const bodies: string[] = [];

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
    server = undefined;
    store?.close();
    store = undefined;
    bodies.length = 0;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("restores full messages across turns instead of re-seeding text history", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-pi-session-"));
    await writeFile(join(directory, "README.md"), "repo");
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        if (request.url === "/tokenize") {
          response.writeHead(404, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        bodies.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
          id: "c1", object: "chat.completion.chunk", created: 1, model: "test-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");

    const config = {
      operations: { username: "", password: "" },
      gitlab: { baseUrl: "https://gitlab.example.com" },
      storage: { root: directory, database: join(directory, "state.db"), retentionDays: 90, auditRetentionDays: 365 },
      agent: {
        responseLanguage: "en", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model",
        apiKey: "k", requestTimeout: 5_000, sessionTimeout: 10_000, maxOutputTokens: 256,
        dailyTokenBudget: 0, webEnabled: false, webBlockedHosts: [], webSearchEnabled: false,
        webSearchMaxQueries: 5, skillPaths: [], contextWindow: 32_768, maxInputTokens: 0,
        historyTokenBudget: 8_000, turnToolResultBytes: 64 << 10, compactionReserveTokens: 0,
        compactionKeepRecentTokens: 4_000, summaryEnabled: false, reasoningEnabled: false,
        contextInspectEnabled: false,
      },
    } as unknown as CorvexConfig;

    store = await AppStore.open(":memory:");
    const conversation = store.createConversation({
      projectId: 7, projectName: "group/project", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "first",
    });
    const conversationId = conversation.conversationId;
    const agent = new PiAgent(config, store);
    const first = await agent.generate({
      taskType: "conversation", conversationId, systemPrompt: "Be brief.",
      userPrompt: JSON.stringify({ currentRequest: "FIRST_MARKER" }),
    }, directory);
    expect(first.content).toBe("ok");

    const persisted = store.conversationSessionEntries(conversationId);
    expect(persisted).toBeDefined();
    const entries = JSON.parse(persisted!) as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({ type: "session" });
    expect(entries.some((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("FIRST_MARKER"))).toBe(true);

    await agent.generate({
      taskType: "conversation", conversationId, systemPrompt: "Be brief.",
      userPrompt: JSON.stringify({ currentRequest: "SECOND_MARKER" }),
      // 故意给一份不同的文本历史：恢复完整会话时它应被忽略，避免重复注入。
      history: [{ role: "user", content: "IGNORED_HISTORY_MARKER" }],
    }, directory);

    const lastBody = bodies.at(-1) ?? "";
    expect(lastBody).toContain("FIRST_MARKER");
    expect(lastBody).toContain("SECOND_MARKER");
    expect(lastBody).not.toContain("IGNORED_HISTORY_MARKER");
  });
});
