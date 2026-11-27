import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSkillCommandExtension, type SkillCommandToolOptions } from "../../src/agent/skill-command-tools.ts";
import type { ConversationSkill, SkillCommand } from "../../src/model.ts";
import type { ExecutionBackend, ExecutionRequest } from "../../src/agent/execution/types.ts";

type ToolResult = { content: { text: string }[]; details?: Record<string, unknown> };
type FakeTool = {
  name: string;
  description: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
};

function skill(commands: SkillCommand[], commandsEnabled = true): ConversationSkill {
  return {
    id: "verify", name: "verify", document: "", status: "tracked",
    description: "", content: "", license: "", compatibility: "", metadata: {}, allowedTools: "",
    enabled: true, quickAction: false, quickLabel: "", isSystem: false, packId: "",
    createdAt: "", updatedAt: "", commands, commandsEnabled,
  } as ConversationSkill;
}

function collectTool(options: SkillCommandToolOptions): FakeTool {
  const tools = new Map<string, FakeTool>();
  const pi = { registerTool: (tool: FakeTool) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  createSkillCommandExtension(options)(pi);
  return tools.get("run_skill_command")!;
}

function fakeBackend(): { backend: ExecutionBackend; requests: ExecutionRequest[] } {
  const requests: ExecutionRequest[] = [];
  return {
    requests,
    backend: {
      kind: "sandbox",
      run: async (request) => {
        requests.push(request);
        return {
          command: request.command, backend: "sandbox", exitCode: 0,
          stdout: "ok\n", stderr: "", truncated: false, durationMs: 1, aborted: false,
        };
      },
    },
  };
}

function baseOptions(overrides: Partial<SkillCommandToolOptions> = {}): SkillCommandToolOptions {
  const { backend } = fakeBackend();
  return {
    backend,
    cwd: "/worktree",
    maxTimeoutMs: 600_000,
    maxOutputBytes: 262_144,
    catalog: { get: () => undefined, available: () => [], resolveSkillDir: () => undefined },
    ...overrides,
  };
}

describe("run_skill_command tool", () => {
  it("advertises only enabled skill commands", () => {
    const options = baseOptions({
      catalog: {
        get: () => skill([{ name: "test", command: "pnpm test", description: "Run tests" }]),
        available: () => [{ skill: "verify", command: "test", description: "Run tests" }],
        resolveSkillDir: () => undefined,
      },
    });
    const tool = collectTool(options);
    expect(tool.description).toContain("- verify:test — Run tests");
  });

  it("rejects unknown or disabled skills and unknown commands", async () => {
    const tool = collectTool(baseOptions({
      catalog: {
        get: (name) => name === "verify"
          ? skill([{ name: "test", command: "pnpm test", description: "Run tests" }], false)
          : undefined,
        available: () => [],
        resolveSkillDir: () => undefined,
      },
    }));
    expect((await tool.execute("c1", { skill: "missing", command: "test" })).content[0]!.text).toContain("not available");
    expect((await tool.execute("c2", { skill: "verify", command: "test" })).content[0]!.text).toContain("commands disabled");

    const enabled = collectTool(baseOptions({
      catalog: {
        get: () => skill([{ name: "test", command: "pnpm test", description: "Run tests" }]),
        available: () => [],
        resolveSkillDir: () => undefined,
      },
    }));
    expect((await enabled.execute("c3", { skill: "verify", command: "other" })).content[0]!.text)
      .toContain('no command "other"');
  });

  it("runs the command declared by the skill, never one supplied by the model", async () => {
    const { backend, requests } = fakeBackend();
    const onExecuted = vi.fn();
    const tool = collectTool(baseOptions({
      backend,
      onExecuted,
      catalog: {
        get: () => skill([{
          name: "test", command: "pnpm test", description: "Run tests", timeoutMs: 900_000, maxOutputBytes: 9_999_999,
        }]),
        available: () => [],
        resolveSkillDir: () => undefined,
      },
    }));
    const result = await tool.execute("c1", {
      skill: "verify", command: "test", reason: "validate", commandOverride: "rm -rf /",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.command).toBe("pnpm test");
    // 技能声明的上限仍受配置裁剪，模型参数无法放宽。
    expect(requests[0]!.timeoutMs).toBe(600_000);
    expect(requests[0]!.maxOutputBytes).toBe(262_144);
    expect(result.content[0]!.text).toContain("exitCode: 0");
    expect(onExecuted).toHaveBeenCalledOnce();
  });

  it("runs cwd:skill commands from a read-only skill directory", async () => {
    const { backend, requests } = fakeBackend();
    const tool = collectTool(baseOptions({
      backend,
      catalog: {
        get: () => skill([{ name: "lint", command: "sh ./scripts/lint.sh", description: "Lint", cwd: "skill" }]),
        available: () => [],
        resolveSkillDir: (name) => (name === "verify" ? "/skills/verify" : undefined),
      },
    }));
    await tool.execute("c1", { skill: "verify", command: "lint" });
    expect(requests[0]).toMatchObject({ command: "sh ./scripts/lint.sh", cwd: "/skills/verify", readonlyCwd: true });
  });

  it("refuses a declared command that interpolates user arguments", async () => {
    const { backend, requests } = fakeBackend();
    const tool = collectTool(baseOptions({
      backend,
      catalog: {
        get: () => skill([{ name: "bad", command: "echo $ARGUMENTS", description: "unsafe" }]),
        available: () => [],
        resolveSkillDir: () => undefined,
      },
    }));
    const result = await tool.execute("c1", { skill: "verify", command: "bad" });
    expect(result.content[0]!.text).toContain("not executable");
    expect(requests).toHaveLength(0);
  });
});
