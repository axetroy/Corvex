import { parseTraceValue } from "./trace.js";

export interface DisplayPlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** 从 record_plan 工具的输入 JSON 中取出步骤清单；输入不可信，逐项校验。 */
export function parsePlanSteps(input: string | null): string[] {
  return parseDisplayPlanSteps(input).map((step) => step.text);
}

/**
 * 解析带状态的计划：优先读 steps[].status，兼容旧版的 steps: string[]。
 * 也兼容工具输出的 "1. [status] text" 文本行（会话恢复后只剩输出时）。
 */
export function parseDisplayPlanSteps(input: string | null): DisplayPlanStep[] {
  const value = parseTraceValue(input ?? "");
  if (value && typeof value === "object") {
    const steps = (value as Record<string, unknown>).steps;
    if (Array.isArray(steps)) {
      const result = steps.flatMap((step): DisplayPlanStep[] => {
        if (typeof step === "string" && step.trim()) return [{ text: step.trim(), status: "pending" }];
        if (!step || typeof step !== "object") return [];
        const record = step as Record<string, unknown>;
        if (typeof record.text !== "string" || !record.text.trim()) return [];
        const status = ["pending", "in_progress", "completed"].includes(String(record.status))
          ? record.status as DisplayPlanStep["status"]
          : "pending";
        return [{ text: record.text.trim(), status }];
      });
      if (result.length > 0) return result;
    }
  }
  // 回退：工具结果文本里的 "1. [status] text" 行。
  const text = typeof input === "string" ? input : "";
  return text.split("\n").flatMap((line) => {
    const match = /^\s*\d+\.\s*\[(pending|in_progress|completed)\]\s*(.+)$/.exec(line);
    return match ? [{ text: match[2]!.trim(), status: match[1]! as DisplayPlanStep["status"] }] : [];
  });
}
