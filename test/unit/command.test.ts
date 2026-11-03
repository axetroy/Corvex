import { describe, expect, it } from "vitest";
import { parseCommand } from "../../src/gitlab/command.js";

describe("parseCommand", () => {
  it("normalizes whitespace and command case", () => {
    expect(parseCommand("  @Corvex   /EXPLAIN  src/main.ts ")).toEqual({
      name: "explain",
      args: ["src/main.ts"],
      rawArgs: "src/main.ts ",
    });
  });

  it("preserves multiline command text while keeping tokenized arguments", () => {
    const text = "重点检查安全\n\n示例：\n  输入：  user input\n  输出：validated value";
    expect(parseCommand(`@corvex /review\n${text}`)).toEqual({
      name: "review",
      args: ["重点检查安全", "示例：", "输入：", "user", "input", "输出：validated", "value"],
      rawArgs: text,
    });
  });

  it("uses the configured bot username and requires a slash command", () => {
    expect(parseCommand("@review-assistant /review", "review-assistant")).toEqual({
      name: "review",
      args: [],
      rawArgs: "",
    });
    expect(() => parseCommand("@review-assistant review", "review-assistant")).toThrow(
      "commands must start with /",
    );
  });

  it("rejects unrelated notes", () => {
    expect(() => parseCommand("ordinary comment")).toThrow("not a Corvex command");
  });

  it("rejects unknown commands", () => {
    expect(() => parseCommand("@corvex /deploy")).toThrow(
      'unknown command "/deploy"; supported commands are /review, /explain, /fix, /status, and /cancel',
    );
  });
});
