import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createExecutionExtension,
  type RunCommandToolOptions,
} from "../../src/agent/execution/tool.js";

type Tool = {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

function collectTool(options: RunCommandToolOptions): Tool {
  const tools = new Map<string, Tool>();
  const pi = { registerTool: (tool: Tool) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  createExecutionExtension(options)(pi);
  return tools.get("run_command")!;
}

function options(): { options: RunCommandToolOptions; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async () => ({
    command: "", backend: "local" as const, exitCode: 0, stdout: "ok", stderr: "",
    truncated: false, durationMs: 1, aborted: false,
  }));
  return {
    run,
    options: {
      backend: { kind: "local", run },
      cwd: "/workspace",
      maxTimeoutMs: 10_000,
      maxOutputBytes: 1024,
    },
  };
}

describe("run_command commit guard", () => {
  it("rejects git commits without executing them", async () => {
    const { options: opts, run } = options();
    const tool = collectTool(opts);
    const result = await tool.execute("c1", { command: "git commit -m 'do it'" });
    expect(result.content[0]!.text).toContain("command: rejected");
    expect(result.content[0]!.text).toContain("git_commit");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects author overrides and commit-tree, but allows ordinary git reads", async () => {
    const { options: opts, run } = options();
    const tool = collectTool(opts);
    await tool.execute("c2", { command: "git -c user.name=Someone commit-tree HEAD^{tree}" });
    expect(run).not.toHaveBeenCalled();
    await tool.execute("c3", { command: "git status --short" });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
