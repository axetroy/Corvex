import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ResponseLanguage } from "../model.js";

/** 单条工具描述在提示词里最多保留的字符数，避免目录本身挤占上下文。 */
const maxDescriptionChars = 140;
/** 整个工具目录的字符上限；超限时退化为只列工具名。 */
const maxCatalogChars = 8_000;

export interface ToolCatalogInput {
  /** 本轮实际下发给模型的工具名；来自 `pi.getActiveTools()`。 */
  activeNames: readonly string[];
  /** 全部工具的信息，用于取描述；来自 `pi.getAllTools()`。 */
  allTools: readonly Pick<ToolInfo, "name" | "description">[];
  language: ResponseLanguage;
}

/**
 * 构造「本轮可用工具」提示词段落。
 *
 * Pi SDK 在收到自定义 systemPrompt 时不会自动生成 tools 段（工具只剩函数 schema），
 * 模型因此无法在「你能做什么」这类反思问题上感知全部工具。这里从会话真实的活跃工具
 * 列表生成目录，保证提示词与注册结果同源、新增工具无需手工维护。
 */
export function buildToolCatalogSection({ activeNames, allTools, language }: ToolCatalogInput): string {
  const byName = new Map(allTools.map((tool) => [tool.name, tool]));
  const describe = (name: string): string => {
    const raw = byName.get(name)?.description?.trim().replace(/\s+/g, " ") ?? "";
    if (!raw) return "";
    const short = raw.length > maxDescriptionChars ? `${raw.slice(0, maxDescriptionChars - 1)}…` : raw;
    return `: ${short}`;
  };

  const withDescriptions = activeNames.map((name) => `- ${name}${describe(name)}`).join("\n");
  const lines = withDescriptions.length <= maxCatalogChars
    ? withDescriptions
    : activeNames.map((name) => `- ${name}`).join("\n");
  const heading = language === "zh-CN"
    ? "本轮实际可用的全部工具（判断自身能力时以本节为准）："
    : "Every tool actually available this turn (the authority for capability questions):";
  return `${heading}\n${lines || (language === "zh-CN" ? "（无）" : "(none)")}`;
}

/**
 * 在每个模型回合开始前，把当前活跃工具目录写入系统提示词的独立段落。
 * `before_agent_start` 只影响本回合的提示词且可被后续 handler 观察，不会污染历史。
 */
export function createToolCatalogExtension(language: ResponseLanguage): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections.available_tools = buildToolCatalogSection({
        activeNames: pi.getActiveTools(),
        allTools: pi.getAllTools(),
        language,
      });
    });
  };
}
