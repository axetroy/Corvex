import type { ConversationSkill } from "../model.js";
import { expandSkillTemplate } from "../agent/skills.js";

/**
 * 对话斜杠指令只改变当前这一轮的模型指令：不会创建事件、不改状态机、不发布评论。
 * 具体有哪些指令由管理员在运维台的技能里配置，这里只负责解析格式。
 */
export interface ParsedConversationCommand {
  command: string;
  message: string;
}

/** 解析消息开头的 `/command`，只校验格式；指令是否存在由调用方查技能表决定。 */
export function parseConversationCommand(text: string): ParsedConversationCommand | undefined {
  // 个人技能同名时用 me: 前缀调用；裸名仍按全局优先解析。
  const match = /^\/(me:)?([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  return { command: match[1] ? `me:${match[2]}` : match[2], message: (match[3] ?? "").trim() };
}

/** 去掉指令前缀，用于标题生成等只需要原始问题的场景。 */
export function stripConversationCommand(text: string): string {
  const parsed = parseConversationCommand(text);
  return parsed ? parsed.message : text;
}

/**
 * 把用户输入的 `/command 参数` 展开成两件事：
 * `effectiveRequest` 是真正发给模型的提示词（命令名不保留），
 * `titleRequest` 是用于会话标题的简短文本（优先用户参数，否则用技能描述）。
 * 命令不存在或被停用时原样返回，不干扰普通文本。
 */
export function resolveCommandRequest(
  request: string,
  getSkill: (name: string) => ConversationSkill | undefined,
): { effectiveRequest: string; titleRequest: string } {
  const parsed = parseConversationCommand(request);
  if (!parsed) return { effectiveRequest: request, titleRequest: request };
  const skill = getSkill(parsed.command);
  if (!skill?.enabled || skill.userInvocable === false) return { effectiveRequest: request, titleRequest: request };
  const parts = parsed.message.split(/\s+/).filter(Boolean);
  const named: Record<string, string> = {};
  for (const [index, name] of (skill.arguments ?? []).entries()) {
    named[name] = parts[index] ?? "";
  }
  return {
    effectiveRequest: expandSkillTemplate(skill.content, parsed.message, named),
    titleRequest: parsed.message || [skill.description, skill.whenToUse].filter(Boolean).join(" "),
  };
}
