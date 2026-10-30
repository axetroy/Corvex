import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { PiAgent } from "../../src/agent/pi.js";
import { JobStore } from "../../src/jobs/store.js";

describe("PiAgent", () => {
  let temporaryDirectory = "";
  let server: ReturnType<typeof createServer> | undefined;
  let store: JobStore | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    server = undefined;
    store?.close();
    store = undefined;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = "";
    }
  });

  it("uses the Pi SDK and the configured OpenAI-compatible provider", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-"));
    let requestBody = "";
    let responseDelayMs = 0;
    let requestCount = 0;
    server = createServer((request, response) => {
      request.on("data", (chunk: Buffer) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        const currentRequest = requestCount++;
        const sendResponse = () => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (currentRequest === 0) {
            response.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-tool",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [{
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [{
                      index: 0,
                      id: "call-read-file",
                      type: "function",
                      function: { name: "read_file", arguments: '{"path":"README.md"}' },
                    }, {
                      index: 1,
                      id: "call-missing-file",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: JSON.stringify({ path: join(temporaryDirectory, "missing.txt") }),
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              })}\n\n`,
            );
            response.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-tool",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
              })}\n\n`,
            );
            response.end("data: [DONE]\n\n");
            return;
          }
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
      operations: { username: "", password: "" },
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
        requestTimeout: 500,
        sessionTimeout: 8000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        mcpEnabled: false,
        webEnabled: true,
        webBlockedHosts: ["blocked.corp.dev"],
        skillPaths: [],
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20 },
      worker: { pollInterval: 2000, jobTimeout: 30 * 60_000 },
      fix: { enabled: false, allowedUserIds: [], maxPatchBytes: 128 << 10 },
    } satisfies CorvexConfig;

    await writeFile(join(temporaryDirectory, "README.md"), "private repository content");
    store = await JobStore.open(":memory:");
    store.createReview("event-1", "key-1", {
      projectId: 7,
      mrIid: 3,
      headSha: "a".repeat(40),
      actorId: 11,
    });
    const job = store.claimNextWithLease(30_000);
    if (!job) throw new Error("expected a queued job to be claimed");
    const agent = new PiAgent(config, store);
    responseDelayMs = 350;
    const startedAt = Date.now();
    const result = await agent.generate(
      { systemPrompt: "Return JSON.", userPrompt: "Say ok." },
      temporaryDirectory,
      undefined,
      { jobId: job.id, attempt: job.attemptCount, taskType: job.type },
    );
    expect(Date.now() - startedAt).toBeGreaterThan(config.agent.requestTimeout);
    expect(result.content).toContain('"summary":"ok"');
    expect(result.model).toContain("test-model");
    expect(requestBody).toContain('"model":"test-model"');
    expect(requestBody).toContain('"stream":true');
    expect(requestBody).toContain('"name":"read_file"');
    expect(requestBody).toContain('"name":"web_fetch"');
    expect(requestBody).toContain("Additional blocked hosts: blocked.corp.dev");
    const trajectory = store.getJobDetails(job.id)?.trajectory;
    expect(trajectory).toHaveLength(4);
    expect(trajectory?.find((entry) => entry.kind === "tool" && entry.status === "succeeded")).toMatchObject({
      name: "read_file",
      round: 1,
      input: JSON.stringify({ path: "README.md" }),
      schema: expect.stringContaining("path"),
      output: expect.stringContaining("private repository content"),
      rawContent: JSON.stringify({ path: "README.md" }),
    });
    expect(trajectory?.find((entry) => entry.kind === "tool" && entry.status === "failed")).toMatchObject({
      name: "read_file",
      round: 1,
      input: JSON.stringify({ path: join(temporaryDirectory, "missing.txt") }),
      schema: expect.stringContaining("path"),
      output: expect.stringContaining("ENOENT"),
      rawContent: JSON.stringify({ path: join(temporaryDirectory, "missing.txt") }),
      errorDetail: expect.stringContaining("ENOENT"),
    });
    const llmTraces = trajectory?.filter((entry) => entry.kind === "llm").sort((left, right) => left.id - right.id);
    expect(llmTraces).toHaveLength(2);
    expect(llmTraces?.map((entry) => entry.round)).toEqual([1, 2]);
    expect(llmTraces).toMatchObject([
      {
        model: expect.stringContaining("test-model"),
        status: "succeeded",
        inputTokens: 8,
        outputTokens: 3,
        input: expect.stringContaining("Say ok."),
        output: expect.stringContaining("call-read-file"),
        rawContent: JSON.stringify({ systemPrompt: "Return JSON.", userPrompt: "Say ok." }),
      },
      {
        model: expect.stringContaining("test-model"),
        status: "succeeded",
        inputTokens: 14,
        outputTokens: 6,
        input: expect.stringContaining("private repository content"),
        output: expect.stringContaining("summary"),
      },
    ]);

    responseDelayMs = 5000;
    const timeoutStartedAt = Date.now();
    await expect(
      agent.generate(
        { systemPrompt: "Wait.", userPrompt: "Wait." },
        temporaryDirectory,
        undefined,
        { jobId: job.id, attempt: job.attemptCount, taskType: job.type },
      ),
    ).rejects.toThrow("Pi agent run failed");
    expect(Date.now() - timeoutStartedAt).toBeLessThan(4000);
    expect(store.getJobDetails(job.id)?.trajectory[0]).toMatchObject({
      kind: "llm",
      status: "failed",
    });
  }, 20_000);
});
