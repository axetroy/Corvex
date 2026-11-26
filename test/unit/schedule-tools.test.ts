import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createScheduledTaskExtension, type ScheduledTaskStore } from "../../src/agent/schedule-tools.js";
import type { ScheduledTask } from "../../src/model.js";

/** 收集注册的工具，execute 可直接调用。 */
function collectTools(owner: string, conversationId: string, store: ScheduledTaskStore) {
  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }>();
  const pi = {
    registerTool: (tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }> }) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  // owner 从 conversationOwner 推导
  createScheduledTaskExtension({ conversationId, store })(pi);
  return tools;
}

function fakeStore(owner = "u1", conversationId = "conv-1"): ScheduledTaskStore {
  const tasks = new Map<string, ScheduledTask>();
  let counter = 0;
  return {
    create: (input) => {
      const task: ScheduledTask = {
        ...input, id: `abcd123${counter++}`, timezone: input.timezone ?? "UTC", status: "active",
        expiresAt: input.expiresAt, lastRunAt: "", lastStatus: "", lastError: "",
        createdAt: "now", updatedAt: "now",
      };
      tasks.set(task.id, task);
      return task;
    },
    list: () => [...tasks.values()],
    get: (id) => tasks.get(id),
    cancel: (id) => tasks.delete(id),
    conversationOwner: (id) => (id === conversationId ? owner : undefined),
  };
}

describe("schedule_task tool", () => {
  it("creates a recurring cron task from a parsed schedule", async () => {
    const store = fakeStore();
    const tools = collectTools("u1", "conv-1", store);
    const result = await tools.get("schedule_task")!.execute("c1", {
      prompt: "check CI", schedule: "0 9 * * 1", recurring: true,
    });
    expect(result.content[0]!.text).toContain("Scheduled cron task");
    expect(result.content[0]!.text).toContain("Next run:");
    expect(store.list("u1")).toHaveLength(1);
    expect(store.list("u1")[0]!.cron).toBe("0 9 * * 1");
  });

  it("creates a one-shot task from a relative time", async () => {
    const store = fakeStore();
    const tools = collectTools("u1", "conv-1", store);
    const result = await tools.get("schedule_task")!.execute("c1", {
      prompt: "remind me", schedule: "in 45m",
    });
    expect(result.content[0]!.text).toContain("Scheduled once task");
    expect(store.list("u1")[0]!.kind).toBe("once");
  });

  it("rejects invalid cron and foreign conversations", async () => {
    const store = fakeStore();
    const tools = collectTools("u1", "conv-1", store);
    const bad = await tools.get("schedule_task")!.execute("c1", {
      prompt: "x", schedule: "not a cron", recurring: true,
    });
    expect(bad.content[0]!.text).toContain("Invalid cron");
    const foreign = await tools.get("schedule_task")!.execute("c2", {
      prompt: "x", schedule: "in 5m", conversationId: "other-conv",
    });
    expect(foreign.content[0]!.text).toContain("does not belong");
    expect(store.list("u1")).toHaveLength(0);
  });

  it("creates a cron task in an IANA timezone", async () => {
    const store = fakeStore();
    const tools = collectTools("u1", "conv-1", store);
    const result = await tools.get("schedule_task")!.execute("c1", {
      prompt: "check CI", schedule: "0 9 * * *", recurring: true, timezone: "Asia/Shanghai",
    });
    expect(result.content[0]!.text).toContain("cron interpreted in Asia/Shanghai");
    expect(store.list("u1")[0]!.timezone).toBe("Asia/Shanghai");
    const bad = await tools.get("schedule_task")!.execute("c2", {
      prompt: "x", schedule: "0 9 * * *", recurring: true, timezone: "Not/AZone",
    });
    expect(bad.content[0]!.text).toContain("Invalid IANA timezone");
  });

  it("lists and cancels tasks", async () => {
    const store = fakeStore();
    const tools = collectTools("u1", "conv-1", store);
    await tools.get("schedule_task")!.execute("c1", { prompt: "check CI", schedule: "0 9 * * *", recurring: true });
    const listed = await tools.get("list_scheduled_tasks")!.execute("c2", {});
    expect(listed.content[0]!.text).toContain("check CI");
    const task = store.list("u1")[0]!;
    const cancelled = await tools.get("cancel_scheduled_task")!.execute("c3", { id: task.id });
    expect(cancelled.content[0]!.text).toContain("Cancelled");
    expect(store.list("u1")).toHaveLength(0);
  });
});
