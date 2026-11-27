import YAML from "yaml";
import type { SkillCommand } from "../model.js";

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
  /** metadata.corvex-commands：管理员声明的固定命令。 */
  commands: SkillCommand[];
  /** metadata.corvex-commands-enabled === "true" */
  commandsEnabled: boolean;
}

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function metadataMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  );
}

/** 从原始 metadata 里取出命令数组；metadataMap 会把数组字符串化，必须单独解析。 */
function parseSkillCommands(value: unknown): SkillCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: SkillCommand[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const command: SkillCommand = {
      name: String(record.name ?? "").trim(),
      command: String(record.command ?? "").trim(),
      description: String(record.description ?? "").trim(),
    };
    if (Number.isSafeInteger(record.timeoutMs) && (record.timeoutMs as number) > 0) {
      command.timeoutMs = record.timeoutMs as number;
    }
    if (Number.isSafeInteger(record.maxOutputBytes) && (record.maxOutputBytes as number) > 0) {
      command.maxOutputBytes = record.maxOutputBytes as number;
    }
    commands.push(command);
  }
  return commands;
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
  const rawMetadata = header.metadata && typeof header.metadata === "object" && !Array.isArray(header.metadata)
    ? header.metadata as Record<string, unknown>
    : {};
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
    commands: parseSkillCommands(rawMetadata["corvex-commands"]),
    commandsEnabled: metadata["corvex-commands-enabled"] === "true",
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
  if (skill.commandsEnabled && skill.commands.length === 0) {
    problems.push("corvex-commands-enabled requires at least one entry in corvex-commands");
  }
  const seen = new Set<string>();
  for (const command of skill.commands) {
    if (!isValidSkillName(command.name)) problems.push(`command name "${command.name}" is invalid`);
    if (seen.has(command.name)) problems.push(`command name "${command.name}" is duplicated`);
    seen.add(command.name);
    if (!command.command) problems.push(`command "${command.name}" must not be empty`);
    if (command.command.length > 4096) problems.push(`command "${command.name}" exceeds 4096 characters`);
    if (!command.description) problems.push(`command "${command.name}" needs a description`);
    if (command.command.includes("$ARGUMENTS")) {
      problems.push(`command "${command.name}" must not interpolate $ARGUMENTS (user input cannot enter a shell command)`);
    }
    if (command.timeoutMs !== undefined && command.timeoutMs > 600_000) {
      problems.push(`command "${command.name}" timeout must not exceed 600000ms`);
    }
    if (command.maxOutputBytes !== undefined && command.maxOutputBytes > (1 << 20)) {
      problems.push(`command "${command.name}" maxOutputBytes must not exceed 1048576`);
    }
  }
  return problems;
}

/** 展开技能模板：`$ARGUMENTS` 替换为参数；没有占位符时把参数附在正文之后。 */
export function expandSkillTemplate(content: string, args: string): string {
  const template = content.trim();
  const argument = args.trim();
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", argument).trim();
  return argument ? `${template}\n\n${argument}` : template;
}

/** 系统种子模板版本；升级时刷新旧文档，但保留管理员的停用选择。 */
export const SKILL_SEED_VERSION = "5";

