import { describe, expect, it } from "vitest";
import { parseConversationCommand, resolveCommandRequest, stripConversationCommand } from "../../src/app/conversation-command.ts";
import type { ConversationSkill } from "../../src/model.ts";

const skill: ConversationSkill = {
  id: "skill-1",
  document: "---\nname: docs\ndescription: Improve docs\n---\nFocus on documentation. $ARGUMENTS",
  name: "docs",
  description: "Improve docs",
  content: "Focus on documentation. $ARGUMENTS",
  license: "",
  compatibility: "",
  metadata: {},
  allowedTools: "",
  enabled: true,
  quickAction: false,
  quickLabel: "",
  isSystem: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("conversation slash commands", () => {
  it("substitutes named arguments from the slash command text", () => {
    const named = {
      ...skill,
      arguments: ["env", "ticket"],
      content: "Deploy $env for $ticket. Raw: $ARGUMENTS",
    };
    expect(resolveCommandRequest("/deploy prod T-42", () => named).effectiveRequest)
      .toBe("Deploy prod for T-42. Raw: prod T-42");
  });

  it("parses me: namespaced personal commands and honors user-invocable", () => {
    expect(parseConversationCommand("/me:docs 补充文档")).toEqual({ command: "me:docs", message: "补充文档" });
    const personal = { ...skill, name: "docs", userInvocable: false };
    expect(resolveCommandRequest("/docs 内容", () => personal).effectiveRequest).toBe("/docs 内容");
    expect(resolveCommandRequest("/docs 内容", () => skill).effectiveRequest).toBe("Focus on documentation. 内容");
  });

  it("parses any well-formed command without a static list", () => {
    expect(parseConversationCommand("/review 检查这个文件的错误处理")).toEqual({
      command: "review",
      message: "检查这个文件的错误处理",
    });
    expect(parseConversationCommand("/commit")).toEqual({ command: "commit", message: "" });
    expect(parseConversationCommand("/create-mr 准备合并请求")).toEqual({
      command: "create-mr",
      message: "准备合并请求",
    });
  });

  it("ignores malformed commands and ordinary text", () => {
    expect(parseConversationCommand("/unknown hello")).toBeDefined();
    expect(parseConversationCommand("请解释这段代码")).toBeUndefined();
    expect(parseConversationCommand("/src/app/a.ts")).toBeUndefined();
  });

  it("strips the command prefix for titles", () => {
    expect(stripConversationCommand("/create-mr 准备合并请求")).toBe("准备合并请求");
    expect(stripConversationCommand("普通问题")).toBe("普通问题");
  });

  it("expands an enabled skill into the model request and a short title", () => {
    const getSkill = (name: string) => name === "docs" ? skill : undefined;
    expect(resolveCommandRequest("/docs add auth docs", getSkill)).toEqual({
      effectiveRequest: "Focus on documentation. add auth docs",
      titleRequest: "add auth docs",
    });
    // 裸命令用技能描述作为标题，避免空标题；模板仍然提供完整任务文本。
    expect(resolveCommandRequest("/docs", getSkill)).toEqual({
      effectiveRequest: "Focus on documentation.",
      titleRequest: "Improve docs",
    });
  });

  it("leaves unknown and disabled skills untouched", () => {
    const disabled = { ...skill, enabled: false };
    expect(resolveCommandRequest("/docs 内容", () => undefined)).toEqual({
      effectiveRequest: "/docs 内容",
      titleRequest: "/docs 内容",
    });
    expect(resolveCommandRequest("/docs 内容", () => disabled)).toEqual({
      effectiveRequest: "/docs 内容",
      titleRequest: "/docs 内容",
    });
  });
});
