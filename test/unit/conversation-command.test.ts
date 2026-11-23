import { describe, expect, it } from "vitest";
import { parseConversationCommand, resolveCommandRequest, stripConversationCommand } from "../../src/app/conversation-command.ts";
import type { ConversationSkill } from "../../src/model.ts";

const skill: ConversationSkill = {
  id: "skill-1",
  name: "docs",
  description: "Improve docs",
  descriptionZh: "补充相关文档",
  content: "Focus on documentation. $ARGUMENTS",
  contentZh: "聚焦文档。$ARGUMENTS",
  argumentHint: "",
  license: "",
  compatibility: "",
  metadata: {},
  allowedTools: "",
  enabled: true,
  isSystem: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("conversation slash commands", () => {
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
    expect(resolveCommandRequest("/docs 给 auth 模块补文档", getSkill, "zh-CN")).toEqual({
      effectiveRequest: "聚焦文档。给 auth 模块补文档",
      titleRequest: "给 auth 模块补文档",
    });
    // 裸命令用技能描述作为标题，避免空标题；模板仍然提供完整任务文本。
    expect(resolveCommandRequest("/docs", getSkill, "zh-CN")).toEqual({
      effectiveRequest: "聚焦文档。",
      titleRequest: "补充相关文档",
    });
  });

  it("leaves unknown and disabled skills untouched", () => {
    const disabled = { ...skill, enabled: false };
    expect(resolveCommandRequest("/docs 内容", () => undefined, "en")).toEqual({
      effectiveRequest: "/docs 内容",
      titleRequest: "/docs 内容",
    });
    expect(resolveCommandRequest("/docs 内容", () => disabled, "en")).toEqual({
      effectiveRequest: "/docs 内容",
      titleRequest: "/docs 内容",
    });
  });
});
