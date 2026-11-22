import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { createSteerChannel, getAgentToolAccess, maxAgentPromptBytes, PiAgent } from "../../src/agent/pi.js";
import { AppStore } from "../../src/store.js";
import type { ConversationStreamTool } from "../../src/model.js";

describe("PiAgent", () => {
  let temporaryDirectory = "";
  let server: ReturnType<typeof createServer> | undefined;
  let store: AppStore | undefined;

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

  it("limits the web tools to conversations", () => {
    expect(getAgentToolAccess("conversation", { webEnabled: true, webSearchEnabled: true })).toEqual({ webFetch: true, webSearch: true });
    expect(getAgentToolAccess("conversation", { webEnabled: true, webSearchEnabled: false })).toEqual({ webFetch: true, webSearch: false });
    expect(getAgentToolAccess("conversation", { webEnabled: false, webSearchEnabled: true })).toEqual({ webFetch: false, webSearch: false });
  });

  it("uses the Pi SDK and the configured OpenAI-compatible provider", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-"));
    const requestBodies: string[] = [];
    let responseDelayMs = 0;
    let requestCount = 0;
    server = createServer((request, response) => {
      let requestBody = "";
      request.on("data", (chunk: Buffer) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        const currentRequest = requestCount++;
        requestBodies[currentRequest] = requestBody;
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
                        arguments: JSON.stringify({ path: "../outside-missing.txt" }),
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
              choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "先核对输入。", content: '{"summary":"ok",' }, finish_reason: null }],
            })}\n\n`,
          );
          setTimeout(() => {
            if (response.destroyed) return;
            response.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices: [{ index: 0, delta: { reasoning_content: "再确认 JSON 结构。", content: '"findings":[]}' }, finish_reason: null }],
              })}\n\n`,
            );
          }, 20);
          setTimeout(() => {
            if (response.destroyed) return;
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
          }, 40);
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
        blockedUserIds: [],
        botUsername: "",
      },
      storage: {
        root: temporaryDirectory,
        database: join(temporaryDirectory, "state.db"),
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        providerName: "Acme Models",
        apiKey: "test-key",
        // 每项请求的超时需要给 CI 留足余量：下面用注入延迟验证「总耗时超过单项超时」。
        requestTimeout: 3000,
        sessionTimeout: 10000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        webEnabled: true,
        webBlockedHosts: ["blocked.corp.dev"],
        webSearchEnabled: true,
        webSearchMaxQueries: 5,
        skillPaths: [],
        contextWindow: 131_072,
        maxInputTokens: 0,
        historyTokenBudget: 24_000,
        turnToolResultBytes: 2 << 20,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 20_000,
        summaryEnabled: true,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      events: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    } satisfies CorvexConfig;

    await writeFile(join(temporaryDirectory, "README.md"), "private repository content");
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      ownerUserId: "user-1", projectId: 7, projectName: "group/project",
      targetBranch: "main", headSha: "a".repeat(40), actorId: 11, request: "test",
    });
    const event = { id: created.turnId, conversationId: created.conversationId, attemptCount: 1, type: "conversation" as const };
    const agent = new PiAgent(config, store);
    const requestCountBeforeOversizedPrompt = requestCount;
    await expect(agent.generate(
      { taskType: "conversation", systemPrompt: "Return JSON.", userPrompt: "x".repeat(maxAgentPromptBytes * 8) },
      temporaryDirectory,
    )).rejects.toThrow("request budget");
    expect(requestCount).toBe(requestCountBeforeOversizedPrompt);
    responseDelayMs = 1600;
    const startedAt = Date.now();
    const streamUpdates: { reset: boolean; text: string }[] = [];
    const thinkingUpdates: { reset: boolean; text: string }[] = [];
    const toolUpdates: ConversationStreamTool[] = [];
    const result = await agent.generate(
      {
        taskType: "conversation",
        systemPrompt: "Return JSON.",
        userPrompt: "Say ok.",
        onTextDelta: (update) => streamUpdates.push(update),
        onThinkingDelta: (update) => thinkingUpdates.push(update),
        onToolDelta: (tool) => toolUpdates.push(tool),
      },
      temporaryDirectory,
      undefined,
      { scope: { turnId: event.id }, attempt: event.attemptCount, taskType: event.type },
    );
    expect(Date.now() - startedAt).toBeGreaterThan(config.agent.requestTimeout);
    expect(result.content).toContain('"summary":"ok"');
    // 工具调用轮只发 reset；正文轮按累计值推送，客户端漏事件也能自愈。
    expect(streamUpdates[0]).toEqual({ reset: true, text: "" });
    expect(streamUpdates.filter((update) => update.reset)).toHaveLength(2);
    const streamedTexts = streamUpdates.filter((update) => !update.reset).map((update) => update.text);
    expect(streamedTexts[0]).toBe('{"summary":"ok",');
    expect(streamedTexts.at(-1)).toBe('{"summary":"ok","findings":[]}');
    // 思考与正文分开推送：每次开始新一轮都先 reset，正文到达时思考按累计值独立给出。
    expect(thinkingUpdates.filter((update) => update.reset)).toHaveLength(2);
    expect(thinkingUpdates.filter((update) => !update.reset).map((update) => update.text)).toEqual([
      "先核对输入。",
      "先核对输入。再确认 JSON 结构。",
    ]);
    // 工具调用在思考之外单独推送，开始与结束各一条，带调用 ID 与脱敏参数。
    expect(toolUpdates).toHaveLength(4);
    expect(toolUpdates.every((tool) => tool.name === "read_file")).toBe(true);
    expect(new Set(toolUpdates.map((tool) => tool.id)).size).toBe(2);
    expect(toolUpdates.filter((tool) => tool.status === "running")).toHaveLength(2);
    const finishedTools = toolUpdates.filter((tool) => tool.status !== "running");
    expect(finishedTools.map((tool) => tool.status).sort()).toEqual(["failed", "succeeded"]);
    expect(toolUpdates.some((tool) => tool.input?.includes("README.md"))).toBe(true);
    expect(finishedTools.every((tool) => typeof tool.durationMs === "number")).toBe(true);
    expect(result.model).toBe("Acme Models/test-model");
    expect(requestBodies[0]).toContain('"model":"test-model"');
    expect(requestBodies[0]).toContain('"stream":true');
    expect(requestBodies[0]).toContain('"name":"read_file"');
    expect(requestBodies[0]).toContain('"name":"search_text"');
    expect(requestBodies[0]).toContain('"name":"web_fetch"');
    expect(requestBodies[0]).toContain('"name":"web_search"');
    expect(requestBodies[0]).toContain("Tavily's free keyless mode");
    expect(requestBodies[0]).toContain("Additional blocked hosts: blocked.corp.dev");
    const trajectory = store.getConversationTurn(event.conversationId, event.id)?.trajectory;
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
      input: JSON.stringify({ path: "../outside-missing.txt" }),
      schema: expect.stringContaining("path"),
      output: expect.stringContaining("repository-relative path"),
      rawContent: JSON.stringify({ path: "../outside-missing.txt" }),
      errorDetail: expect.stringContaining("repository-relative path"),
    });
    const llmTraces = trajectory?.filter((entry) => entry.kind === "llm").sort((left, right) => left.id - right.id);
    expect(llmTraces).toHaveLength(2);
    expect(llmTraces?.map((entry) => entry.round)).toEqual([1, 2]);
    expect(Number.isFinite(Date.parse(llmTraces?.[0]?.requestStartedAt ?? ""))).toBe(true);
    expect(llmTraces?.[0]?.responseHeadersMs).toBeGreaterThanOrEqual(1000);
    expect(llmTraces?.[0]?.firstTokenMs).toBeGreaterThanOrEqual(llmTraces?.[0]?.responseHeadersMs ?? Infinity);
    expect(JSON.parse(llmTraces?.[0]?.input ?? "{}")).toMatchObject({
      contextMode: "delta",
      contextReset: true,
    });
    expect(JSON.parse(llmTraces?.[0]?.input ?? "{}").systemPrompt).toContain("Return JSON.");
    expect(JSON.parse(llmTraces?.[1]?.input ?? "{}")).toMatchObject({
      contextMode: "delta",
      contextReset: false,
    });
    expect(llmTraces?.[0]?.input).toContain("Say ok.");
    expect(llmTraces?.[1]?.input).not.toContain("Say ok.");
    expect(llmTraces).toMatchObject([
      {
        model: "Acme Models/test-model",
        status: "succeeded",
        inputTokens: 8,
        outputTokens: 3,
        input: expect.stringContaining("Say ok."),
        output: expect.stringContaining("call-read-file"),
        rawContent: JSON.stringify({ taskType: "conversation", systemPrompt: "Return JSON.", userPrompt: "Say ok." }),
      },
      {
        model: "Acme Models/test-model",
        status: "succeeded",
        inputTokens: 14,
        outputTokens: 6,
        firstTokenMs: expect.any(Number),
        generationDurationMs: expect.any(Number),
        input: expect.stringContaining("private repository content"),
        output: expect.stringContaining("summary"),
      },
    ]);
    expect(llmTraces?.[1]?.generationDurationMs).toBeGreaterThan(0);

    responseDelayMs = 0;
    await agent.generate(
      { taskType: "conversation", systemPrompt: "Propose a patch.", userPrompt: "Fix the defect." },
      temporaryDirectory,
    );
    expect(requestBodies[2]).toContain('"name":"search_text"');
    expect(requestBodies[2]).toContain('"name":"web_fetch"');

    await agent.generate(
      { taskType: "conversation", systemPrompt: "Explain the file.", userPrompt: "Explain README." },
      temporaryDirectory,
    );
    expect(requestBodies[3]).toContain('"name":"web_fetch"');
    expect(requestBodies[3]).toContain('"name":"search_text"');

    responseDelayMs = 5000;
    const timeoutStartedAt = Date.now();
    await expect(
      agent.generate(
        { taskType: "conversation", systemPrompt: "Wait.", userPrompt: "Wait." },
        temporaryDirectory,
        undefined,
        { scope: { turnId: event.id }, attempt: event.attemptCount, taskType: event.type },
      ),
    ).rejects.toThrow("Pi agent run failed");
    expect(Date.now() - timeoutStartedAt).toBeLessThan(4000);
    expect(store.getConversationTurn(event.conversationId, event.id)?.trajectory[0]).toMatchObject({
      kind: "llm",
      status: "failed",
    });
  }, 20_000);

  it("keeps a long turn running past the tool-output soft budget", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-budget-"));
    let requestCount = 0;
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        const currentRequest = requestCount++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-budget",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{
              index: 0,
              delta: currentRequest === 0
                ? {
                    role: "assistant",
                    tool_calls: [{
                      index: 0,
                      id: "call-big-file",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "big.txt" }) },
                    }],
                  }
                : { role: "assistant", content: "partial answer" },
              finish_reason: null,
            }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-budget",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta: {}, finish_reason: currentRequest === 0 ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test API server has no TCP address");

    await writeFile(join(temporaryDirectory, "big.txt"), "x".repeat(8 << 10));
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      ownerUserId: "user-1", projectId: 7, projectName: "group/project",
      targetBranch: "main", headSha: "a".repeat(40), actorId: 11, request: "test",
    });
    const event = { id: created.turnId, conversationId: created.conversationId, attemptCount: 1, type: "conversation" as const };
    const agent = new PiAgent({
      server: { listen: "127.0.0.1:8080", readTimeout: 5000, shutdownTimeout: 30000 },
      operations: { username: "", password: "" },
      gitlab: {
        baseUrl: "https://gitlab.example.com",
        readToken: "read",
        writeToken: "write",
        blockedUserIds: [],
        botUsername: "",
      },
      storage: {
        root: temporaryDirectory,
        database: join(temporaryDirectory, "state.db"),
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        apiKey: "test-key",
        requestTimeout: 5000,
        sessionTimeout: 10_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        webEnabled: false,
        webBlockedHosts: [],
        skillPaths: [],
        contextWindow: 131_072,
        maxInputTokens: 0,
        historyTokenBudget: 24_000,
        turnToolResultBytes: 512,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 20_000,
        summaryEnabled: true,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      chat: { historyComments: 20 },
      events: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    }, store);

    const result = await agent.generate(
      { taskType: "conversation", systemPrompt: "Return JSON.", userPrompt: "Read big.txt." },
      temporaryDirectory,
      undefined,
      { scope: { turnId: event.id }, attempt: event.attemptCount, taskType: event.type },
    );
    expect(result.content).toBe("partial answer");
    expect(requestCount).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("asks the model to checkpoint before the tool budget is exhausted", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-checkpoint-"));
    const requestBodies: string[] = [];
    let requestCount = 0;
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        requestBodies[requestCount] = body;
        const currentRequest = requestCount++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-checkpoint",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{
              index: 0,
              delta: currentRequest === 0
                ? {
                    role: "assistant",
                    tool_calls: [{
                      index: 0,
                      id: "call-medium-file",
                      type: "function",
                      function: { name: "read_file", arguments: JSON.stringify({ path: "medium.txt" }) },
                    }],
                  }
                : { role: "assistant", content: "wrapped up" },
              finish_reason: null,
            }],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-checkpoint",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta: {}, finish_reason: currentRequest === 0 ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test API server has no TCP address");

    await writeFile(join(temporaryDirectory, "medium.txt"), "x".repeat(3_500));
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      ownerUserId: "user-1", projectId: 7, projectName: "group/project",
      targetBranch: "main", headSha: "a".repeat(40), actorId: 11, request: "test",
    });
    const event = { id: created.turnId, conversationId: created.conversationId, attemptCount: 1, type: "conversation" as const };
    const agent = new PiAgent({
      server: { listen: "127.0.0.1:8080", readTimeout: 5000, shutdownTimeout: 30000 },
      operations: { username: "", password: "" },
      gitlab: {
        baseUrl: "https://gitlab.example.com",
        readToken: "read",
        writeToken: "write",
        blockedUserIds: [],
        botUsername: "",
      },
      storage: {
        root: temporaryDirectory,
        database: join(temporaryDirectory, "state.db"),
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        apiKey: "test-key",
        requestTimeout: 5000,
        sessionTimeout: 10_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        webEnabled: false,
        webBlockedHosts: [],
        skillPaths: [],
        contextWindow: 131_072,
        maxInputTokens: 0,
        historyTokenBudget: 24_000,
        turnToolResultBytes: 4096,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 20_000,
        summaryEnabled: true,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      chat: { historyComments: 20 },
      events: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    }, store);

    const result = await agent.generate(
      { taskType: "conversation", systemPrompt: "Return JSON.", userPrompt: "Read medium.txt." },
      temporaryDirectory,
      undefined,
      { scope: { turnId: event.id }, attempt: event.attemptCount, taskType: event.type },
    );

    expect(result.content).toBe("wrapped up");
    expect(requestBodies[1]).toContain("tool-output budget");
    expect(requestBodies[1]).toContain("continue until the task is complete");
  }, 10_000);

  it("surfaces a provider error instead of returning the previous turn's reply", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-overflow-"));
    let requestCount = 0;
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        requestCount++;
        // 服务端拒绝超限请求时 prompt() 不会抛出：会话里最后一条助手消息是上一轮的历史回复，
        // 若被当成结果就会把过期的答复当成本轮成功输出。
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: {
            message: "This model's maximum context length is 131072 tokens. However, you requested about 999999 tokens.",
          },
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test API server has no TCP address");

    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      ownerUserId: "user-1", projectId: 7, projectName: "group/project",
      targetBranch: "main", headSha: "a".repeat(40), actorId: 11, request: "test",
    });
    const event = { id: created.turnId, conversationId: created.conversationId, attemptCount: 1, type: "conversation" as const };
    const agent = new PiAgent({
      server: { listen: "127.0.0.1:8080", readTimeout: 5000, shutdownTimeout: 30000 },
      operations: { username: "", password: "" },
      gitlab: {
        baseUrl: "https://gitlab.example.com",
        readToken: "read",
        writeToken: "write",
        blockedUserIds: [],
        botUsername: "",
      },
      storage: {
        root: temporaryDirectory,
        database: join(temporaryDirectory, "state.db"),
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        apiKey: "test-key",
        requestTimeout: 5000,
        sessionTimeout: 10_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        webEnabled: false,
        webBlockedHosts: [],
        skillPaths: [],
        contextWindow: 131_072,
        maxInputTokens: 0,
        historyTokenBudget: 24_000,
        turnToolResultBytes: 2 << 20,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 20_000,
        summaryEnabled: true,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      chat: { historyComments: 20 },
      events: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    }, store);

    await expect(
      agent.generate(
        {
          taskType: "conversation",
          systemPrompt: "Answer.",
          userPrompt: "Follow up question.",
          history: [
            { role: "user", content: "first question" },
            { role: "assistant", content: "STALE PRIOR ANSWER" },
          ],
        },
        temporaryDirectory,
        undefined,
        { scope: { turnId: event.id }, attempt: event.attemptCount, taskType: event.type },
      ),
    ).rejects.toThrow("maximum context length");
    // 超限会去掉历史重试一次，因此服务端应收到两次请求。
    expect(requestCount).toBe(2);
  }, 10_000);

  it("delivers a steered follow-up into the running turn", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-steer-"));
    const requestBodies: string[] = [];
    let requestCount = 0;
    let markFirstRequest = () => {};
    const firstRequest = new Promise<void>((resolve) => { markFirstRequest = resolve; });
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        const index = requestCount++;
        requestBodies[index] = body;
        const frame = (delta: object, finish: string | null, usage?: object) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-steer",
            object: "chat.completion.chunk",
            created: 1,
            model: "test-model",
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage ? { usage } : {}),
          })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (index === 0) {
          response.write(frame({
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call-steer-read",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
            }],
          }, "tool_calls"));
          response.write(frame({}, null, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }));
          response.end("data: [DONE]\n\n");
          markFirstRequest();
          return;
        }
        response.write(frame({ role: "assistant", content: "Done." }, null));
        response.write(frame({}, "stop", { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }));
        response.end("data: [DONE]\n\n");
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
        baseUrl: "https://gitlab.example.com", readToken: "read", writeToken: "write",
        blockedUserIds: [], botUsername: "",
      },
      storage: {
        root: temporaryDirectory,
        database: join(temporaryDirectory, "state.db"),
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model",
        providerName: "Acme Models", apiKey: "test-key", requestTimeout: 2000, sessionTimeout: 10000,
        maxOutputTokens: 4096, dailyTokenBudget: 0, webEnabled: false, webBlockedHosts: [],
        skillPaths: [], contextWindow: 131_072, maxInputTokens: 0, historyTokenBudget: 24_000,
        turnToolResultBytes: 2 << 20, compactionReserveTokens: 16_384, compactionKeepRecentTokens: 20_000,
        summaryEnabled: false,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      events: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    } satisfies CorvexConfig;
    await writeFile(join(temporaryDirectory, "README.md"), "repository content");
    store = await AppStore.open(":memory:");
    const steer = createSteerChannel();
    const running = new PiAgent(config, store).generate(
      { taskType: "conversation", systemPrompt: "Be concise.", userPrompt: "Original task", steer },
      temporaryDirectory,
    );
    await firstRequest;
    const disposition = await steer.send("Extra detail: use the other approach.");
    expect(disposition === "queued" || disposition === "handled").toBe(true);
    expect((await running).content).toBe("Done.");
    expect(requestCount).toBe(2);
    expect(requestBodies[1]).toContain("Extra detail: use the other approach.");
  }, 10_000);

  it("keeps steered text when a context overflow forces a fresh session", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "corvex-pi-steer-retry-"));
    const requestBodies: string[] = [];
    let requestCount = 0;
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        const index = requestCount++;
        requestBodies[index] = body;
        if (index === 0) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: { message: "This model's maximum context length is 131072 tokens. However, you requested about 999999 tokens." },
          }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: "chatcmpl-retry", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        response.write(frame({ role: "assistant", content: "Recovered." }, null));
        response.write(frame({}, "stop"));
        response.end("data: [DONE]\n\n");
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
        baseUrl: "https://gitlab.example.com", readToken: "read", writeToken: "write",
        blockedUserIds: [], botUsername: "",
      },
      storage: { root: temporaryDirectory, database: join(temporaryDirectory, "state.db"), retentionDays: 90, auditRetentionDays: 365 },
      agent: {
        responseLanguage: "en", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model",
        providerName: "Acme Models", apiKey: "test-key", requestTimeout: 2000, sessionTimeout: 10000,
        maxOutputTokens: 4096, dailyTokenBudget: 0, webEnabled: false, webBlockedHosts: [],
        skillPaths: [], contextWindow: 131_072, maxInputTokens: 0, historyTokenBudget: 24_000,
        turnToolResultBytes: 2 << 20, compactionReserveTokens: 16_384, compactionKeepRecentTokens: 20_000,
        summaryEnabled: false,
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      events: { pollInterval: 2000, eventTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    } satisfies CorvexConfig;
    store = await AppStore.open(":memory:");
    const steer = createSteerChannel();
    // 会话尚未创建时先缓冲，绑定后作为插话投递；随后第一次请求超限触发全新会话重试。
    expect(await steer.send("supplement survives retry")).toBe("buffered");
    const result = await new PiAgent(config, store).generate({
      taskType: "conversation",
      systemPrompt: "Be concise.",
      userPrompt: "Original task",
      history: [{ role: "user", content: "old history" }],
      steer,
    }, temporaryDirectory);
    expect(result.content).toBe("Recovered.");
    expect(requestCount).toBe(2);
    expect(requestBodies[1]).toContain("supplement survives retry");
    expect(requestBodies[1]).not.toContain("old history");
  }, 10_000);
});
