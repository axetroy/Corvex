import { parseTraceValue } from "./trace.js";

/** 从 record_plan 工具的输入 JSON 中取出步骤清单；输入不可信，逐项校验。 */
export function parsePlanSteps(input: string | null): string[] {
  const value = parseTraceValue(input ?? "");
  if (!value || typeof value !== "object") return [];
  const steps = (value as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => typeof step === "string" && step.trim() ? [step.trim()] : []);
}
