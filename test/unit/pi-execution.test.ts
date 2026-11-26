import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { PiAgent } from "../../src/agent/pi.js";
import { AppStore } from "../../src/store.js";
import type { ConversationStreamTool } from "../../src/model.js";
import type { ExecDelta } from "../../src/agent/execution/tool.js";

describe("PiAgent run_command integration", () => {
  let directory = "";
  let server: ReturnType<typeof createServer> | undefined;
  let store: AppStore | undefined;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
    server = undefined;
    store?.close();
    store = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("registers run_command and executes a real command when execution is enabled", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-pi-exec-"));
    let requestCount = 0;
    server = createServer((request, response) => {
      request.on("data", () => undefined);
      request.on("end", () => {
        if (request.url === "/tokenize") {
          response.writeHead(404, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        const current = requestCount++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (current === 0) {
          // 第一轮：模型调用 run_command。
          response.write(`data: ${JSON.stringify({
            id: "c1", object: "chat.completion.chunk", created: 1, model: "test-model",
            choices: [{ index: 0, delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: "call-run", type: "function", function: {
                name: "run_command", arguments: JSON.stringify({ command: "echo EXEC_OK" }),
              } }],
            }, finish_reason: null }],
          })}\n\n`);
          response.write(`data: ${JSON.stringify({
            id: "c1", object: "chat.completion.chunk", created: 1, model: "test-model",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          })}\n\n`);
        } else {
          // 第二轮：工具结果回来后给出最终答复。
          response.write(`data: ${JSON.stringify({
            id: "c2", object: "chat.completion.chunk", created: 1, model: "test-model",
            choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 },
          })}\n\n`);
        }
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
      execution: {
        enabled: true,
        backend: "local",
        sandbox: { runtime: "docker", image: "", socket: "", memory: "2g", cpus: 1, pidsLimit: 256, tmpfsSizeMb: 512, logMaxSizeMb: 4, logMaxFile: 2, network: "bridge", readOnlyMounts: [], timeoutMs: 10_000, maxOutputBytes: 4_096 },
        local: { allowUnsafe: true, timeoutMs: 10_000, maxOutputBytes: 4_096 },
      },
    } as unknown as CorvexConfig;

    const realStore = await AppStore.open(":memory:");
    store = realStore;
    const conversation = realStore.createConversation({
      ownerUserId: "u1", projectId: 7, projectName: "g/p", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 1, request: "run a command",
    });
    const agent = new PiAgent(config, realStore);
    const toolUpdates: ConversationStreamTool[] = [];
    const execDeltas: ExecDelta[] = [];
    const result = await agent.generate(
      {
        taskType: "conversation", conversationMode: "gitlab", conversationProjectId: 7,
        conversationId: conversation.conversationId, turnId: conversation.turnId, actorId: 1,
        systemPrompt: "Be brief.", userPrompt: "Run the command.",
        onToolDelta: (tool) => toolUpdates.push(tool),
        onExecDelta: (delta) => execDeltas.push(delta),
      },
      directory,
      undefined,
      {
        scope: { turnId: conversation.turnId },
        attempt: 1,
        taskType: "conversation",
        workspace: {
          projectId: 7,
          workspaceName: `conversation-${conversation.conversationId}`,
          path: directory,
          headSha: "a".repeat(40),
        },
      },
    );
    expect(result.content).toBe("Done.");
    const runCommands = toolUpdates.filter((tool) => tool.name === "run_command");
    expect(runCommands.length).toBeGreaterThan(0);
    // 工具事件按调用 ID 合并终态：最后一条应为成功。
    expect(runCommands.at(-1)?.status).toBe("succeeded");
    // exec 链路：输出增量按 execId（即工具调用 ID）上抛，并以 done 终态收尾。
    const execId = execDeltas[0]?.execId;
    expect(execId).toBeTruthy();
    expect(execDeltas.every((delta) => delta.execId === execId)).toBe(true);
    expect(execDeltas.some((delta) => delta.stream === "stdout" && delta.chunk.includes("EXEC_OK"))).toBe(true);
    const terminal = execDeltas.find((delta) => delta.done);
    expect(terminal).toMatchObject({ done: true, exitCode: 0, aborted: false });
    // 审计记录应包含本次命令执行。
    const audit = realStore.listAuditEvents(20);
    expect(audit.some((entry) => entry.action === "command_execution" && entry.result.includes("EXEC_OK"))).toBe(true);
  });
});
