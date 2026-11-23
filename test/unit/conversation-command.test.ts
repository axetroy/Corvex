import { describe, expect, it } from "vitest";
import { parseConversationCommand, stripConversationCommand } from "../../src/app/conversation-command.ts";
import { getConversationCommandInstruction } from "../../src/agent/prompts.ts";

describe("conversation slash commands", () => {
  it("parses a known command with the remaining message", () => {
    expect(parseConversationCommand("/review 检查这个文件的错误处理")).toEqual({
      command: "review",
      message: "检查这个文件的错误处理",
    });
    expect(parseConversationCommand("/commit")).toEqual({ command: "commit", message: "" });
    // 含连字符的命令必须和单段命令一样可解析。
    expect(parseConversationCommand("/create-mr 准备合并请求")).toEqual({
      command: "create-mr",
      message: "准备合并请求",
    });
  });

  it("ignores unknown commands and ordinary text", () => {
    expect(parseConversationCommand("/unknown hello")).toBeUndefined();
    expect(parseConversationCommand("请解释这段代码")).toBeUndefined();
    expect(parseConversationCommand("/src/app/a.ts")).toBeUndefined();
  });

  it("strips the command prefix for titles", () => {
    expect(stripConversationCommand("/create-mr 准备合并请求")).toBe("准备合并请求");
    expect(stripConversationCommand("普通问题")).toBe("普通问题");
  });

  it("provides localized instructions for every command", () => {
    for (const command of ["review", "explain", "fix", "test", "docs", "commit", "create-mr"] as const) {
      expect(getConversationCommandInstruction(command, "en")).toBeTruthy();
      expect(getConversationCommandInstruction(command, "zh-CN")).toBeTruthy();
    }
  });
});
