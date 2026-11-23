import type { CorvexConfig } from "../config/config.js";
import type { ModelTaskType } from "../model.js";

/** 当前任务实际可用的联网工具；工具注册与系统提示词共用这一份派生结果。 */
export interface AgentToolAccess {
  webFetch: boolean;
  webSearch: boolean;
}

/** 配置里与联网工具开关相关的子集。 */
export type WebToolConfig = Pick<CorvexConfig["agent"], "webEnabled" | "webSearchEnabled">;

/**
 * 派生任务可用的联网工具。web_search 依赖 web_fetch，因此关闭总开关时两者都不可用。
 * 系统提示词必须调用同一个函数，避免提示词声称的能力与实际注册的工具不一致。
 */
export function getAgentToolAccess(taskType: ModelTaskType, config: WebToolConfig): AgentToolAccess {
  return {
    webFetch: taskType === "conversation" && config.webEnabled,
    webSearch: taskType === "conversation" && config.webEnabled && config.webSearchEnabled,
  };
}
