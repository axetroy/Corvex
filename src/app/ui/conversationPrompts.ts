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

/**
 * 已发起会话的快捷操作：点击后填入输入框，再由用户确认或微调后发送。
 * 文案与 `getConversationCommandInstruction` 的语义保持一致：起草/提议类指令
 * 不会真的提交、推送或写文件，提示词里也不暗示会执行这些动作。
 * 顺序按「理解 → 检查 → 改进 → 协作」排列，覆盖全部斜杠指令。
 */
export function activeQuickPrompts(copy: Copy): WelcomePrompt[] {
  return [
    { key: "explain", label: copy.quickPromptExplain },
    { key: "review", label: copy.quickPromptReview },
    { key: "coverage", label: copy.quickPromptCoverage },
    { key: "fix", label: copy.quickPromptFix },
    { key: "docs", label: copy.quickPromptDocs },
    { key: "commit", label: copy.quickPromptCommit },
    { key: "mr", label: copy.quickPromptMr },
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
