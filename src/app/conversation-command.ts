/**
 * 对话斜杠指令只改变当前这一轮的模型指令：不会创建事件、不改状态机、不发布评论。
 */
export const conversationCommands = ["review", "explain", "fix", "test", "docs", "commit", "create-mr"] as const;
export type ConversationCommand = (typeof conversationCommands)[number];

export interface ParsedConversationCommand {
  command: ConversationCommand;
  message: string;
}

/** 解析消息开头的 `/command`，只对已知指令生效。 */
export function parseConversationCommand(text: string): ParsedConversationCommand | undefined {
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const command = match[1] as ConversationCommand;
  if (!conversationCommands.includes(command)) return undefined;
  return { command, message: (match[2] ?? "").trim() };
}

/** 去掉指令前缀，用于标题生成等只需要原始问题的场景。 */
export function stripConversationCommand(text: string): string {
  const parsed = parseConversationCommand(text);
  return parsed ? parsed.message : text;
}
