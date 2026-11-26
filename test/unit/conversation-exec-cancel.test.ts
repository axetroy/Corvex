import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CorvexConfig } from "../../src/config/config.js";
import { AppStore } from "../../src/store.js";
import { ConversationRunner } from "../../src/app/conversation-runner.js";
import { createCorvexHooks } from "../../src/app/hooks.js";
import { USER_STOPPED_REASON } from "../../src/agent/execution/types.js";

/** 只验证 cancelExecution 的隔离语义：测试里直接注入最小的内存状态，不启动真实轮次。 */
interface CancelTestView {
  execStops: Map<string, { turnId: string; stop: (reason: string) => void }>;
  running: Map<string, { controller: AbortController }>;
}

describe("ConversationRunner.cancelExecution isolation", () => {
  let directory = "";
  let store: AppStore | undefined;

  afterEach(async () => {
    store?.close();
    store = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("stops only the matching command of the matching turn with the user reason", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-exec-cancel-"));
    store = await AppStore.open(join(directory, "state.db"));
    const config = {
      storage: { root: directory },
      gitlab: { baseUrl: "https://gitlab.example.com" },
      agent: {},
    } as unknown as CorvexConfig;
    const runner = new ConversationRunner(config, store, createCorvexHooks());
    const view = runner as unknown as CancelTestView;

    const reasons: string[] = [];
    view.running.set("turn-1", { controller: new AbortController() });
    view.running.set("turn-2", { controller: new AbortController() });
    view.execStops.set("cmd-a", { turnId: "turn-1", stop: (reason) => reasons.push(`a:${reason}`) });
    view.execStops.set("cmd-b", { turnId: "turn-1", stop: (reason) => reasons.push(`b:${reason}`) });
    view.execStops.set("cmd-c", { turnId: "turn-2", stop: (reason) => reasons.push(`c:${reason}`) });

    // 停止 turn-1 的 cmd-a：只 abort 它自己，带固定用户原因。
    expect(runner.cancelExecution("turn-1", "cmd-a")).toBe(true);
    expect(reasons).toEqual([`a:${USER_STOPPED_REASON}`]);
    expect(view.running.get("turn-1")?.controller.signal.aborted).toBe(false);

    // 跨轮次停止被拒绝（cmd-a 属于 turn-1，却用 turn-2 去停）。
    expect(runner.cancelExecution("turn-2", "cmd-b")).toBe(false);
    // 已停止/不存在的命令返回 false。
    expect(runner.cancelExecution("turn-1", "missing")).toBe(false);
    expect(reasons).toEqual([`a:${USER_STOPPED_REASON}`]);

    // 轮次不在运行时，即使命令存在也不能停止。
    view.running.delete("turn-1");
    expect(runner.cancelExecution("turn-1", "cmd-b")).toBe(false);
  });
});
