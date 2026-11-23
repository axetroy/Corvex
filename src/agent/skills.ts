import type { ResponseLanguage } from "../config/config.js";
import type { ConversationSkill, ConversationSkillInput } from "../model.js";

/** 首次启动时写入的系统技能种子；用户已经习惯这些命令，升级后不能凭空消失。 */
export const defaultSkillSeeds: readonly (Pick<ConversationSkill, "name" | "description" | "descriptionZh" | "content" | "contentZh">)[] = [
  {
    name: "review",
    description: "Review with findings",
    descriptionZh: "逐条指出问题",
    content: "Answer as a code review this turn: read the relevant changes first, report only issues you can locate to a specific file or line, order them by severity, and give concrete suggestions. Say so explicitly when nothing is wrong.",
    contentZh: "本轮按代码审查方式回答：先读取相关改动，只报告能定位到具体文件或行的问题，按严重程度排序，并给出修改建议；没有问题时明确说明。",
  },
  {
    name: "explain",
    description: "Explain structure",
    descriptionZh: "讲解结构与调用",
    content: "Answer as a code explanation this turn: describe the overall structure and call flow first, then explain key implementations layer by layer, separating facts from inference.",
    contentZh: "本轮按代码讲解方式回答：先说明整体结构与调用关系，再逐层解释关键实现，区分事实与推断。",
  },
  {
    name: "fix",
    description: "Propose a fix",
    descriptionZh: "给出修复方案",
    content: "Give a fix proposal and example code this turn only: do not modify repository files, commit or push; explain the impact and how to verify.",
    contentZh: "本轮只给出修复方案与示例代码，不修改仓库文件、不提交、不推送；说明影响范围与验证方法。",
  },
  {
    name: "test",
    description: "Coverage and tests",
    descriptionZh: "覆盖与用例建议",
    content: "Focus on tests this turn: point out coverage gaps and suggest concrete test cases and edge conditions; do not run test commands.",
    contentZh: "本轮聚焦测试：指出覆盖薄弱点，给出可落地的测试用例建议与边界条件；不执行测试命令。",
  },
  {
    name: "docs",
    description: "Improve docs",
    descriptionZh: "补充相关文档",
    content: "Focus on documentation this turn: add or improve explanations for the relevant code, keeping terminology consistent with existing docs.",
    contentZh: "本轮聚焦文档：为相关代码补充或改进说明，保持术语与现有文档一致。",
  },
  {
    name: "commit",
    description: "Draft commit message",
    descriptionZh: "起草提交信息",
    content: "Help prepare a commit message this turn: generate a concise subject and body outline from the current changes; do not commit.",
    contentZh: "本轮帮助准备提交信息：基于当前改动生成简洁的提交标题与正文要点，不执行提交。",
  },
  {
    name: "create-mr",
    description: "Draft MR description",
    descriptionZh: "起草 MR 描述",
    content: "Help prepare a merge request this turn: summarize purpose, key changes, testing and risks, and produce a ready-to-use MR description draft; do not create the MR.",
    contentZh: "本轮帮助准备合并请求：总结改动目的、主要变更、测试方式与风险，给出可直接使用的 MR 描述草稿，不创建 MR。",
  },
];

/** Agent Skills 规范：1-64 字符、小写字母/数字/连字符，且不能以连字符开头或结尾、不能连续连字符。 */
export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** 按当前响应语言取技能文案，缺失的那种语言回退到另一种。 */
export function localizeSkillText(english: string, chinese: string, language: ResponseLanguage): string {
  if (language === "zh-CN") return chinese.trim() || english.trim();
  return english.trim() || chinese.trim();
}

/**
 * 展开技能模板：支持 `$ARGUMENTS` 占位符；模板没有占位符时把参数附在正文之后。
 * 命令名本身不会进入发给模型的提示词。
 */
export function expandSkillTemplate(content: string, args: string): string {
  const template = content.trim();
  const argument = args.trim();
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", argument);
  return argument ? `${template}\n\n${argument}` : template;
}

/** 管理端输入的统一校验；返回错误信息数组，空数组表示合法。 */
export function validateSkillInput(input: ConversationSkillInput): string[] {
  const problems: string[] = [];
  if (!isValidSkillName(input.name)) {
    problems.push("name must start with a lowercase letter and contain only lowercase letters, digits or hyphens (max 40 chars)");
  }
  if (!localizeSkillText(input.content, input.contentZh, "en")) {
    problems.push("content must not be empty in at least one language");
  }
  if (!localizeSkillText(input.description, input.descriptionZh, "en")) {
    problems.push("description must not be empty in at least one language");
  }
  if (input.content.length > 8_000 || input.contentZh.length > 8_000) {
    problems.push("content must be at most 8000 characters");
  }
  if (input.description.length > 1_024 || input.descriptionZh.length > 1_024) {
    problems.push("description must be at most 1024 characters");
  }
  if (input.argumentHint.length > 200) problems.push("argumentHint must be at most 200 characters");
  if (input.license.length > 200) problems.push("license must be at most 200 characters");
  if (input.compatibility.length > 500) problems.push("compatibility must be at most 500 characters");
  if (input.allowedTools.length > 500) problems.push("allowed-tools must be at most 500 characters");
  for (const [key, value] of Object.entries(input.metadata)) {
    if (key.length > 200 || value.length > 1_000) {
      problems.push(`metadata entry "${key}" exceeds the allowed length`);
    }
  }
  return problems;
}