function buildDocument(input: {
  name: string;
  description: string;
  content: string;
  quickAction?: boolean;
  quickLabel?: string;
}): string {
  const metadata = {
    "corvex-seed-version": SKILL_SEED_VERSION,
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

/**
 * 首次启动写入的系统技能。写法对齐主流 Agent 的 bundled skills：
 * description 说明「做什么 + 何时用」并带触发关键词；正文按 When / Workflow /
 * Output / Constraints 分节，给出可执行的步骤与边界，而不是一句笼统的指令。
 */
export const defaultSkillDocuments: readonly string[] = [
  buildDocument({
    name: "review",
    description: "Review code changes for bugs, regressions, security and maintainability issues, with file and line references. Use when the user asks to review, audit or check a diff, branch, merge request or specific files, or wants feedback on code quality.",
    quickLabel: "Review",
    quickAction: true,
    content: `# Code Review

## When to use this skill
- User asks to review, audit or check changes, a branch, an MR, or named files
- User wants bugs, regressions, security or quality issues found before merging

## Workflow
1. Determine the scope. Use the extra scope below when provided; otherwise inspect the current conversation's saved changes with git_status / git_diff, or get_merge_request_changes for an MR.
2. Read the affected files with read_file and surrounding context with search_text. Do not review from the diff alone when the surrounding code changes the meaning.
3. Report only concrete issues you can locate to a specific file and line. For each: severity, location, why it is wrong, and a concrete fix.
4. Order findings by severity (blocking → major → minor → nit). Separate confirmed problems from speculation.
5. If nothing is wrong, say so explicitly and list what you checked.

## Output format
\`[severity] path:line — problem — suggested fix\`

## Constraints
- Never modify files, commit, push or post comments during a review.
- Do not guess paths or line numbers; open the file first.
- Keep findings actionable; skip style preferences unless they hide a real defect.

## Extra scope (optional)
$ARGUMENTS`,
  }),
  buildDocument({
    name: "explain",
    description: "Explain how a repository or feature works: structure, call flow and key implementations, separating facts from inference. Use when the user asks what code does, how a feature works, or wants an architecture overview before changing it.",
    quickLabel: "Explain",
    quickAction: true,
    content: `# Code Explanation

## When to use this skill
- User asks how something works, what a module does, or for an architecture overview
- User is onboarding to an unfamiliar repository or preparing to change code

## Workflow
1. Identify the target. Use the extra scope below when provided; otherwise start from the repository root: read_dir / read_file on entry points and AGENTS.md.
2. Map the overall structure first: main modules, their responsibilities and how control flows between them.
3. Follow one representative path end to end with search_text / read_file. Name concrete files and symbols.
4. Explain key implementations layer by layer. State observed facts separately from inference.
5. End with the shortest path a newcomer should read to understand the feature.

## Output format
- Overview → call flow (numbered) → key files and symbols → inferred vs confirmed → suggested reading order.

## Constraints
- Quote paths and identifiers from the repository; never invent them.
- Do not execute code or tests. Do not edit files.
- If the codebase is ambiguous, say what you could not confirm.

## Extra scope (optional)
$ARGUMENTS`,
  }),
  buildDocument({
    name: "fix",
    description: "Propose a concrete fix with example code, impact analysis and verification steps, without changing files. Use when the user reports a bug, asks how to fix something, or wants a patch plan before applying it.",
    quickLabel: "Fix",
    quickAction: true,
    content: `# Fix Proposal

## When to use this skill
- User reports a bug or failing behavior and asks for a fix
- User wants to review a proposed change before it is applied

## Workflow
1. Restate the symptom and the expected behavior. The extra scope below, when provided, narrows the target.
2. Read the relevant files and trace the cause to a specific file and line. Confirm with evidence; do not guess.
3. Give the minimal patch as example code with the exact file path.
4. Explain the impact: what changes, what stays the same, and what could regress.
5. Describe how to verify the fix using repository-relative reads or a narrow check. Never run test commands.

## Output format
- Root cause → proposed patch (code block) → impact → verification steps.

## Constraints
- Do not modify files, commit or push. This turn produces a proposal only.
- If the cause cannot be confirmed, say so and list what evidence is missing.

## Extra scope (optional)
$ARGUMENTS`,
  }),
  buildDocument({
    name: "test",
    description: "Analyze test coverage gaps and propose concrete test cases and edge conditions. Use when the user asks about tests, wants to know what is untested, or needs a test plan for a change. Never runs test commands.",
    quickLabel: "Tests",
    quickAction: true,
    content: `# Test Coverage Analysis

## When to use this skill
- User asks what is untested or wants a test plan for a feature or change
- User wants concrete cases and edge conditions before writing tests

## Workflow
1. Identify the target. Use the extra scope below when provided; otherwise use the conversation's saved changes or the file the user last referenced.
2. Read the implementation and the existing tests with read_file / search_text. Map behavior branches: happy path, error paths, boundaries and state transitions.
3. List uncovered branches with file:line and explain why each matters.
4. For each gap, propose a test case: setup, input, expected result and the edge condition it covers.
5. Prioritize by risk: correctness and security first, then boundary and formatting cases.

## Output format
- Coverage gaps (file:line) → proposed cases with expected results → priority order.

## Constraints
- Do not run test commands or edit files. Suggest tests only.
- Do not claim a branch is covered without reading the test file.

## Extra scope (optional)
$ARGUMENTS`,
  }),
  buildDocument({
    name: "docs",
    description: "Add or improve documentation for code and changes, keeping terminology consistent with existing docs. Use when the user asks to write, update or fix README, API docs, comments or guides for a repository or a specific change.",
    quickLabel: "Docs",
    quickAction: true,
    content: `# Documentation

## When to use this skill
- User asks to write or update README, guides, API docs or comments
- A change introduces behavior that existing docs do not describe

## Workflow
1. Determine the target. Use the extra scope below when provided; otherwise use the conversation's saved changes as the scope.
2. Read the existing documentation first: match its structure, tone and terminology. Reuse established terms instead of inventing new ones.
3. Read the code being documented so every statement is verifiable.
4. Write the addition or revision with a concrete example where the docs currently lack one. Keep it short and task-oriented.
5. Point out any stale statements you found nearby, even if you did not change them.

## Output format
- Target file/section → proposed text → stale statements found.

## Constraints
- Do not edit files during this turn. Provide text the user can apply.
- Do not document behavior you did not verify in the code.

## Extra scope (optional)
$ARGUMENTS`,
  }),
  buildDocument({
    name: "commit",
    description: "Draft a concise commit message from the current changes: subject, body outline and scope. Use when the user asks for a commit message or wants to summarize a diff before committing. Never creates the commit.",
    quickLabel: "Commit",
    quickAction: true,
    content: `# Commit Message Draft

## When to use this skill
- User asks for a commit message or wants a diff summarized for a commit
- User wants to check whether a change is one logical commit or several

## Workflow
1. Inspect the current changes with git_status / git_diff and read the affected files. Incorporate the extra scope below when provided.
2. Identify the single logical change. If the diff mixes unrelated changes, say so and propose how to split it.
3. Write a subject line in the imperative mood, under 72 characters, naming what changed and why.
4. Add a short body: motivation, key decisions and any behavior change users should know about.
5. Verify every claim against the diff. Do not mention files or behavior you did not see.

## Output format
\`subject\`

\`body outline (2-5 bullets)\`

## Constraints
- Do not commit, stage or push. Produce text only.
- No secrets, tokens or credentials in the message.

## Extra scope (optional)
$ARGUMENTS`,
  }),
  buildDocument({
    name: "create-mr",
    description: "Draft a merge request description from the current changes: purpose, key changes, test plan and risks. Use when the user asks for an MR description, PR body or change summary. Never creates the MR.",
    quickLabel: "MR",
    quickAction: true,
    content: `# Merge Request Description

## When to use this skill
- User asks for an MR/PR description or wants to summarize a branch for review
- A change is ready for review and needs context for reviewers

## Workflow
1. Inspect the conversation's saved changes with git_diff / git_log and read the affected files. The extra scope below may name a target branch or add context.
2. Summarize the purpose in one or two sentences: what problem this solves and why.
3. List the key changes as short bullets tied to concrete files or behavior.
4. Write a test plan: what was checked and how a reviewer can verify it. Do not claim tests were run.
5. Call out risks, breaking changes, follow-ups and anything the reviewer should look at closely.

## Output format
- Purpose → key changes → test plan → risks / follow-ups.

## Constraints
- Do not create or update the MR, push branches, or post comments. Produce text only.
- Do not invent test results or reviewers.

## Extra scope (optional)
$ARGUMENTS`,
  }),
];
