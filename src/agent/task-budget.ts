/**
 * 任务级预算：单轮对话里模型请求次数 / 输出 token 达到上限时，
 * 注入一次「必须收尾汇报」提示，避免长任务无限推进。
 *
 * 这是软约束：不中止轮次，只让模型在下一轮优先给出总结。
 */

export interface TaskBudgetState {
  rounds: number;
  outputTokens: number;
  wrapUpSent: boolean;
}

export interface TaskBudgetLimits {
  maxRounds?: number;
  maxOutputTokens?: number;
}

export function createTaskBudgetState(): TaskBudgetState {
  return { rounds: 0, outputTokens: 0, wrapUpSent: false };
}

/** 记录一次已完成的模型请求，返回是否应当提示收尾（同一轮只提示一次）。 */
export function observeTaskBudget(
  state: TaskBudgetState,
  limits: TaskBudgetLimits,
  outputTokens: number,
): boolean {
  state.rounds += 1;
  state.outputTokens += Math.max(0, outputTokens);
  if (state.wrapUpSent) return false;
  const roundsHit = limits.maxRounds !== undefined && limits.maxRounds > 0 && state.rounds >= limits.maxRounds;
  const tokensHit = limits.maxOutputTokens !== undefined && limits.maxOutputTokens > 0 && state.outputTokens >= limits.maxOutputTokens;
  if (!roundsHit && !tokensHit) return false;
  state.wrapUpSent = true;
  return true;
}

export function wrapUpNotice(language: "en" | "zh-CN", reason: "rounds" | "tokens", value: number): string {
  return language === "zh-CN"
    ? `本任务已进行 ${value} ${reason === "rounds" ? "轮模型调用" : "输出 token"}，达到预算上限。请立即停止新增操作，用已确认的结果给出最终汇报；未完成的事项如实说明。`
    : `This task has reached its budget (${value} ${reason === "rounds" ? "model calls" : "output tokens"}). Stop starting new work and give a final report from what is already confirmed; state clearly what remains unfinished.`;
}
