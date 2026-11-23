import { describe, expect, it } from "vitest";
import { activeQuickPrompts, welcomePromptGroups, welcomePromptText } from "../../src/app/ui/conversationPrompts.ts";
import { en, zhCN } from "../../src/app/ui/i18n.ts";
import { conversationCommands } from "../../src/app/conversation-command.ts";

describe("operations UI welcome prompts", () => {
  it("groups prompts by intent with two questions per group", () => {
    const groups = welcomePromptGroups(en);
    expect(groups.map((group) => group.key)).toEqual(["understand", "locate", "improve", "onboard"]);
    expect(groups.map((group) => group.label)).toEqual([
      en.conversationPromptGroupUnderstand,
      en.conversationPromptGroupLocate,
      en.conversationPromptGroupImprove,
      en.conversationPromptGroupOnboard,
    ]);
    expect(groups.every((group) => group.prompts.length === 2)).toBe(true);
  });

  it("keeps the original quick prompts in their matching groups", () => {
    const groups = welcomePromptGroups(en);
    const byKey = new Map(groups.flatMap((group) => group.prompts.map((prompt) => [prompt.key, prompt.label])));
    expect(byKey.get("explain")).toBe(en.conversationPromptExplain);
    expect(byKey.get("locate")).toBe(en.conversationPromptLocate);
    expect(byKey.get("improve")).toBe(en.conversationPromptImprove);
    expect(byKey.get("onboard")).toBe(en.conversationPromptOnboard);
  });

  it("resolves a prompt by key instead of relying on its rendered label", () => {
    const groups = welcomePromptGroups(zhCN);
    expect(welcomePromptText(groups, "dataFlow")).toBe(zhCN.conversationPromptDataFlow);
    expect(welcomePromptText(groups, "missing")).toBe("");
  });
});

describe("active conversation quick prompts", () => {
  it("covers every slash command with a valid, localized instruction", () => {
    for (const copy of [en, zhCN]) {
      const prompts = activeQuickPrompts(copy);
      const commands = prompts.map((prompt) => {
        const match = /^\/([a-z]+)\s+\S/.exec(prompt.label);
        expect(match, `prompt must start with "/command " plus an instruction: ${prompt.label}`).not.toBeNull();
        const command = match![1];
        expect(conversationCommands).toContain(command);
        return command;
      });
      expect(new Set(commands)).toEqual(new Set(conversationCommands));
    }
  });

  it("keeps draft-style commands from implying a write action", () => {
    for (const copy of [en, zhCN]) {
      const byCommand = new Map(activeQuickPrompts(copy).map((prompt) => [prompt.label.split(" ")[0], prompt.label]));
      expect(byCommand.get("/commit")).toContain(copy === en ? "Draft" : "起草");
      expect(byCommand.get("/mr")).toContain(copy === en ? "Draft" : "起草");
      expect(byCommand.get("/fix")).toContain(copy === en ? "Propose" : "给出");
    }
  });
});
