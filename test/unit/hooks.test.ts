import { describe, expect, it } from "vitest";
import { callAsyncHook, createCorvexHooks } from "../../src/app/hooks.js";

describe("application hooks", () => {
  it("derives a conversation title from the user's first message", async () => {
    const hooks = createCorvexHooks();
    const title = await callAsyncHook(hooks.conversationStart, {
      conversationId: "conversation-1",
      turnId: "turn-1",
      request: "说明仓库结构和主要模块\n第二行",
      language: "zh-CN",
    });
    expect(title).toBe("说明仓库结构和主要模块");
  });

  it("lets plugins override the default title", async () => {
    const hooks = createCorvexHooks();
    hooks.conversationStart.tap("plugin", () => "插件生成的标题");
    const title = await callAsyncHook(hooks.conversationStart, {
      conversationId: "conversation-1",
      turnId: "turn-1",
      request: "说明仓库结构和主要模块",
      language: "zh-CN",
    });
    expect(title).toBe("插件生成的标题");
  });
});
