import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationRunner } from "../../src/app/conversation-runner.js";
import { createCorvexHooks } from "../../src/app/hooks.js";
import type { CorvexConfig } from "../../src/config/config.js";
import type { GitLabClient } from "../../src/gitlab/client.js";
import { AppStore } from "../../src/store.js";

describe("stale conversation diagnostics", () => {
  let store: AppStore | undefined;
  let directory = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    store?.close();
    store = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("records who moved the branch in the trace and the failure message", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-stale-"));
    store = await AppStore.open(":memory:");
    const expected = "a".repeat(40);
    const actual = "b".repeat(40);
    const created = store.createConversation({
      projectId: 7,
      projectName: "group/project",
      targetBranch: "master",
      headSha: expected,
      actorId: 0,
      request: "Fix the parser",
    });
    const config = {
      storage: { root: directory, database: join(directory, "state.db") },
      gitlab: { baseUrl: "https://gitlab.example.com" },
      agent: { responseLanguage: "en", model: "test-model", contextWindow: 131_072 },
    } as unknown as CorvexConfig;
    const runner = new ConversationRunner(config, store, createCorvexHooks());
    const gitlab = {
      getBranch: vi.fn().mockResolvedValue({
        name: "master",
        commit: { id: actual, title: "fix: parser", committed_date: "2026-11-24T00:00:00Z" },
      }),
      getCommit: vi.fn().mockResolvedValue({
        id: actual,
        shortId: actual.slice(0, 8),
        title: "fix: parser",
        authorName: "alice",
        committedDate: "2026-11-24T00:00:00Z",
      }),
    } as unknown as GitLabClient;

    await expect(runner.runTurn(created.turnId, new AbortController().signal, gitlab, "en", false)).resolves.toBe(true);

    const conversation = store.getConversation(created.conversationId);
    expect(conversation?.messages.at(-1)).toMatchObject({ status: "failed" });
    expect(conversation?.messages.at(-1)?.content).toContain("alice");
    expect(conversation?.messages.at(-1)?.content).toContain(actual.slice(0, 12));
    const traces = store.getConversationTurns(created.conversationId)?.trajectory ?? [];
    expect(traces.some((trace) => trace.name === "stale.branch_conflict" && trace.kind === "context")).toBe(true);
    const trace = traces.find((item) => item.name === "stale.branch_conflict");
    expect(JSON.parse(trace?.output ?? "{}")).toMatchObject({ authorName: "alice", title: "fix: parser" });
  });
});
