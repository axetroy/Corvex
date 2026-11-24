import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PlanStepStatus } from "../model.js";

/** 步骤清单最多 8 步，每步最多 160 字符，避免占用小窗口模型的上下文。 */
export const maxPlanSteps = 8;
export const maxPlanStepCharacters = 160;

const validStatuses: readonly PlanStepStatus[] = ["pending", "in_progress", "completed"];

/** 把模型提交的步骤清理成可展示的短清单。 */
export function normalizePlanSteps(steps: readonly string[]): string[] {
  return steps
    .map((step) => step.trim().slice(0, maxPlanStepCharacters))
    .filter((step) => step.length > 0)
    .slice(0, maxPlanSteps);
}

export interface PlanStore {
  get(conversationId: string): { steps: Array<{ text: string; status: PlanStepStatus }> } | undefined;
  save(conversationId: string, steps: Array<{ text: string; status: PlanStepStatus }>): void;
}

export interface PlanExtensionOptions {
  conversationId?: string;
  store?: PlanStore;
}

/**
 * 注册 record_plan 工具：模型记录 3~6 个步骤，并可用 status 只更新某几步的进度。
 *
 * 无 store / 无 conversationId 时退化为旧行为（文本结果直接进入会话，不持久化），
 * 便于标题等非对话任务复用。有 store 时清单跨轮持久化，恢复后模型能看到进度。
 */
export function createPlanExtension(options: PlanExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const { conversationId, store } = options;
  const persist = Boolean(conversationId && store);
  return (pi) => {
    pi.registerTool({
      name: "record_plan",
      label: "Record plan",
      executionMode: "parallel",
      description:
        `Record a short step plan before starting work and keep it current. Provide "steps" with ${maxPlanSteps} or fewer concrete items ` +
        "(3-6 is ideal) to (re)write the whole list; each step is at most 160 characters. " +
        `To report progress without rewriting the whole list, provide "updates" as an array of {index, status} where status is "pending", "in_progress" or "completed". ` +
        "The plan is persisted across turns; call this tool whenever a step starts or finishes so the operator sees real progress. " +
        "This tool only records the plan; it does not read or modify files.",
      promptSnippet:
        "record_plan: Keep a persisted step checklist; use steps to rewrite it or updates to mark progress.",
      parameters: Type.Object({
        steps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: maxPlanStepCharacters }), {
          minItems: 1,
          maxItems: maxPlanSteps,
        })),
        updates: Type.Optional(Type.Array(Type.Object({
          index: Type.Integer({ minimum: 0, maximum: maxPlanSteps - 1 }),
          status: Type.Union([
            Type.Literal("pending"),
            Type.Literal("in_progress"),
            Type.Literal("completed"),
          ]),
        }), { maxItems: maxPlanSteps })),
      }),
      execute: async (_toolCallId, params) => {
        const existing = persist ? store!.get(conversationId!)?.steps ?? [] : [];
        let steps = existing.map((step) => ({ text: step.text, status: step.status }));
        if (params.steps && params.steps.length > 0) {
          steps = normalizePlanSteps(params.steps).map((text) => ({ text, status: "pending" as PlanStepStatus }));
        }
        let changed = Boolean(params.steps && params.steps.length > 0);
        for (const update of params.updates ?? []) {
          const target = steps[update.index];
          if (!target || !validStatuses.includes(update.status)) continue;
          if (target.status !== update.status) {
            target.status = update.status;
            changed = true;
          }
        }
        if (persist && (changed || steps.length > 0)) store!.save(conversationId!, steps);
        const lines = steps.map((step, index) =>
          `${index + 1}. [${step.status}] ${step.text}`,
        );
        return {
          content: [{ type: "text", text: lines.length > 0 ? `Plan:\n${lines.join("\n")}` : "Plan cleared." }],
          details: {},
        };
      },
    });
  };
}
