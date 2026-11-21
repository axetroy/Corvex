import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 步骤清单最多 8 步，每步最多 160 字符，避免占用小窗口模型的上下文。 */
export const maxPlanSteps = 8;
export const maxPlanStepCharacters = 160;

/** 把模型提交的步骤清理成可展示的短清单。 */
export function normalizePlanSteps(steps: readonly string[]): string[] {
  return steps
    .map((step) => step.trim().slice(0, maxPlanStepCharacters))
    .filter((step) => step.length > 0)
    .slice(0, maxPlanSteps);
}

/**
 * 注册 record_plan 工具：模型在开始工作前记录 3～6 个简短步骤，计划变化时再次调用。
 * 工具结果直接进入会话历史与过程快照，不需要额外的模型请求。
 */
export function createPlanExtension(): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.registerTool({
      name: "record_plan",
      label: "Record plan",
      executionMode: "parallel",
      description:
        `Record a short step plan before starting work. Call once with ${maxPlanSteps} or fewer concrete steps ` +
        "(3-6 is ideal), and call again with the full updated list when the plan changes. " +
        "Each step is limited to 160 characters. This tool only records the plan; it does not read or modify files.",
      promptSnippet:
        "record_plan: Record a concise numbered step plan before working and update it when the plan changes.",
      parameters: Type.Object({
        steps: Type.Array(Type.String({ minLength: 1, maxLength: maxPlanStepCharacters }), {
          minItems: 1,
          maxItems: maxPlanSteps,
        }),
      }),
      execute: async (_toolCallId, params) => {
        const steps = normalizePlanSteps(params.steps);
        return {
          content: [{ type: "text", text: `Plan recorded (${steps.length} steps).` }],
          details: {},
        };
      },
    });
  };
}
