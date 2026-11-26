import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "../../src/store.js";
import { createTokenCipher } from "../../src/tokens.js";

describe("AppStore", () => {
  let directory = "";
  let store: AppStore | undefined;

  afterEach(async () => {
    store?.close();
    store = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("持久化用户思考等级并拒绝非法值", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7, projectName: "group/project", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "first",
    });
    void created;
    expect(store.getUserThinkingLevel("user-1")).toBeUndefined();
    expect(store.setUserThinkingLevel("user-1", "high")).toBe(true);
    expect(store.getUserThinkingLevel("user-1")).toBe("high");
    expect(store.setUserThinkingLevel("user-1", "extreme" as never)).toBe(false);
    expect(store.getUserThinkingLevel("user-1")).toBe("high");
  });

  it("持久化会话任务清单并清理", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7, projectName: "group/project", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "first",
    });
    expect(store.getConversationPlan(created.conversationId)).toBeUndefined();
    store.saveConversationPlan(created.conversationId, [
      { text: "read", status: "completed" },
      { text: "edit", status: "in_progress" },
    ]);
    expect(store.getConversationPlan(created.conversationId)?.steps).toEqual([
      { text: "read", status: "completed" },
      { text: "edit", status: "in_progress" },
    ]);
    store.saveConversationPlan(created.conversationId, []);
    expect(store.getConversationPlan(created.conversationId)).toBeUndefined();
  });

  it("下一轮的历史只包含消息正文，不包含下一步建议", async () => {
    store = await AppStore.open(":memory:");
    const first = store.createConversation({
      projectId: 7, projectName: "group/project", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "first",
    });
    store.claimConversationTurn(first.turnId);
    // 完成时附带建议；建议只写入 suggestions 列，不得进入 content。
    store.finishConversationTurn(first.turnId, "Clean answer", "test-model", ["查看改动"]);
    const second = store.addConversationMessage(first.conversationId, {
      projectId: 7, targetBranch: "main", headSha: "b".repeat(40), actorId: 0, request: "second",
    });
    const claimed = store.claimConversationTurn(second.turnId);
    expect(claimed?.history.some((message) => message.content.includes("查看改动"))).toBe(false);
    expect(claimed?.history.some((message) => message.content.includes("Clean answer"))).toBe(true);
  });

  it("持久化并清理会话的完整 Pi 会话条目", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7, projectName: "group/project", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "first",
    });
    expect(store.conversationSessionEntries(created.conversationId)).toBeUndefined();
    store.saveConversationSessionEntries(created.conversationId, '[{"type":"session","id":"s1","timestamp":"t","cwd":"/tmp"}]');
    expect(store.conversationSessionEntries(created.conversationId)).toContain('"type":"session"');
    // 覆盖写入而不是重复插入。
    store.saveConversationSessionEntries(created.conversationId, '[{"type":"session","id":"s2","timestamp":"t","cwd":"/tmp"}]');
    expect(store.conversationSessionEntries(created.conversationId)).toContain('"s2"');
    store.deleteConversationSessionEntries(created.conversationId);
    expect(store.conversationSessionEntries(created.conversationId)).toBeUndefined();
  });

  it("删除对话时同时清理持久化会话", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7, projectName: "group/project", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "first",
    });
    store.saveConversationSessionEntries(created.conversationId, "[]");
    expect(store.deleteConversation(created.conversationId)).toBe(true);
    expect(store.conversationSessionEntries(created.conversationId)).toBeUndefined();
  });

  it("为旧库的 conversation_turns 补齐 model 列", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-"));
    const databasePath = join(directory, "state.db");
    const first = await AppStore.open(databasePath);
    first.close();
    // 模拟旧库：conversation_turns 已存在但没有 model 列。
    const raw = new DatabaseSync(databasePath);
    raw.exec("ALTER TABLE conversation_turns DROP COLUMN model");
    raw.exec("ALTER TABLE conversations ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    raw.close();

    store = await AppStore.open(databasePath);
    expect(store.listConversations(10, 0).items).toEqual([]);
    const inspector = new DatabaseSync(databasePath);
    const turnColumns = (inspector.prepare("PRAGMA table_info(conversation_turns)").all() as { name: string }[])
      .map((column) => column.name);
    const conversationColumns = (inspector.prepare("PRAGMA table_info(conversations)").all() as { name: string }[])
      .map((column) => column.name);
    inspector.close();
    expect(turnColumns).toContain("model");
    expect(conversationColumns).not.toContain("model");
  });

  it("管理模型供应商与模型，并迁移旧的模型运行时设置", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-"));
    store = await AppStore.open(join(directory, "state.db"));
    store.setRuntimeSetting("model", "legacy-model", "ops");
    store.setRuntimeSetting("model_base_url", "https://legacy.example.com/v1", "ops");
    store.setRuntimeSetting("model_api_key", "legacy-key", "ops");
    store.setRuntimeSetting("context_window", "65536", "ops");

    // 升级后第一次启动：旧覆盖项变成「供应商 + 模型」，旧键被清掉。
    const migrated = store.migrateLegacyModelSettings({ contextWindow: 131_072, maxOutputTokens: 4_096 }, 0);
    expect(migrated).toMatchObject({
      provider: { name: "legacy.example.com", baseUrl: "https://legacy.example.com/v1", apiKey: "legacy-key" },
      model: { name: "legacy-model", contextWindow: 65_536, maxOutputTokens: 4_096, active: true },
    });
    expect(store.migrateLegacyModelSettings({ contextWindow: 131_072, maxOutputTokens: 4_096 }, 0)).toBeUndefined();
    expect(store.listRuntimeSettings().some((row) => row.key === "model")).toBe(false);

    // 供应商下新增模型：第一个全局模型已是当前项时，新模型默认不激活，可显式切换。
    const provider = store.createModelProvider({ name: "example", baseUrl: "https://api.example.com/v1", apiKey: "" });
    const second = store.createProviderModel(provider.id, {
      name: "second-model",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    });
    expect(second).toMatchObject({ providerId: provider.id, active: false });
    expect(store.activateProviderModel(provider.id, second!.id)?.active).toBe(true);
    expect(store.getActiveModel()?.provider.id).toBe(provider.id);
    expect(store.getActiveModel()?.model.id).toBe(second!.id);

    // 删除当前模型会提升剩余的第一个；删除供应商会级联删除其模型。
    expect(store.deleteProviderModel(provider.id, second!.id)).toBe(true);
    expect(store.getActiveModel()?.model.id).toBe(migrated!.model.id);
    expect(store.deleteModelProvider(migrated!.provider.id)).toBe(true);
    expect(store.listModelProviders()).toHaveLength(1);
    expect(store.listModelProviders()[0]?.models).toEqual([]);
  });

  it("用户专属供应商与系统供应商共存且相互隔离", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-user-models-"));
    store = await AppStore.open(join(directory, "state.db"));
    const system = store.createModelProvider({ name: "system", baseUrl: "https://api.system.example/v1", apiKey: "sk-system" });
    const mine = store.createModelProvider({ name: "mine", baseUrl: "https://api.mine.example/v1", apiKey: "sk-mine" }, "user-1");
    expect(system.ownerUserId).toBe("");
    expect(mine.ownerUserId).toBe("user-1");

    // 两条记录的 created_at 可能相同，顺序交由 SQL 决定；这里只验证集合与隔离性。
    expect(store.listModelProvidersForUser("user-1").map((provider) => provider.id).sort()).toEqual([system.id, mine.id].sort());
    expect(store.listModelProvidersForUser("user-2").map((provider) => provider.id)).toEqual([system.id]);
    expect(store.getModelProvider(mine.id, "user-2")).toBeUndefined();

    const model = store.createProviderModel(mine.id, {
      name: "my-model", contextWindow: 131_072, maxOutputTokens: 8_192,
    }, "user-1")!;
    expect(model.active).toBe(false);
    expect(store.createProviderModel(mine.id, {
      name: "other", contextWindow: 131_072, maxOutputTokens: 8_192,
    }, "user-2")).toBeUndefined();
    expect(store.updateModelProvider(mine.id, { name: "hacked", baseUrl: "https://evil.example/v1", apiKey: "" }, "user-2")).toBeUndefined();

    expect(store.setUserModelSelection("user-1", mine.id, model.id)).toBe(true);
    expect(store.setUserModelSelection("user-2", mine.id, model.id)).toBe(false);
    expect(store.getActiveModelForUser("user-1")?.model.id).toBe(model.id);
    expect(store.getActiveModelForUser("user-2")).toBeUndefined();
    expect(store.deleteModelProvider(mine.id, "user-2")).toBe(false);
    expect(store.deleteModelProvider(mine.id, "user-1")).toBe(true);
    expect(store.getActiveModelForUser("user-1")).toBeUndefined();
  });

  it("累计上下文治理指标", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-"));
    store = await AppStore.open(join(directory, "state.db"));
    store.recordContextMetric("compaction", 1);
    store.recordContextMetric("compaction", 1);
    store.recordContextMetric("microcompact_chars", 4200);
    expect(store.contextMetrics()).toEqual(expect.arrayContaining([
      { key: "compaction", value: 2 },
      { key: "microcompact_chars", value: 4200 },
    ]));
  });

  it("记录上下文变化轨迹并纳入对话过程快照", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-"));
    store = await AppStore.open(join(directory, "state.db"));
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Check context notices",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    const traceId = store.startTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "context",
      "context.compact",
      "",
      null,
      { input: JSON.stringify({ reason: "threshold", tokensBefore: 42_000 }) },
    );
    store.finishTrace(traceId, "succeeded", 0);
    store.saveConversationTurnProcess(claimed.turnId, [
      { kind: "context", id: "ctx-1", text: "上下文已压缩：42000 → 12000 token" },
    ]);
    store.finishConversationTurn(claimed.turnId, "done");

    expect(store.getConversationTurn(created.conversationId, claimed.turnId)?.trajectory)
      .toEqual([expect.objectContaining({ kind: "context", name: "context.compact", status: "succeeded" })]);
    expect(store.getConversation(created.conversationId)?.messages[1]?.process)
      .toEqual([{ kind: "context", id: "ctx-1", text: "上下文已压缩：42000 → 12000 token" }]);
  });

  it("过程快照保留命令输出并在读取时脱敏限长", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-exec-process-"));
    store = await AppStore.open(join(directory, "state.db"));
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Run a command",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    store.saveConversationTurnProcess(claimed.turnId, [
      {
        kind: "tool",
        id: "call-1",
        name: "run_command",
        input: JSON.stringify({ command: "echo hello" }),
        status: "succeeded",
        durationMs: 5,
        execOutput: {
          stdout: `Bearer abcdefghijklmnopqrstuvwxyz\n${"x".repeat(40_000)}`,
          stderr: "warn",
          exitCode: 0,
          aborted: false,
        },
      },
    ]);

    const turn = store.getConversationTurn(created.conversationId, claimed.turnId);
    const entry = turn?.process.find((item) => item.kind === "tool" && item.id === "call-1");
    expect(entry?.kind).toBe("tool");
    if (entry?.kind !== "tool" || !entry.execOutput) throw new Error("execOutput was dropped on read");
    expect(entry.execOutput.stdout).toContain("Bearer [REDACTED]");
    expect(entry.execOutput.stdout.length).toBeLessThanOrEqual(32_000);
    expect(entry.execOutput.truncated).toBe(true);
    expect(entry.execOutput.stderr).toBe("warn");
    expect(entry.execOutput.exitCode).toBe(0);
  });

  it("preserves scheduled task cards in the turn process snapshot", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 1, projectName: "g/p", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "schedule", ownerUserId: "u1",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    const card = {
      type: "created" as const,
      task: {
        id: "abcd1234", prompt: "check CI", kind: "cron" as const, cron: "0 9 * * 1",
        runAt: "", timezone: "UTC", nextRunAt: "2026-11-30T09:00:00.000Z", status: "active",
      },
    };
    store.saveConversationTurnProcess(claimed.turnId, [{ kind: "scheduleCard", card }]);
    const entries = store.getConversationTurn(created.conversationId, claimed.turnId)?.process ?? [];
    expect(entries).toEqual([{ kind: "scheduleCard", card }]);
  });

  it("把旧的 model_profiles 表拆分为供应商与模型", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-store-"));
    const databasePath = join(directory, "state.db");
    store = await AppStore.open(databasePath);
    store.close();
    // 模拟上一版：供应商与模型混在一张表。
    const raw = new DatabaseSync(databasePath);
    raw.exec("DROP TABLE provider_models");
    raw.exec("DROP TABLE model_providers");
    raw.exec(`CREATE TABLE model_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
      context_window INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const insert = raw.prepare(
      "INSERT INTO model_profiles (id,name,base_url,api_key,context_window,max_output_tokens,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    insert.run("p1", "model-a", "https://api.example.com/v1", "key", 32_768, 4_096, 0, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
    insert.run("p2", "model-b", "https://api.example.com/v1", "key", 131_072, 8_192, 1, "2025-01-02T00:00:00.000Z", "2025-01-02T00:00:00.000Z");
    raw.close();

    store = await AppStore.open(databasePath);
    const providers = store.listModelProviders();
    // 同一个 Base URL 与密钥合并成一个供应商，模型全部保留。
    expect(providers).toHaveLength(1);
    expect(providers[0]?.models.map((model) => model.name)).toEqual(["model-a", "model-b"]);
    expect(store.getActiveModel()?.model.name).toBe("model-b");
  });

  it("round-trips encrypted user tokens and sessions", async () => {
    store = await AppStore.open(":memory:");
    const cipher = createTokenCipher("test-secret");
    const user = store.upsertUser({
      gitlabUserId: 42,
      username: "developer",
      name: "Developer",
      avatarUrl: "https://example.com/avatar.png",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 123_456,
    }, cipher);
    expect(user).toMatchObject({ gitlabUserId: 42, username: "developer", accessToken: "access-secret" });

    const session = store.createUserSession(user.id, Date.now() + 60_000);
    expect(store.readUserSession(session)?.userId).toBe(user.id);
    store.deleteUserSession(session);
    expect(store.readUserSession(session)).toBeUndefined();
    expect(user.isAdmin).toBe(true);

    const second = store.upsertUser({
      gitlabUserId: 43,
      username: "viewer",
      name: "Viewer",
      avatarUrl: "",
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
    }, cipher);
    expect(second.isAdmin).toBe(false);
    expect(store.listUsers()).toHaveLength(2);
    expect(store.setUserAdmin(second.id, true)).toBe(true);
    expect(store.readUser(second.id, cipher)?.isAdmin).toBe(true);
    expect(store.setUserAdmin(user.id, false)).toBe(true);
    expect(() => store.setUserAdmin(second.id, false)).toThrow("at least one administrator");
  });

  it("does not let an operator revoke their own administrator access", async () => {
    store = await AppStore.open(":memory:");
    const cipher = createTokenCipher(store.getOrCreateSessionSecret());
    const user = store.upsertUser({
      gitlabUserId: 70, username: "admin", name: "Admin", avatarUrl: "",
      accessToken: "", refreshToken: "", expiresAt: 0,
    }, cipher);
    expect(() => store.setUserAdmin(user.id, false, user.id)).toThrow("your own administrator");
    expect(store.readUser(user.id, cipher)?.isAdmin).toBe(true);
  });

  it("disabling a user clears tokens, deletes sessions and cannot target an administrator", async () => {
    store = await AppStore.open(":memory:");
    const cipher = createTokenCipher(store.getOrCreateSessionSecret());
    const user = store.upsertUser({
      gitlabUserId: 60,
      username: "llb",
      name: "User",
      avatarUrl: "",
      accessToken: "secret-token",
      refreshToken: "secret-refresh",
      expiresAt: Date.now() + 3_600_000,
    }, cipher);
    const session = store.createUserSession(user.id, Date.now() + 3_600_000);

    // 管理员账号必须先取消管理员身份才能禁用；先造第二个管理员以满足“至少一名管理员”。
    expect(() => store.setUserDisabled(user.id, true)).toThrow("administrator");
    expect(store.readUser(user.id, cipher)?.disabled).toBe(false);
    const second = store.upsertUser({
      gitlabUserId: 61, username: "second", name: "Second", avatarUrl: "",
      accessToken: "", refreshToken: "", expiresAt: 0,
    }, cipher);
    expect(store.setUserAdmin(second.id, true)).toBe(true);
    expect(store.setUserAdmin(user.id, false)).toBe(true);
    expect(store.setUserDisabled(user.id, true)).toBe(true);
    const disabled = store.readUser(user.id, cipher);
    expect(disabled?.disabled).toBe(true);
    expect(disabled?.accessToken).toBe("");
    expect(disabled?.refreshToken).toBe("");
    expect(disabled?.tokenExpiresAt).toBe(0);
    expect(store.readUserSession(session)).toBeUndefined();

    // 重新 OAuth 登录不能恢复令牌（upsertUser 对禁用用户跳过更新）。
    store.upsertUser({
      gitlabUserId: 60,
      username: "llb",
      name: "User",
      avatarUrl: "",
      accessToken: "new-secret-token",
      refreshToken: "new-secret-refresh",
      expiresAt: Date.now() + 3_600_000,
    }, cipher);
    expect(store.readUser(user.id, cipher)?.accessToken).toBe("");

    expect(store.setUserDisabled(user.id, false)).toBe(true);
    expect(store.readUser(user.id, cipher)?.disabled).toBe(false);
  });

  it("stores conversation uploads and cascades them on delete", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7, projectName: "g/p", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "owner", ownerUserId: "u1",
    });
    const upload = store.createConversationUpload({
      id: "upload1", conversationId: created.conversationId, ownerUserId: "u1",
      filename: "notes.txt", mime: "text/plain", sizeBytes: 12,
      storagePath: "uploads/c1/upload1/notes.txt", sha256: "abc",
    });
    expect(upload).toMatchObject({ filename: "notes.txt", mime: "text/plain", sizeBytes: 12 });
    expect(store.listConversationUploads(created.conversationId)).toHaveLength(1);
    expect(store.getConversationUpload("upload1")?.conversationId).toBe(created.conversationId);
    expect(store.deleteConversationUpload("upload1")).toBe(true);
    expect(store.getConversationUpload("upload1")).toBeUndefined();

    // 附件绑定到轮次：只有该轮能读到，且用户删除后自动从清单消失。
    // 先结束 createConversation 自带的首轮，否则 addConversationMessage 会拒绝。
    store.claimConversationTurn(created.turnId);
    store.finishConversationTurn(created.turnId, "ok");
    store.createConversationUpload({
      id: "turn-upload", conversationId: created.conversationId, ownerUserId: "u1",
      filename: "turn.txt", mime: "text/plain", sizeBytes: 3,
      storagePath: "uploads/c1/turn-upload/turn.txt", sha256: "y",
    });
    const turn = store.addConversationMessage(created.conversationId, {
      ownerUserId: "u1", projectId: 7, targetBranch: "main", headSha: "a".repeat(40),
      actorId: 0, request: "read it", uploadIds: ["turn-upload"],
    });
    expect(store.getTurnUploads(turn.turnId).map((item) => item.id)).toEqual(["turn-upload"]);
    store.deleteConversationUpload("turn-upload");
    expect(store.getTurnUploads(turn.turnId)).toEqual([]);

    // 重新建一条，验证会话删除时从表清空（落盘目录由 hook 清理）。
    store.createConversationUpload({
      id: "upload2", conversationId: created.conversationId, ownerUserId: "u1",
      filename: "a.txt", mime: "text/plain", sizeBytes: 1,
      storagePath: "uploads/c1/upload2/a.txt", sha256: "x",
    });
    store.deleteConversation(created.conversationId);
    expect(store.listConversationUploads(created.conversationId)).toHaveLength(0);
  });

  it("manages scheduled tasks with atomic claim and run records", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7, projectName: "g/p", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "owner", ownerUserId: "u1",
    });
    const task = store.createScheduledTask({
      ownerUserId: "u1",
      conversationId: created.conversationId,
      prompt: "check CI",
      kind: "cron",
      cron: "0 9 * * *",
      runAt: "",
      nextRunAt: "2026-11-27T09:00:00.000Z",
      expiresAt: "2026-12-27T09:00:00.000Z",
    });
    expect(task.id).toMatch(/^[0-9a-f]{8}$/);
    expect(task.status).toBe("active");
    expect(store.getScheduledTask(task.id)).toMatchObject({ prompt: "check CI", cron: "0 9 * * *" });
    expect(store.listScheduledTasks("u1")).toHaveLength(1);
    expect(store.listScheduledTasks("other")).toHaveLength(0);

    // 到期查询与原子领取：只有 next_run_at 精确匹配时才能领取，且先推进再执行。
    expect(store.dueScheduledTasks("2026-11-27T09:00:00.000Z")).toHaveLength(1);
    expect(store.claimDueScheduledTask(task.id, "2026-11-27T08:00:00.000Z", "2026-11-28T09:00:00.000Z")).toBeUndefined();
    expect(store.claimDueScheduledTask(task.id, "2026-11-27T09:00:00.000Z", "2026-11-28T09:00:00.000Z"))
      .toMatchObject({ id: task.id, nextRunAt: "2026-11-28T09:00:00.000Z" });
    expect(store.claimDueScheduledTask(task.id, "2026-11-27T09:00:00.000Z", "2026-11-29T09:00:00.000Z")).toBeUndefined();

    store.completeScheduledTask({
      id: task.id, status: "succeeded", turnId: "turn-1", error: "Bearer secret-token leaked",
      delete: false, finishedAt: "2026-11-27T09:01:00.000Z",
    });
    expect(store.getScheduledTask(task.id)).toMatchObject({ lastStatus: "succeeded", lastRunAt: "2026-11-27T09:01:00.000Z" });
    expect(store.getScheduledTask(task.id)!.lastError).not.toContain("secret-token");
    const runs = store.listScheduledTaskRuns(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", turnId: "turn-1" });
    expect(runs[0].error).not.toContain("secret-token");

    // 暂停/删除按 owner 隔离。
    expect(store.setScheduledTaskStatus(task.id, "other", "paused")).toBe(false);
    expect(store.setScheduledTaskStatus(task.id, "u1", "paused")).toBe(true);
    expect(store.dueScheduledTasks("2027-01-01T00:00:00.000Z")).toHaveLength(0);
    expect(store.deleteScheduledTask(task.id, "other")).toBe(false);
    expect(store.deleteScheduledTask(task.id, "u1")).toBe(true);
    expect(store.getScheduledTask(task.id)).toBeUndefined();
  });

  it("advances overdue tasks on recovery without running them", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7, projectName: "g/p", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "owner", ownerUserId: "u1",
    });
    store.createScheduledTask({
      ownerUserId: "u1", conversationId: created.conversationId, prompt: "once", kind: "once",
      cron: "", runAt: "2026-11-20T09:00:00.000Z", nextRunAt: "2026-11-20T09:00:00.000Z", expiresAt: "",
    });
    expect(store.advanceOverdueScheduledTasks("2026-11-27T09:00:00.000Z", "2026-11-27T10:00:00.000Z")).toBe(1);
    expect(store.dueScheduledTasks("2026-11-27T09:00:00.000Z")).toHaveLength(0);
  });

  it("persists the conversation sync base independently of the turn snapshot", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    expect(store.getConversation(created.conversationId)?.baseSha).toBe("a".repeat(40));
    expect(store.getConversation(created.conversationId)?.baseBranch).toBe("main");
    const updated = "f".repeat(40);
    store.setConversationBaseSha(created.conversationId, updated, "fix/asar");
    expect(store.getConversation(created.conversationId)?.baseSha).toBe(updated);
    expect(store.getConversation(created.conversationId)?.baseBranch).toBe("fix/asar");
    // 推进基线不应改变轮次快照，也不应把对话排到列表最前。
    expect(store.getConversation(created.conversationId)?.messages[0]?.headSha).toBe("a".repeat(40));
    expect(() => store.setConversationBaseSha(created.conversationId, "short", "main")).toThrow("base SHA is invalid");
  });

  it("serializes conversation turns and reflects retry and cancellation states", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    expect(() => store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Overlapping turn",
    })).toThrow("conversation already has an active turn");

    expect(store.claimConversationTurn(created.turnId)).toMatchObject({ turnId: created.turnId, attempt: 1 });
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({ status: "running" });
    store.cancelConversationTurn(created.turnId, "This turn was cancelled.");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      status: "failed",
      content: "This turn was cancelled.",
      turnStatus: "cancelled",
    });
    expect(store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Try again after cancellation",
    }).turnId).toBeTruthy();
  });

  it("appends a user interjection to a running turn without creating a new turn", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    store.claimConversationTurn(created.turnId);
    store.appendUserMessage(created.conversationId, "  Also keep the tests.  ");
    const conversation = store.getConversation(created.conversationId);
    expect(conversation?.messages).toHaveLength(3);
    expect(conversation?.messages[2]).toMatchObject({
      role: "user",
      content: "Also keep the tests.",
      status: "completed",
      turnId: null,
      headSha: "a".repeat(40),
    });
    expect(conversation?.messages[1]).toMatchObject({ role: "assistant", status: "running" });
    expect(store.getConversationTurn(created.conversationId, created.turnId)?.request).toBe("First turn");
    expect(() => store.appendUserMessage(created.conversationId, "  ")).toThrow("between 1 and 20000");
    store.finishConversationTurn(created.turnId, "Done", "test-model");
    expect(() => store.appendUserMessage(created.conversationId, "After the turn")).toThrow("no active turn");
  });

  it("keeps a durable FIFO follow-up queue with reorder, removal and restore", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    expect(() => store.enqueueFollowUp(created.conversationId, "  ")).toThrow("between 1 and 20000");
    const first = store.enqueueFollowUp(created.conversationId, "first follow-up");
    const second = store.enqueueFollowUp(created.conversationId, "second follow-up");
    const contents = () => store.listFollowUps(created.conversationId).map((item) => item.content);
    expect(contents()).toEqual(["first follow-up", "second follow-up"]);
    expect(store.moveFollowUp(created.conversationId, second.id, "up")).toBe(true);
    expect(contents()).toEqual(["second follow-up", "first follow-up"]);
    // 队首不能再上移；队尾不能再下移。
    expect(store.moveFollowUp(created.conversationId, second.id, "up")).toBe(false);
    expect(store.moveFollowUp(created.conversationId, first.id, "down")).toBe(false);
    expect(store.removeFollowUp(created.conversationId, first.id)).toBe(true);
    expect(contents()).toEqual(["second follow-up"]);
    const taken = store.takeNextFollowUp(created.conversationId);
    expect(taken?.content).toBe("second follow-up");
    expect(contents()).toEqual([]);
    store.restoreFollowUp(created.conversationId, taken!.content);
    expect(store.conversationsWithFollowUps()).toContain(created.conversationId);
    expect(contents()).toEqual(["second follow-up"]);
    // 删除对话时排队消息随外键级联清理。
    store.deleteConversation(created.conversationId);
    expect(store.conversationsWithFollowUps()).not.toContain(created.conversationId);
  });

  it("stores a model-generated conversation title once and ignores later writes", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Explain the routing module",
    });
    // 新对话标题为空，界面回退到项目名。
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ id: created.conversationId, title: "" });

    store.saveConversationTitle(created.conversationId, "  路由模块说明  ");
    expect(store.listConversations(10, 0).items[0]?.title).toBe("路由模块说明");
    expect(store.getConversation(created.conversationId)?.title).toBe("路由模块说明");

    // 只写入一次：后续轮次不会覆盖首轮标题。
    store.saveConversationTitle(created.conversationId, "Another title");
    expect(store.getConversation(created.conversationId)?.title).toBe("路由模块说明");

    // 空白标题被忽略，超长标题按字符数截断。
    store.saveConversationTitle("blank-title", "   ");
    expect(() => store.saveConversationTitle("missing-conversation", "Title")).toThrow("not found");
    const longTitle = "字".repeat(200);
    store.saveConversationTitle(created.conversationId, longTitle);
    expect(store.getConversation(created.conversationId)?.title).toBe("路由模块说明");

    const second = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Second",
    });
    store.saveConversationTitle(second.conversationId, longTitle);
    expect(store.getConversation(second.conversationId)?.title.length).toBe(120);
  });

  it("exposes each conversation turn's own trajectory and execution records", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Explain the routing module",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    const traceId = store.startTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "llm",
      "conversation",
      "test/model",
      JSON.stringify({ systemPrompt: "Answer read-only.", userPrompt: "Explain routing." }),
      { round: 1, input: "conversation context" },
    );
    store.finishTrace(traceId, "succeeded", 80, 40, 20, undefined, "assistant response");
    store.recordExecutionStep({
      turnId: claimed.turnId,
      attempt: claimed.attempt,
      step: "workflow.gitlab_conversation",
      status: "succeeded",
      input: { requestCharacters: 24 },
      output: { textBytes: 18 },
    });
    store.finishConversationTurn(claimed.turnId, "Routing lives in routing.ts.", "gpt-test");
    expect(store.getConversation(created.conversationId)?.messages.find((message) => message.role === "assistant")?.model)
      .toBe("gpt-test");

    const turn = store.getConversationTurn(created.conversationId, created.turnId);
    expect(turn).toMatchObject({
      conversationId: created.conversationId,
      messageId: expect.any(String),
      turnId: created.turnId,
      status: "completed",
      request: "Explain the routing module",
      headSha: "a".repeat(40),
      attemptCount: 1,
    });
    expect(turn?.trajectory).toHaveLength(1);
    expect(turn?.trajectory[0]).toMatchObject({ kind: "llm", status: "succeeded", output: "assistant response" });
    expect(turn?.events.some((step) => step.step === "workflow.gitlab_conversation")).toBe(true);
    expect(turn?.timeline.some((transition) => transition.to === "completed")).toBe(true);
    // 轮次记录必须绑定到该对话，跨对话或未知轮次返回 undefined。
    expect(store.getConversationTurn("other-conversation", created.turnId)).toBeUndefined();
    expect(store.getConversationTurn(created.conversationId, "missing-turn")).toBeUndefined();
  });

  it("redacts credentials from trace input and output at the storage boundary", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Check trace redaction",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    const secret = "glpat-abcdefghijklmnopqrstuvwx";
    const traceId = store.startTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "context",
      "context.compact",
      "",
      null,
      { input: JSON.stringify({ before: { messages: [{ text: `token: ${secret}` }] } }) },
    );
    store.finishTrace(traceId, "succeeded", 0, undefined, undefined, undefined,
      JSON.stringify({ after: { summary: `password: hunter2` } }));

    const entries = store.getTraceEntries({ kind: "conversation", turnId: claimed.turnId }, claimed.attempt);
    const trace = entries.find((entry) => entry.name === "context.compact");
    expect(trace?.input).not.toContain(secret);
    expect(trace?.output).not.toContain("hunter2");
    expect(trace?.input).toContain("[REDACTED]");
    expect(trace?.output).toContain("[REDACTED]");
  });

  it("merges every turn of a conversation into one ordered timeline", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First question",
    });
    const first = store.claimConversationTurn(created.turnId);
    if (!first) throw new Error("expected the first turn to be claimed");
    const firstTrace = store.startTrace(
      { kind: "conversation", turnId: first.turnId },
      first.attempt,
      "llm",
      "conversation",
      "test/model",
      null,
      { round: 1, input: "first context" },
    );
    store.finishTrace(firstTrace, "succeeded", 50, 10, 5, undefined, "First answer.");
    store.recordExecutionStep({
      turnId: first.turnId,
      attempt: first.attempt,
      step: "workflow.gitlab_conversation",
      status: "succeeded",
    });
    store.finishConversationTurn(first.turnId, "First answer.");

    const added = store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Second question",
    });
    const second = store.claimConversationTurn(added.turnId);
    if (!second) throw new Error("expected the second turn to be claimed");
    const secondTrace = store.startTrace(
      { kind: "conversation", turnId: second.turnId },
      second.attempt,
      "llm",
      "conversation",
      "test/model",
      null,
      { round: 1, input: "second context" },
    );
    store.finishTrace(secondTrace, "succeeded", 70, 12, 6, undefined, "Second answer.");
    store.recordExecutionStep({
      turnId: second.turnId,
      attempt: second.attempt,
      step: "workflow.gitlab_conversation",
      status: "succeeded",
    });
    store.finishConversationTurn(second.turnId, "Second answer.");

    const merged = store.getConversationTurns(created.conversationId);
    expect(merged?.conversationId).toBe(created.conversationId);
    // 轮次按创建时间升序，轨迹条目各自带回所属轮次，前端据此分段。
    expect(merged?.turns.map((turn) => turn.turnId)).toEqual([first.turnId, second.turnId]);
    expect(merged?.turns.map((turn) => turn.request)).toEqual(["First question", "Second question"]);
    expect(merged?.trajectory.map((entry) => entry.output)).toEqual(["First answer.", "Second answer."]);
    expect(merged?.trajectory.map((entry) => entry.turnId)).toEqual([first.turnId, second.turnId]);
    expect(merged?.events).toHaveLength(2);
    // 未注册的对话返回 undefined，端点据此给出 404。
    expect(store.getConversationTurns("missing-conversation")).toBeUndefined();
  });

  it("counts conversation turns and surfaces the latest turn status", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ turnCount: 1, lastTurnStatus: "queued" });
    const first = store.claimConversationTurn(created.turnId);
    if (!first) throw new Error("expected the first conversation turn to be claimed");
    store.finishConversationTurn(first.turnId, "First answer");
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({
      turnStatus: "completed",
      traceCount: 0,
      stepCount: 0,
      toolCalls: [],
    });
    expect(store.listConversations(10, 0).items[0]).toMatchObject({ turnCount: 1, lastTurnStatus: "completed" });
  });

  it("fails queued and running conversation turns left behind by a Server restart", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    // 一个对话的轮次置为运行中、另一个保持排队，模拟进程退出时的残留状态。
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected the first conversation turn to be claimed");
    const queued = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Second turn",
    });

    expect(store.recoverInterruptedConversationTurns()).toBe(2);
    expect(store.getConversationTurn(created.conversationId, created.turnId)).toMatchObject({
      status: "failed",
      lastError: expect.stringContaining("restarted"),
    });
    // 排队但尚未领取的轮次同样无法跨进程恢复。
    expect(store.getConversationTurn(queued.conversationId, queued.turnId)).toMatchObject({ status: "failed" });
    expect(store.getConversation(created.conversationId)?.messages[1]).toMatchObject({ status: "failed" });
    // 再次运行没有残留可恢复，避免重复写审计。
    expect(store.recoverInterruptedConversationTurns()).toBe(0);
    // 失败的轮次不再阻塞同一对话发送新消息。
    expect(() => store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Third turn",
    })).not.toThrow();
  });

  it("surfaces each assistant turn's tool calls in the conversation listing", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Where is routing implemented?",
    });
    const claimed = store.claimConversationTurn(created.turnId);
    if (!claimed) throw new Error("expected a conversation turn to be claimed");
    const readTrace = store.startTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "tool",
      "read_file",
      "",
      null,
      { round: 1, input: JSON.stringify({ path: "src/routing.ts" }) },
    );
    store.finishTrace(readTrace, "succeeded", 42);
    const grepTrace = store.startTrace(
      { kind: "conversation", turnId: claimed.turnId },
      claimed.attempt,
      "tool",
      "git_grep",
      "",
      null,
      { round: 1, input: JSON.stringify({ query: "createHash", path: "src" }) },
    );
    store.finishTrace(grepTrace, "failed", 7, undefined, undefined, "boom");
    store.finishConversationTurn(claimed.turnId, "Routing lives in routing.ts.");

    const assistant = store.getConversation(created.conversationId)?.messages[1];
    expect(assistant).toMatchObject({
      role: "assistant",
      traceCount: 2,
      toolCalls: [
        { name: "read_file", status: "succeeded", durationMs: 42 },
        { name: "git_grep", status: "failed", durationMs: 7 },
      ],
    });
    // 用户消息不携带工具调用，避免把助手的活动挂到提问上。
    expect(store.getConversation(created.conversationId)?.messages[0]?.toolCalls).toEqual([]);
  });

  it("summarizes conversation usage and per-turn timings", async () => {
    store = await AppStore.open(":memory:");
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "First turn",
    });
    const first = store.claimConversationTurn(created.turnId);
    if (!first) throw new Error("expected the first conversation turn to be claimed");
    const llmTrace = store.startTrace(
      { kind: "conversation", turnId: first.turnId }, first.attempt, "llm", "conversation", "test/model", "{}", { round: 1 },
    );
    store.finishTrace(llmTrace, "succeeded", 120, 30, 12, undefined, undefined, 20, 60);
    const toolTrace = store.startTrace(
      { kind: "conversation", turnId: first.turnId }, first.attempt, "tool", "read_file", "test/model", "{}",
    );
    store.finishTrace(toolTrace, "succeeded", 40, 0, 0);
    store.finishConversationTurn(first.turnId, "First answer");
    const firstAssistant = store.getConversation(created.conversationId)?.messages[1];
    expect(firstAssistant?.durationMs).not.toBeNull();
    // 输出速度只统计成功模型调用，12 tokens / 60ms = 200 tokens/s。
    expect(firstAssistant?.tps).toBeCloseTo(200);

    // 未开始的轮次耗时不确定，统计里计为进行中且不计耗时。
    store.addConversationMessage(created.conversationId, {
      projectId: 7,
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
      request: "Second turn",
    });

    const stats = store.getConversationStats(created.conversationId);
    expect(stats).toMatchObject({
      conversationId: created.conversationId,
      turnCount: 2,
      completedTurns: 1,
      failedTurns: 0,
      activeTurns: 1,
      measuredTurns: 1,
      modelCalls: 1,
      toolCalls: 1,
      inputTokens: 30,
      outputTokens: 12,
    });
    expect(stats?.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats?.turns).toHaveLength(2);
    expect(stats?.turns[0]).toMatchObject({ status: "completed", modelCalls: 1, toolCalls: 1, inputTokens: 30, outputTokens: 12 });
    expect(stats?.turns[0]?.durationMs).not.toBeNull();
    expect(stats?.turns[1]).toMatchObject({ status: "queued", durationMs: null, modelCalls: 0, toolCalls: 0 });
    // 未知对话返回 undefined，由服务端转成 404。
    expect(store.getConversationStats("missing-conversation")).toBeUndefined();
  });

  it("prunes idle conversations with their messages but keeps conversations with an active reply", async () => {
    store = await AppStore.open(":memory:");
    const base = {
      projectId: 7,
      projectName: "group/project",
      targetBranch: "main",
      headSha: "a".repeat(40),
      actorId: 0,
    };
    const idle = store.createConversation({ ...base, request: "Summarize the repository layout" });
    const active = store.createConversation({ ...base, request: "Explain the event loop" });
    const activeResponseId = store.getConversation(active.conversationId)?.messages[1]?.id;
    if (!activeResponseId) throw new Error("expected a queued conversation response");
    expect(store.claimConversationTurn(idle.turnId)).toBeTruthy();
    store.finishConversationTurn(idle.turnId, "The repository has a src and test tree.");

    store.pruneHistory(new Date(Date.now() + 86_400_000), new Date(Date.now() + 86_400_000));

    expect(store.getConversation(idle.conversationId)).toBeUndefined();
    const kept = store.getConversation(active.conversationId);
    expect(kept?.messages).toHaveLength(2);
    expect(kept?.messages[1]).toMatchObject({ id: activeResponseId, status: "queued" });
  });

  it("checks token reservations and records model call metrics", async () => {
    store = await AppStore.open(":memory:");
    const day = store.reserveModelTokens(1000, 100);
    expect(() => store.reserveModelTokens(100, 1)).toThrow("budget");
    store.settleModelTokens(day, 100, 25);
    store.recordModelCall("conversation", "failure", 1250, 70, 25);
    store.recordModelCall("conversation", "success", 800, 40, 20);
    expect(store.modelCallMetrics()).toEqual([
      {
        taskType: "conversation",
        outcome: "failure",
        calls: 1,
        durationMs: 1250,
        inputTokens: 70,
        outputTokens: 25,
      },
      {
        taskType: "conversation",
        outcome: "success",
        calls: 1,
        durationMs: 800,
        inputTokens: 40,
        outputTokens: 20,
      },
    ]);
  });

  it("migrates legacy event-trace rows into the conversation trace table", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-legacy-trace-"));
    const databasePath = join(directory, "state.db");
    const initial = await AppStore.open(databasePath);
    const created = initial.createConversation({
      ownerUserId: "user-1", projectId: 7, projectName: "group/project",
      targetBranch: "main", headSha: "a".repeat(40), actorId: 11, request: "hello",
    });
    initial.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE conversation_trace RENAME TO event_trace");
    legacy.prepare(
      "INSERT INTO event_trace (turn_id,attempt,kind,name,status,started_at) VALUES (?,?,?,?,?,?)",
    ).run(created.turnId, 1, "llm", "model", "succeeded", "2025-01-01T00:00:00.000Z");
    legacy.close();

    store = await AppStore.open(databasePath);
    const inspector = new DatabaseSync(databasePath);
    const rows = inspector.prepare("SELECT turn_id,name FROM conversation_trace").all() as { turn_id: string; name: string }[];
    const legacyTables = inspector.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_trace'").all();
    inspector.close();
    expect(rows).toEqual([{ turn_id: created.turnId, name: "model" }]);
    expect(legacyTables).toEqual([]);
  });

  it("renames legacy session tables and columns while keeping conversations readable", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-legacy-session-"));
    const databasePath = join(directory, "state.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, webhook_event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL, status TEXT NOT NULL, project_id INTEGER NOT NULL, mr_iid INTEGER NOT NULL,
        head_sha TEXT NOT NULL DEFAULT '', actor_id INTEGER NOT NULL, request TEXT NOT NULL DEFAULT '',
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, project_name TEXT NOT NULL,
        target_type TEXT NOT NULL, target_iid INTEGER NOT NULL, target_branch TEXT NOT NULL,
        target_title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_session_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, event_id TEXT,
        head_sha TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO chat_sessions
        (id,project_id,project_name,target_type,target_iid,target_branch,target_title,created_at,updated_at)
      VALUES
        ('legacy-session',7,'group/project','merge_request',5,'feature/session','Old MR title','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
      INSERT INTO chat_session_messages
        (id,session_id,role,content,status,event_id,head_sha,created_at,updated_at)
      VALUES
        ('legacy-message','legacy-session','user','Hello','completed',NULL,'a','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z');
    `);
    legacy.close();

    store = await AppStore.open(databasePath);
    // 用户级会话是新模型：旧会话没有归属用户，迁移时整体丢弃。
    expect(store.listConversations(10, 0)).toEqual({ items: [], total: 0 });
    expect(store.getConversation("legacy-session")).toBeUndefined();
    const inspector = new DatabaseSync(databasePath);
    const conversationColumns = inspector.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    const messageColumns = inspector.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[];
    inspector.close();
    expect(conversationColumns.map((column) => column.name)).not.toContain("target_type");
    expect(conversationColumns.map((column) => column.name)).not.toContain("target_iid");
    expect(conversationColumns.map((column) => column.name)).not.toContain("target_title");
    expect(messageColumns.map((column) => column.name)).toContain("conversation_id");
    expect(messageColumns.map((column) => column.name)).not.toContain("session_id");
  });

  it("migrates a legacy skill table into SKILL.md documents before seeding", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-skill-migration-"));
    const databasePath = join(directory, "state.db");
    const first = await AppStore.open(databasePath);
    first.close();
    // 模拟升级前的技能表：没有 document 列，种子尚未写入。
    const raw = new DatabaseSync(databasePath);
    raw.exec("ALTER TABLE conversation_skills DROP COLUMN document");
    raw.exec("DELETE FROM conversation_skills");
    raw.close();

    const second = await AppStore.open(databasePath);
    store = second;
    const skills = second.listConversationSkills();
    expect(skills).toHaveLength(7);
    expect(skills.every((skill) => skill.document.startsWith("---"))).toBe(true);
    expect(skills[0]?.name).toBeTruthy();
  });

  it("seeds system skills and manages custom skills", async () => {
    store = await AppStore.open(":memory:");
    const seeded = store.listConversationSkills();
    expect(seeded).toHaveLength(7);
    expect(seeded.every((skill) => skill.isSystem && skill.enabled)).toBe(true);
    expect(seeded.map((skill) => skill.name)).toContain("create-mr");
    expect(store.getConversationSkill("docs")?.content).toContain("documentation");
    expect(store.listConversationSkills(true)).toHaveLength(7);

    const created = store.createConversationSkill(`---
name: custom
description: Custom skill
metadata:
  corvex-quick-action: "true"
  corvex-quick-label: "Custom"
---

Do $ARGUMENTS
`);
    expect(created.isSystem).toBe(false);
    expect(store.getConversationSkill("custom")?.quickLabel).toBe("Custom");

    const updated = store.updateConversationSkill(created.id, `---
name: custom
description: Custom skill
metadata:
  corvex-enabled: "false"
---

Do $ARGUMENTS now
`);
    expect(updated?.enabled).toBe(false);
    expect(store.listConversationSkills(true)).toHaveLength(7);

    // 系统技能受保护：只能改，不能删。
    const system = seeded.find((skill) => skill.name === "docs")!;
    expect(store.deleteConversationSkill(system.id)).toBe(false);
    expect(store.deleteConversationSkill(created.id)).toBe(true);
    expect(store.getConversationSkill("custom")).toBeUndefined();
  });

  it("stores bounded context snapshots per request", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-context-snapshots-"));
    store = await AppStore.open(join(directory, "state.db"));
    const created = store.createConversation({
      projectId: 7, projectName: "group/project", targetBranch: "main",
      headSha: "a".repeat(40), actorId: 0, request: "context test",
    });
    const snapshot = {
      conversationId: created.conversationId,
      turnId: created.turnId,
      requestSeq: 1,
      createdAt: new Date().toISOString(),
      contextWindow: 8000,
      reservedOutput: 1024,
      threshold: 85,
      estimatedTokens: 1200,
      breakdown: { system: 100, tools: 200, user: 300, inject: 0, assistant: 400, tool: 200 },
      counts: { system: 1, tools: 2, user: 1, inject: 0, assistant: 1, tool: 1 },
      items: [{ category: "user" as const, name: "token=secret", tokens: 300, preview: "token=secret" }],
      truncated: false,
    };
    store.saveContextSnapshot(snapshot);
    const listed = store.contextSnapshots(created.conversationId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.requestSeq).toBe(1);
    const detail = store.contextSnapshot(created.conversationId, 1);
    expect(detail?.items).toHaveLength(1);
    // 字段名 tokens 不能被凭证脱敏规则误伤，必须是数值。
    expect(detail?.items[0]?.tokens).toBe(300);
    expect(JSON.stringify(detail)).not.toContain("secret");
    expect(store.contextSnapshot(created.conversationId, 2)).toBeUndefined();
    store.deleteConversation(created.conversationId);
    expect(store.contextSnapshots(created.conversationId)).toEqual([]);
  });

  it("deletes leftover shared GitLab tokens from the database on open", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-token-migration-"));
    const databasePath = join(directory, "state.db");
    store = await AppStore.open(databasePath);
    store.setRuntimeSetting("gitlab_read_token", "old-read", "test");
    store.setRuntimeSetting("gitlab_token", "old-write", "test");
    // 模拟尚未执行过该迁移的旧库。
    store.setRuntimeSetting("schema:no-shared-gitlab-tokens", null);
    store.close();
    store = undefined;

    store = await AppStore.open(databasePath);
    const keys = store.listRuntimeSettings().map((row) => row.key);
    expect(keys).not.toContain("gitlab_read_token");
    expect(keys).not.toContain("gitlab_token");
    expect(keys).toContain("schema:no-shared-gitlab-tokens");
  });
});
