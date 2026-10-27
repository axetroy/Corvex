import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { PiAgent } from "../../src/agent/pi.js";

describe("PiAgent", () => {
  let temporaryDirectory = "";
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    server = undefined;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = "";
    }
  });

  it("uses the Pi SDK and the configured OpenAI-compatible provider", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-"));
    let requestBody = "";
    let responseDelayMs = 0;
    server = createServer((request, response) => {
      request.on("data", (chunk: Buffer) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        const sendResponse = () => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta: { role: "assistant", content: '{"summary":"ok","findings":[]}' }, finish_reason: null }],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: 1,
              model: "test-model",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20 },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        };
        if (responseDelayMs > 0) {
          const timer = setTimeout(sendResponse, responseDelayMs);
          response.once("close", () => clearTimeout(timer));
        } else {
          sendResponse();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test API server has no TCP address");

    const config = {
      server: { listen: "127.0.0.1:8080", readTimeout: 5000, shutdownTimeout: 30000 },
      gitlab: {
        baseUrl: "https://gitlab.example.com",
        readToken: "read",
        writeToken: "write",
        webhookSecret: "secret",
        allowedProjectIds: [1],
        allowedUserIds: [2],
        botUsername: "",
      },
      storage: {
        root: temporaryDirectory,
        database: join(temporaryDirectory, "state.db"),
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        enabled: true,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        apiKey: "test-key",
        requestTimeout: 10000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        mcpEnabled: false,
        skillPaths: [],
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20 },
      worker: { pollInterval: 2000, jobTimeout: 30 * 60_000 },
      fix: { enabled: false, allowedUserIds: [], maxPatchBytes: 128 << 10 },
    } satisfies CorvexConfig;

    const agent = new PiAgent(config);
    const result = await agent.generate(
      { systemPrompt: "Return JSON.", userPrompt: "Say ok." },
      temporaryDirectory,
    );
    expect(result.content).toContain('"summary":"ok"');
    expect(result.model).toContain("test-model");
    expect(requestBody).toContain('"model":"test-model"');
    expect(requestBody).toContain('"stream":true');
    expect(requestBody).toContain('"name":"read_file"');

    responseDelayMs = 2000;
    config.agent.requestTimeout = 500;
    await expect(
      agent.generate({ systemPrompt: "Wait.", userPrompt: "Wait." }, temporaryDirectory),
    ).rejects.toThrow("Pi agent run failed");
  }, 20_000);
});
