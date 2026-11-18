import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createToolResultBudgetExtension,
  resolveCompactionKeepRecentTokens,
  resolveCompactionReserveTokens,
  resolveToolCallBytes,
  resolveToolRoundBytes,
  resolveTurnToolResultBytes,
  truncateUtf8,
} from "../../src/agent/tool-budget.js";

type Handler = (event: Record<string, unknown>) => unknown;

function handlersFor(contextWindow: number): { messageStart: Handler; toolResult: Handler } {
  const handlers: Record<string, Handler> = {};
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  createToolResultBudgetExtension(contextWindow)(pi);
  return { messageStart: handlers.message_start!, toolResult: handlers.tool_result! };
}

describe("resolveToolRoundBytes", () => {
  it("按窗口大小分配单轮工具输出预算", () => {
    expect(resolveToolRoundBytes(131_072)).toBe(64 << 10);
    expect(resolveToolRoundBytes(32_768)).toBe(16 << 10);
  });

  it("过大或过小的窗口都被夹在可用区间", () => {
    expect(resolveToolRoundBytes(1_000_000)).toBe(128 << 10);
    expect(resolveToolRoundBytes(1_024)).toBe(16 << 10);
    expect(resolveToolRoundBytes(0)).toBe(16 << 10);
  });
});

describe("resolveToolCallBytes", () => {
  it("单个结果最多占单轮预算的一半", () => {
    expect(resolveToolCallBytes(64 << 10)).toBe(32 << 10);
    expect(resolveToolCallBytes(8 << 10)).toBe(8 << 10);
  });
});

describe("resolveCompactionReserveTokens", () => {
  it("为单轮工具增量和输出预留足够空间", () => {
    // 64 KiB 工具输出按最坏 2 字节/token 估 32768，加 8192 输出与 4 KiB 余量。
    expect(resolveCompactionReserveTokens(131_072, 8_192, 0)).toBe(32_768 + 8_192 + 4_096);
  });

  it("用户配置更大时保留用户值", () => {
    expect(resolveCompactionReserveTokens(131_072, 8_192, 60_000)).toBe(60_000);
  });

  it("预留不会吃掉整个窗口", () => {
    const reserve = resolveCompactionReserveTokens(8_192, 8_192, 0);
    expect(reserve).toBeLessThan(8_192);
    expect(reserve).toBeGreaterThan(0);
  });
});

describe("resolveCompactionKeepRecentTokens", () => {
  it("配置值小于窗口余量时原样保留", () => {
    expect(resolveCompactionKeepRecentTokens(131_072, 20_000, 45_056)).toBe(20_000);
  });

  it("配置值超过窗口余量时被压缩，并保留 2 倍估算误差余量", () => {
    const keepRecent = resolveCompactionKeepRecentTokens(32_768, 40_000, 16_384);
    expect(keepRecent).toBe(Math.floor((32_768 - 16_384 - 4_096) / 2));
  });
});

describe("resolveTurnToolResultBytes", () => {
  it("把软提醒收敛到四个单轮预算", () => {
    expect(resolveTurnToolResultBytes(131_072, 2 << 20)).toBe(256 << 10);
  });

  it("更小的配置保持原值，0 表示关闭", () => {
    expect(resolveTurnToolResultBytes(131_072, 64 << 10)).toBe(64 << 10);
    expect(resolveTurnToolResultBytes(131_072, 0)).toBe(0);
  });
});

describe("truncateUtf8", () => {
  it("不超过上限时原样返回", () => {
    expect(truncateUtf8("hello", 10)).toBe("hello");
  });

  it("按字节截断且不切断多字节字符", () => {
    const text = "中".repeat(10);
    const truncated = truncateUtf8(text, 7);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(7);
    expect(truncated).not.toContain("�");
    expect(truncated).toBe("中中");
  });

  it("上限为 0 时返回空字符串", () => {
    expect(truncateUtf8("hello", 0)).toBe("");
  });
});

describe("createToolResultBudgetExtension", () => {
  it("单个工具结果被截断到单次上限并留下提示", () => {
    const { toolResult } = handlersFor(131_072);
    const result = toolResult({
      toolName: "git_show",
      content: [{ type: "text", text: "x".repeat(200_000) }],
    }) as { content: { text: string }[] };
    const text = result.content[0]!.text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(resolveToolCallBytes(resolveToolRoundBytes(131_072)));
    expect(text).toContain("truncated");
    expect(text).toContain("git_show");
    expect(text).toContain("narrower path or line range");
  });

  it("一轮内的累计输出受单轮上限约束", () => {
    const { toolResult } = handlersFor(131_072);
    const roundLimit = resolveToolRoundBytes(131_072);
    let total = 0;
    // 每次调用都接近单次上限，多调用几次后本轮预算耗尽。
    for (let index = 0; index < 4; index += 1) {
      const result = toolResult({
        toolName: "read_file",
        content: [{ type: "text", text: "y".repeat(200_000) }],
      }) as { content: { text: string }[] } | undefined;
      if (!result) continue;
      total += Buffer.byteLength(result.content[0]!.text, "utf8");
    }
    expect(total).toBeLessThan(roundLimit + 4_096);
  });

  it("本轮预算耗尽后只返回提示，直到下一条助手消息开启新一轮", () => {
    const { messageStart, toolResult } = handlersFor(131_072);
    for (let index = 0; index < 4; index += 1) {
      toolResult({ toolName: "read_file", content: [{ type: "text", text: "z".repeat(200_000) }] });
    }
    const blocked = toolResult({
      toolName: "read_file",
      content: [{ type: "text", text: "z".repeat(200_000) }],
    }) as { content: { text: string }[] };
    expect(blocked.content[0]!.text).toContain("budget for this round is used up");
    expect(Buffer.byteLength(blocked.content[0]!.text, "utf8")).toBeLessThan(1_024);

    messageStart({ message: { role: "assistant" } });
    const resumed = toolResult({
      toolName: "read_file",
      content: [{ type: "text", text: "z".repeat(200_000) }],
    }) as { content: { text: string }[] };
    expect(resumed.content[0]!.text).not.toContain("budget for this round is used up");
  });

  it("小结果原样保留，非文本内容不受影响", () => {
    const { toolResult } = handlersFor(131_072);
    expect(toolResult({ toolName: "read_file", content: [{ type: "text", text: "ok" }] })).toBeUndefined();
    const image = { type: "image", data: "abc", mimeType: "image/png" };
    const result = toolResult({
      toolName: "read_file",
      content: [image, { type: "text", text: "w".repeat(200_000) }],
    }) as { content: { type: string; text?: string }[] };
    expect(result.content[0]).toBe(image);
  });
});
