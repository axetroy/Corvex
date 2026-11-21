import type { Copy } from "./i18n.js";

/** 欢迎页快捷提示词，键用于在点击回调中还原完整问题文本。 */
export interface WelcomePrompt {
  key: string;
  label: string;
}

/** 一组按类型归类的快捷提示词。 */
export interface WelcomePromptGroup {
  key: "understand" | "locate" | "improve" | "onboard";
  label: string;
  prompts: WelcomePrompt[];
}

/**
 * 欢迎页的快捷提示词按提问类型分组，便于按关键词找到对应问题。
 * 只生成文案数据，图标与布局由组件决定。
 */
export function welcomePromptGroups(copy: Copy): WelcomePromptGroup[] {
  return [
    {
      key: "understand",
      label: copy.conversationPromptGroupUnderstand,
      prompts: [
        { key: "explain", label: copy.conversationPromptExplain },
        { key: "dataFlow", label: copy.conversationPromptDataFlow },
      ],
    },
    {
      key: "locate",
      label: copy.conversationPromptGroupLocate,
      prompts: [
        { key: "locate", label: copy.conversationPromptLocate },
        { key: "errors", label: copy.conversationPromptErrors },
      ],
    },
    {
      key: "improve",
      label: copy.conversationPromptGroupImprove,
      prompts: [
        { key: "improve", label: copy.conversationPromptImprove },
        { key: "coverage", label: copy.conversationPromptCoverage },
      ],
    },
    {
      key: "onboard",
      label: copy.conversationPromptGroupOnboard,
      prompts: [
        { key: "onboard", label: copy.conversationPromptOnboard },
        { key: "run", label: copy.conversationPromptRun },
      ],
    },
  ];
}

/** 已发起会话的快捷操作：点击后填入输入框，部分以斜杠指令开头。 */
export function activeQuickPrompts(copy: Copy): WelcomePrompt[] {
  return [
    { key: "review", label: copy.quickPromptReview },
    { key: "commit", label: copy.quickPromptCommit },
    { key: "mr", label: copy.quickPromptMr },
    { key: "coverage", label: copy.quickPromptCoverage },
    { key: "explain", label: copy.quickPromptExplain },
    { key: "docs", label: copy.quickPromptDocs },
  ];
}

/** 点击提示词时按 key 还原原文，避免依赖 ReactNode 类型的 label。 */
export function welcomePromptText(groups: readonly WelcomePromptGroup[], key: string): string {
  for (const group of groups) {
    const prompt = group.prompts.find((item) => item.key === key);
    if (prompt) return prompt.label;
  }
  return "";
}
