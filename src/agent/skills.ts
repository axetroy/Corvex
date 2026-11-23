import YAML from "yaml";

/**
 * 技能即一份 SKILL.md：YAML frontmatter + Markdown 正文。
 * 字段遵循 agentskills.io 规范；Corvex 的管理开关放在 metadata 的 corvex-* 键里，
 * 这样整个技能仍然只有一个文档来源。
 */
export interface ParsedSkillDocument {
  name: string;
  description: string;
  content: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedTools: string;
  /** metadata.corvex-enabled !== "false" */
  enabled: boolean;
  /** metadata.corvex-quick-action === "true" */
  quickAction: boolean;
  /** metadata.corvex-quick-label */
  quickLabel: string;
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function metadataMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  );
}

/** 解析 SKILL.md；格式或必填字段不合法时抛出可直接展示给管理员的错误。 */
export function parseSkillDocument(document: string): ParsedSkillDocument {
  const match = frontmatterPattern.exec(document.trim());
  if (!match) throw new Error("SKILL.md must start with a --- delimited YAML frontmatter block");
  let front: unknown;
  try {
    front = YAML.parse(match[1]);
  } catch (error) {
    throw new Error(
      `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  const header = front as Record<string, unknown>;
  const metadata = metadataMap(header.metadata);
  return {
    name: String(header.name ?? "").trim(),
    description: String(header.description ?? "").trim(),
    content: match[2].trim(),
    license: String(header.license ?? "").trim(),
    compatibility: String(header.compatibility ?? "").trim(),
    metadata,
    allowedTools: String(header["allowed-tools"] ?? "").trim(),
    enabled: metadata["corvex-enabled"] !== "false",
    quickAction: metadata["corvex-quick-action"] === "true",
    quickLabel: String(metadata["corvex-quick-label"] ?? "").trim(),
  };
}

/**
 * Agent Skills 规范：1-64 字符、小写字母/数字/连字符，且不能以连字符开头或结尾、不能连续连字符。
 */
export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

/** 校验解析后的 SKILL.md；返回错误信息数组，空数组表示合法。 */
export function validateSkillDocument(skill: ParsedSkillDocument): string[] {
  const problems: string[] = [];
  if (!isValidSkillName(skill.name)) {
    problems.push("name must be 1-64 chars: lowercase letters, digits and hyphens, no leading/trailing or consecutive hyphens");
  }
  if (!skill.content) problems.push("SKILL.md body must not be empty");
  if (!skill.description) problems.push("description must not be empty");
  if (skill.content.length > 8_000) problems.push("body must be at most 8000 characters");
  if (skill.description.length > 1_024) problems.push("description must be at most 1024 characters");
  if (skill.compatibility.length > 500) problems.push("compatibility must be at most 500 characters");
  return problems;
}

/** 展开技能模板：`$ARGUMENTS` 替换为参数；没有占位符时把参数附在正文之后。 */
export function expandSkillTemplate(content: string, args: string): string {
  const template = content.trim();
  const argument = args.trim();
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", argument).trim();
  return argument ? `${template}\n\n${argument}` : template;
}

function buildDocument(input: {
  name: string;
  description: string;
  content: string;
  quickAction?: boolean;
  quickLabel?: string;
}): string {
  const metadata = {
    ...(input.quickAction ? { "corvex-quick-action": "true" } : {}),
    ...(input.quickLabel ? { "corvex-quick-label": input.quickLabel } : {}),
  };
  const frontmatter = [
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    ...(Object.keys(metadata).length > 0
      ? ["metadata:", ...Object.entries(metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`)]
      : []),
  ].join("\n");
  return `---\n${frontmatter}\n---\n\n${input.content.trim()}\n`;
}

/** 给升级前写入的种子文档补上快捷操作标记；保留正文与其它 frontmatter 字段。 */
export function ensureQuickActionMetadata(document: string): string {
  if (document.includes("corvex-quick-action")) return document;
  if (document.includes("metadata:")) {
    return document.replace("metadata:\n", 'metadata:\n  corvex-quick-action: "true"\n');
  }
  const end = document.indexOf("\n---", 4);
  if (end < 0) return document;
  return `${document.slice(0, end)}\nmetadata:\n  corvex-quick-action: "true"${document.slice(end)}`;
}

/** 首次启动写入的系统技能：旧的七个斜杠命令，全部作为可编辑的 SKILL.md。 */
export const defaultSkillDocuments: readonly string[] = [
  buildDocument({
    name: "review",
    description: "Review the current changes and report concrete issues",
    content: "Answer as a code review this turn: read the relevant changes first, report only issues you can locate to a specific file or line, order them by severity, and give concrete suggestions. Say so explicitly when nothing is wrong.",
    quickAction: true,
  }),
  buildDocument({
    name: "explain",
    description: "Explain the repository structure and call flow",
    content: "Answer as a code explanation this turn: describe the overall structure and call flow first, then explain key implementations layer by layer, separating facts from inference.",
    quickAction: true,
  }),
  buildDocument({
    name: "fix",
    description: "Propose a fix with impact and verification steps",
    content: "Give a fix proposal and example code this turn only: do not modify repository files, commit or push; explain the impact and how to verify.",
    quickAction: true,
  }),
  buildDocument({
    name: "test",
    description: "Find coverage gaps and suggest test cases",
    content: "Focus on tests this turn: point out coverage gaps and suggest concrete test cases and edge conditions; do not run test commands.",
    quickAction: true,
  }),
  buildDocument({
    name: "docs",
    description: "Add or improve documentation for the relevant code",
    content: "Focus on documentation this turn: add or improve explanations for the relevant code, keeping terminology consistent with existing docs.",
    quickAction: true,
  }),
  buildDocument({
    name: "commit",
    description: "Draft a commit message from the current changes",
    content: "Help prepare a commit message this turn: generate a concise subject and body outline from the current changes; do not commit.",
    quickAction: true,
  }),
  buildDocument({
    name: "create-mr",
    description: "Draft a merge request description from the current changes",
    content: "Help prepare a merge request this turn: summarize purpose, key changes, testing and risks, and produce a ready-to-use MR description draft; do not create the MR.",
    quickAction: true,
  }),
];
