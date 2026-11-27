import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConversationSkill, SkillCommand } from "../model.js";
import {
  executeBoundedCommand,
  maxCommandCharacters,
  type RunCommandToolOptions,
} from "./execution/tool.js";

/** 当前会话可见的技能命令；由 Runner 从磁盘技能的同步快照派生。 */
export interface SkillCommandCatalog {
  get(name: string): ConversationSkill | undefined;
  available(): Array<{ skill: string; command: string; description: string }>;
  /** 技能目录宿主机路径；cwd: "skill" 的命令用它作为只读工作目录。 */
  resolveSkillDir(name: string): string | undefined;
}

export interface SkillCommandToolOptions extends RunCommandToolOptions {
  catalog: SkillCommandCatalog;
}

/** 提示词里最多列多少条技能命令，避免目录本身挤占上下文。 */
const maxCatalogEntries = 40;
const maxCatalogChars = 4_000;

function catalogText(catalog: SkillCommandCatalog): string {
  const entries = catalog.available()
    .map((item) => `- ${item.skill}:${item.command} — ${item.description}`)
    .sort();
  const joined = entries.slice(0, maxCatalogEntries).join("\n");
  const body = joined.length > maxCatalogChars ? `${joined.slice(0, maxCatalogChars - 1)}…` : joined;
  return body || "(none — enable commands in a skill's SKILL.md metadata)";
}

function failure(text: string): { content: { type: "text"; text: string }[]; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}

/**
 * 注册 run_skill_command：模型只能调用技能文档里声明过的固定命令。
 * 命令字符串不来自模型，也不插值 `$ARGUMENTS`；执行仍走与 run_command 完全相同的
 * 后端、超时/输出上限、流式终端、单命令停止、审计与脱敏链路。
 */
export function createSkillCommandExtension(options: SkillCommandToolOptions): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "run_skill_command",
      label: "Run a skill command",
      executionMode: "sequential",
      description:
        `Run a predefined command declared by an enabled skill, inside this conversation's pinned worktree via the ${options.backend.kind} backend. ` +
        "You choose only the skill name and command name; the shell command itself comes from the skill document and cannot be changed or given user arguments. " +
        "Use it when a skill describes a command for validating, generating or checking work.\n" +
        `Available skill commands:\n${catalogText(options.catalog)}`,
      promptSnippet:
        `run_skill_command: Run a fixed command declared by a skill (${options.backend.kind} backend).`,
      parameters: Type.Object({
        skill: Type.String({ minLength: 1, maxLength: 64 }),
        command: Type.String({ minLength: 1, maxLength: 64 }),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      execute: async (toolCallId, params) => {
        const skill = options.catalog.get(params.skill);
        if (!skill || !skill.commandsEnabled) {
          return failure(`skill "${params.skill}" is not available or has commands disabled`);
        }
        const declared: SkillCommand | undefined = (skill.commands ?? []).find((item) => item.name === params.command);
        if (!declared) {
          const names = (skill.commands ?? []).map((item) => item.name).join(", ") || "(none)";
          return failure(`skill "${params.skill}" has no command "${params.command}"; available: ${names}`);
        }
        // 旧技能文档可能绕过校验写入了插值命令，运行时再兜一层。
        if (!declared.command || declared.command.length > maxCommandCharacters || declared.command.includes("$ARGUMENTS")) {
          return failure(`command "${params.skill}:${params.command}" is not executable`);
        }
        const skillDir = declared.cwd === "skill" ? options.catalog.resolveSkillDir(skill.name) : undefined;
        if (declared.cwd === "skill" && !skillDir) {
          return failure(`skill "${params.skill}" directory is not available`);
        }
        const body = await executeBoundedCommand(options, toolCallId, {
          command: declared.command,
          ...(skillDir ? { cwd: skillDir, readonlyCwd: true } : {}),
          ...(declared.timeoutMs !== undefined ? { timeoutMs: declared.timeoutMs } : {}),
          ...(declared.maxOutputBytes !== undefined ? { maxOutputBytes: declared.maxOutputBytes } : {}),
        });
        return { content: [{ type: "text" as const, text: body }], details: {} };
      },
    });
  };
}
