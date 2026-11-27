import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResponseLanguage } from "../model.js";

/** 模型可见的技能条目；location/baseDir 只用 skill:// 虚拟 URI，绝不暴露宿主路径。 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** skill://<alias>/<name>/<skillFile> */
  location: string;
  /** skill://<alias>/<name> */
  baseDir: string;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * 对齐 Pi / Claude Code 的渐进披露目录：只放 name/description/location，
 * 正文由模型用 read_file 按 location 自行读取。与 Pi 原生实现的区别是用虚拟 URI
 * 代替宿主绝对路径，且明确写出我们自定义的工具名。
 */
export function buildSkillCatalogSection(entries: readonly SkillCatalogEntry[], language: ResponseLanguage): string {
  if (entries.length === 0) return "";
  const lines = language === "zh-CN"
    ? [
        "以下技能提供针对特定任务的指令。任务匹配描述时，用 read_file 读取下面的 skill:// 位置获取完整说明。",
        "技能正文里引用的相对路径，按该技能的 baseDir 解析后再用 worktree:// 或 skill:// URI 读取。",
        "<available_skills>",
      ]
    : [
        "The following skills provide specialized instructions for specific tasks.",
        "Use read_file with the skill:// location below to load a skill's full instructions when the task matches its description.",
        "Resolve relative paths inside a skill against its baseDir URI before reading them.",
        "<available_skills>",
      ];
  for (const entry of entries) {
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(entry.name)}</name>`,
      `    <description>${escapeXml(entry.description)}</description>`,
      `    <location>${escapeXml(entry.location)}</location>`,
      `    <baseDir>${escapeXml(entry.baseDir)}</baseDir>`,
      "  </skill>",
    );
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** 把目录段落写入系统提示词的 skills 段，避免复制 Pi 的整套资源发现。 */
export function createSkillCatalogExtension(section: string): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.skills = section;
    });
  };
}
