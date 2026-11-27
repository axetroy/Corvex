import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { join, resolve } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { AssistantMessageEvent, AssistantMessage, StreamOptions, ThinkingContent, UserMessage } from "@earendil-works/pi-ai";
import type { CorvexConfig } from "../config/config.js";
import { errorMessage } from "../errors.js";
import type { ConversationMode, ConversationStreamContext, ConversationStreamTool, ScheduledTaskCard, ScheduledTaskCardItem, TraceEntry, TraceKind, ModelTaskType, TraceScope, ThinkingLevel } from "../model.js";
import type { AppStore } from "../store.js";
import { callAsyncHook, type CorvexHooks } from "../app/hooks.js";

import type { Workspace } from "../git/types.js";
import type { GitManager } from "../git/manager.js";
import { estimateTokens, isContextOverflowError, nextOverflowRetryContextWindow } from "./budget.js";
import { resolveAdaptiveCompactionThreshold } from "./adaptive-compaction.js";
import { getAgentToolAccess } from "./tool-access.js";
import { createToolCatalogExtension } from "./tool-catalog.js";
import { redactModelFacingText, redactSensitiveText } from "../redact.js";
import { readProjectGuidance } from "./project-guidance.js";
import { contextNoticeText, microcompactNoticeText, projectGuidanceNoticeText, responseWaitNoticeText } from "./context-notice.js";
import { createPlanExtension } from "./plan.js";
import { createScheduledTaskExtension } from "./schedule-tools.js";
import { createTurnToolsExtension, type TurnToolAdapter } from "./turn-tools.js";
import { createSkillCommandExtension, type SkillCommandCatalog } from "./skill-command-tools.js";
import { buildSkillCatalogSection, createSkillCatalogExtension } from "./skill-catalog.js";
import { createFsWriteExtension, type WorkspaceFs } from "./fs/index.js";
import { createGitLabExtension } from "./gitlab/index.js";
import { createGitExtension, type GitToolAdapter } from "./git/index.js";
import type { GitLabClient } from "../gitlab/client.js";
import { buildContextSnapshot, createContextObserveExtension, messagesToText } from "./context-snapshot.js";
import { createProviderTokenCounter } from "./token-counter.js";
import { domainSummaryInstructions } from "./domain-summary.js";
import { createMicrocompactExtension, resolveMicrocompactPolicy } from "./microcompact.js";
import { estimateConservativeTokens } from "./budget.js";
import { boundSessionEntries, stripImageContent, type SessionEntryLike } from "./session-persistence.js";
import { createToolLoopState, recordToolCall, type ToolLoopNotice } from "./tool-loop.js";
import { createTaskBudgetState, observeTaskBudget, wrapUpNotice } from "./task-budget.js";
import { LocalExecutionBackend, SandboxExecutionBackend, createExecutionExtension, previewCommand, type ExecDelta, type ExecutionBackend, type ExecutionResult } from "./execution/index.js";
import { createContextInspectExtension } from "./context-inspect.js";
import type { ContextSnapshot } from "./context-snapshot.js";
import { createFsReadExtension } from "./fs/index.js";
import { assignSkillLabels, type ReadRoot } from "./fs/virtual-path.js";
import { getToolBudgetWarningPrompt } from "./prompts.js";
import {
  createToolResultBudgetExtension,
  resolveCompactionKeepRecentTokens,
  resolveCompactionReserveTokens,
  resolveTurnToolResultBytes,
} from "./tool-budget.js";
import { createWebReadExtension } from "./web-read.js";
import { createWebDownloadExtension } from "./web-download.js";
import { createWebSearchExtension } from "./web-search.js";

export { getAgentToolAccess } from "./tool-access.js";

/** 128K-token 窗口下的保守请求字节下限；窗口更大时由 `resolveMaxPromptBytes` 放大。 */
export const maxAgentPromptBytes = 96 << 10;
/** 工具输出预算软阈值：达到后先让模型记录进展再继续，把整轮留在一个会话内完成。 */
const toolBudgetWarningRatio = 0.75;
/** Keep initial workflow payload below the total prompt cap to reserve system prompt space. */
export const maxAgentUserPromptBytes = 80 << 10;
/** 估算用的固定开销：system 提示、工具定义与消息框架。 */
const framingOverheadTokens = 2_000;
/** 持久化会话条目的字节上限；超过后跳过写入，避免把 SQLite 撑爆。 */
const maxPersistedSessionBytes = 4 << 20;

/** 空正文重试时逐级降低思考等级，直到 off（返回 undefined 表示无法再降）。 */
export function lowerThinkingLevel(level: string): ThinkingLevel | undefined {
  const order: readonly ThinkingLevel[] = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];
  const index = order.indexOf(level as ThinkingLevel);
  if (index < 0 || index >= order.length - 1) return undefined;
  return order[index + 1];
}

/**
 * 思考预算：给每级思考设一个上界，且不超过输出预算减去答案保留空间。
 * 自部署 OpenAI 兼容端点未必支持预算字段，但 SDK 会用它在本地约束可选字段；
 * 真正的兜底仍是空正文降级重试。
 */
export function resolveThinkingBudgets(maxOutputTokens: number): Record<string, number> {
  const ceiling = Math.max(0, maxOutputTokens - 1_024);
  const budgets: Record<string, number> = {
    minimal: Math.min(1_024, ceiling),
    low: Math.min(2_048, ceiling),
    medium: Math.min(4_096, ceiling),
    high: Math.min(8_192, ceiling),
  };
  return Object.fromEntries(Object.entries(budgets).filter(([, value]) => value > 0));
}

/**
 * 模型思考把输出预算吃光、没有产出任何正文时的专用错误。
 * 上层据此降级思考等级重试，而不是直接把整轮判失败。
 */
export class EmptyCompletionError extends Error {
  constructor() {
    super("Pi returned an empty completion");
    this.name = "EmptyCompletionError";
  }
}

/** 解析持久化的 Pi 会话条目；格式异常或超限时按「无会话」处理，不阻断新一轮。 */
function restoreSessionEntries(raw: string | undefined): FileEntry[] | undefined {
  if (!raw || Buffer.byteLength(raw) > maxPersistedSessionBytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    if (!parsed.every((entry) => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).type === "string")) {
      return undefined;
    }
    if (parsed[0]?.type !== "session") return undefined;
    return parsed as FileEntry[];
  } catch {
    return undefined;
  }
}

/**
 * 单次请求的输入字节上限：由上下文窗口推导，而不是固定 96 KiB。
 *
 * 长任务的历史与工具输出会持续增长；固定上限会让合法请求在出站前就被拒。这里按窗口
 * 推导字节预算（chars/4 估算），窗口越大允许的提示词越多，真正超限时仍由 SDK 压缩与
 * 服务端超限重试兜底。
 */
export function resolveMaxPromptBytes(
  config: Pick<CorvexConfig["agent"], "contextWindow" | "maxOutputTokens">,
): number {
  const inputTokens = config.contextWindow - config.maxOutputTokens - framingOverheadTokens;
  if (!Number.isFinite(inputTokens)) return maxAgentPromptBytes;
  return Math.max(maxAgentPromptBytes, Math.max(1_024, inputTokens) * 4);
}

/** 把配置的历史消息转换为 SDK 的会话条目，用于在 prompt 之前注入上下文。 */
function seedHistoryMessages(
  history: readonly { role: "user" | "assistant"; content: string }[],
  providerId: string,
  model: string,
): (UserMessage | AssistantMessage)[] {
  return history.map((message) => message.role === "user"
    ? {
        role: "user" as const,
        content: [{ type: "text" as const, text: message.content }],
        timestamp: Date.now(),
      }
    : {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: message.content }],
        api: "openai-completions" as const,
        provider: providerId,
        model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        stopReason: "stop" as const,
        timestamp: Date.now(),
      });
}

export type SteerDisposition = "handled" | "queued" | "buffered" | "unavailable";

/** 插话状态：等待当前工具轮结束 / 已进入模型上下文。 */
export type SteerStatus = "queued" | "delivered";

/**
 * 轮次内插话通道：会话句柄只在 runSession 内部存在，Runner 通过它把用户的补充
 * 消息送进当前会话，而不必直接接触 Pi SDK 的 session。
 */
export interface SteerChannel {
  /** 会话就绪后绑定投递函数；可重复绑定（上下文超限会在新会话里重试）。 */
  bind(steer: (text: string) => Promise<"handled" | "queued">): void;
  /** 投递一条插话；会话未就绪时缓冲，轮次已结束时返回 unavailable。 */
  send(text: string): Promise<SteerDisposition>;
  /** 轮次终结时关闭并返回尚未投递的缓冲，交给上层降级为排队消息，避免丢失。 */
  close(): readonly string[];
  /** 已投递的文本；上下文超限重试时重新注入新会话，避免补充丢失。 */
  delivered(): readonly string[];
  /** 注册状态回调：排队（等当前工具轮结束）与送达（已进入模型上下文）。 */
  onStatus(listener: (status: SteerStatus) => void): void;
  /** 由 SDK 的 queue_update 事件驱动：pending 文本减少即视为已送达。 */
  markDelivered(pendingSteering: readonly string[]): void;
}

/** 创建一个与模型会话生命周期解耦的插话通道。 */
export function createSteerChannel(): SteerChannel {
  let deliver: ((text: string) => Promise<"handled" | "queued">) | undefined;
  let closed = false;
  const buffered: string[] = [];
  const sent: string[] = [];
  /** 已经通知过 delivered 的条数，避免 SDK 重复 queue_update 时反复提示。 */
  let deliveredNotified = 0;
  const statusListeners: Array<(status: SteerStatus) => void> = [];
  const notify = (status: SteerStatus) => {
    if (closed) return;
    for (const listener of statusListeners) {
      try { listener(status); } catch { /* 通知失败不影响投递 */ }
    }
  };
  const deliverText = (steer: (text: string) => Promise<"handled" | "queued">, text: string) => {
    sent.push(text);
    notify("queued");
    return steer(text);
  };
  return {
    bind(steer) {
      if (closed) return;
      deliver = steer;
      const pending = buffered.splice(0);
      for (const text of pending) {
        void deliverText(steer, text).catch((error: unknown) => {
          console.warn("buffered steer could not be delivered", { error: errorMessage(error) });
        });
      }
    },
    async send(text) {
      if (closed) return "unavailable";
      if (!deliver) {
        buffered.push(text);
        notify("queued");
        return "buffered";
      }
      try {
        const result = await deliver(text);
        sent.push(text);
        notify("queued");
        return result;
      } catch {
        return "unavailable";
      }
    },
    close() {
      closed = true;
      deliver = undefined;
      const undelivered = [...buffered];
      buffered.length = 0;
      statusListeners.length = 0;
      return undelivered;
    },
    delivered() {
      return sent;
    },
    onStatus(listener) {
      statusListeners.push(listener);
    },
    markDelivered(pendingSteering) {
      // SDK 从 steering 队列移除的文本 = 已被模型消费；按新增条数通知，避免重复提示。
      const remaining = sent.filter((text) => pendingSteering.includes(text));
      const newlyDelivered = sent.length - remaining.length - deliveredNotified;
      if (newlyDelivered > 0) {
        deliveredNotified += newlyDelivered;
        notify("delivered");
      }
    },
  };
}

/** 工具结果只取 text 片段，避免图片 Base64 之类的大负载进入过程/界面。 */
function readToolResultText(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  let text = "";
  if (result && typeof result === "object") {
    const content = (result as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      text = content.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
      }).join("\n");
    }
  }
  if (!text) {
    try {
      text = JSON.stringify(result) ?? "";
    } catch {
      text = String(result);
    }
  }
  const safe = redactModelFacingText(text);
  return safe.length > 4_096 ? `${safe.slice(0, 4_096)}…` : safe;
}

/** 工具结果里的 details 是不可信边界数据，逐字段校验后才交给前端渲染。 */
function parseScheduleCard(value: unknown): ScheduledTaskCard | undefined {
  if (!value || typeof value !== "object") return undefined;
  const envelope = value as Record<string, unknown>;
  if (envelope.type !== "scheduled_task_card") return undefined;
  const card = envelope.card;
  if (!card || typeof card !== "object") return undefined;
  const raw = card as Record<string, unknown>;
  const isItem = (item: unknown): item is ScheduledTaskCardItem => {
    if (!item || typeof item !== "object") return false;
    const value = item as Record<string, unknown>;
    return typeof value.id === "string" && typeof value.prompt === "string" &&
      (value.kind === "once" || value.kind === "cron") && typeof value.cron === "string" &&
      typeof value.runAt === "string" && typeof value.timezone === "string" &&
      typeof value.nextRunAt === "string" && typeof value.status === "string";
  };
  if (raw.type === "created" && isItem(raw.task)) return { type: "created", task: raw.task };
  if (raw.type === "list" && Array.isArray(raw.tasks) && raw.tasks.every(isItem)) {
    return { type: "list", tasks: raw.tasks };
  }
  if (raw.type === "cancelled" && typeof raw.taskId === "string" && typeof raw.found === "boolean") {
    return { type: "cancelled", taskId: raw.taskId, found: raw.found };
  }
  return undefined;
}

export interface ModelRequest {
  taskType: ModelTaskType;
  systemPrompt: string;
  userPrompt: string;
  /**
   * 对话历史，按时间升序。提供时按独立消息注入会话，让模型与 SDK 的压缩逻辑
   * 都能识别轮次边界；不提供时只发送 `userPrompt`。
   */
  history?: { role: "user" | "assistant"; content: string }[];
  /**
   * 对话轮次的模式；仅 `taskType === "conversation"` 时使用，用于派生工具能力。
   * 省略时按 `defaultConversationMode`（可读可写）处理。
   */
  conversationMode?: ConversationMode;
  /** 只发文本、不注册任何工具；用于标题等不应读取仓库的模型调用。 */
  noTools?: boolean;
  /** 对话的本地文件写入能力；由 Runner 限定到当前 worktree 后传入。 */
  fs?: WorkspaceFs;
  /** 当前登录用户的 GitLab 客户端；仅对话轮次提供，用于以该用户令牌访问 GitLab。 */
  gitlab?: GitLabClient;
  /**
   * 本轮上传附件（ID + 内部物理目录）；仅对话轮次提供。物理路径只用于构造只读根，
   * 模型侧只看到 upload://<id>/<filename>，不接触宿主机路径。
   */
  uploads?: { id: string; rootPath: string }[];
  /**
   * 本轮图片附件：data 必须是裸 Base64（SDK 自己拼 data URL），仅视觉模型提供。
   */
  images?: { data: string; mimeType: string; filename: string }[];
  /**
   * 助手正文的流式回调。模型每开始一轮输出回调一次 `reset: true`，随后携带该轮
   * 已累计的正文；用累计值而不是增量，客户端漏事件后仍能自愈。仅对话轮次使用，
   * 其余任务省略即可。
   */
  onTextDelta?: (update: { reset: boolean; text: string }) => void;
  /**
   * 助手思考过程的流式回调，语义与 `onTextDelta` 相同：每轮开始先 `reset: true`，
   * 之后是该轮累计的思考文本。思考内容只用于展示，不落库、不参与输出校验；
   * 被服务端安全策略遮蔽的思考块不会推送。
   */
  onThinkingDelta?: (update: { reset: boolean; text: string }) => void;
  /**
   * 工具开始/结束的流式回调，用于把每次工具调用按发生顺序穿插在思考过程之间。
   * 参数沿用轨迹的脱敏与限长结果；与正文、思考一样只用于展示，不影响执行。
   */
  onToolDelta?: (tool: ConversationStreamTool) => void;
  /** 插话状态变化（排队 / 已进入模型上下文），供控制台提示用户。 */
  onSteerStatus?: (status: SteerStatus) => void;
  /** 计划任务工具的结构化结果，供对话里渲染可跳转卡片。 */
  onScheduleCard?: (card: ScheduledTaskCard) => void;
  /** 命令开始：登记独立停止回调（只停该命令，不取消整轮）。 */
  onExecStart?: (execId: string, stop: (reason: string) => void) => void;
  /** 命令结束：注销停止回调。 */
  onExecEnd?: (execId: string) => void;
  /** 命令输出增量与终态，供 SSE 终端展示。 */
  onExecDelta?: (delta: ExecDelta) => void;
  /**
   * 上下文压缩/裁剪通知，用于对话控制台把变化以消息形式展示。
   * 同一 id 的后续事件替换前面的提示（例如「正在压缩」→「已压缩」）。
   */
  onContextDelta?: (context: ConversationStreamContext) => void;
  /** GitLab 协作模式下当前对话绑定的项目 ID；所有 GitLab 工具都固定到该项目。 */
  conversationProjectId?: number;
  /** 当前对话 ID；用于按对话平滑每轮 token 增长，动态调整压缩阈值。 */
  conversationId?: string;
  /** 当前对话轮次 ID；上下文快照按轮次归属。 */
  turnId?: string;
  /** 操作者 ID（审计用）；仅对话轮次提供。 */
  actorId?: number;
  /** 绑定当前会话 worktree 的 Git 工具集；只在对话轮次中提供。 */
  gitTools?: GitToolAdapter;
  /** 当前会话历史的只读查询能力；只在对话轮次中提供。 */
  turnTools?: TurnToolAdapter;
  /** 当前会话可见的技能命令目录；只在启用执行环境的对话轮次中提供。 */
  skillCommandCatalog?: SkillCommandCatalog;
  /** 托管技能根（全局与个人）：进入 Pi 发现与 skill:// 只读根；只由 Runner 注入。 */
  managedSkillRoots?: Array<{ path: string; alias: string }>;
  /** 模型可见的技能元数据；正文按需用 skill:// 读取，不在此注入。 */
  managedSkills?: Array<{
    name: string;
    commandName: string;
    description: string;
    skillFile: string;
    alias: string;
    scope: "global" | "personal";
    disableModelInvocation: boolean;
    allowedTools?: string;
  }>;
  /**
   * 轮次内插话通道；由 Runner 创建，PiAgent 在会话就绪后绑定。仅对话轮次提供，
   * 其余任务省略即可。
   */
  steer?: SteerChannel;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 本轮命中缓存的输入 token；缓存 token 不计入 inputTokens。 */
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  content: string;
  model: string;
  usage: ModelUsage;
  /** 本轮若发生压缩，SDK 生成的摘要可直接作为下一轮的滚动摘要，避免重复摘要。 */
  compactionSummary?: string;
}

export interface TraceContext {
  scope: TraceScope;
  attempt: number;
  taskType: ModelTaskType;
  workspace?: Workspace;
}

/**
 * 取助手消息中已累计的正文。思考块与工具调用参数不算正文：控制台只把用户可见的
 * 回答逐字展示，工具调用另有「调用记录」呈现。
 */
function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 取助手消息中的思考文本；被安全过滤遮蔽的内容没有可读正文，直接跳过。 */
function assistantThinking(message: AssistantMessage): string {
  return message.content
    .filter((part): part is ThinkingContent => part.type === "thinking" && !part.redacted)
    .map((part) => part.thinking)
    .join("");
}

function hasGeneratedOutput(event: AssistantMessageEvent): boolean {
  if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
    return event.delta.length > 0;
  }
  if (event.type !== "text_start" && event.type !== "thinking_start" && event.type !== "toolcall_start") {
    return false;
  }
  const content = event.partial.content[event.contentIndex];
  if (content?.type === "text") return content.text.length > 0;
  if (content?.type === "thinking") return content.thinking.length > 0;
  if (content?.type === "toolCall") return content.name.length > 0 || Object.keys(content.arguments).length > 0;
  return false;
}

export class PiAgent {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store?: AppStore,
    private readonly git?: Pick<GitManager, "grep" | "getWorkspaceDiff">,
    private readonly gitlab?: GitLabClient,
    private readonly hooks?: CorvexHooks,
  ) {}

  /** 每个对话最近几轮的 token 增长样本，用于平滑自适应压缩阈值。 */
  private readonly growthByConversation = new Map<string, number[]>();

  getTraceEntries(scope: TraceScope, attempt: number): TraceEntry[] {
    return this.store?.getTraceEntries(scope, attempt) ?? [];
  }

  async generate(
    request: ModelRequest,
    workingDirectory: string,
    signal?: AbortSignal,
    trace?: TraceContext,
  ): Promise<ModelResponse> {
    if (this.hooks) await callAsyncHook(this.hooks.agentBeforeModel, request);
    if (!request.systemPrompt.trim() || !request.userPrompt.trim()) {
      throw new Error("system and user prompts are required");
    }
    const promptBytes = Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.userPrompt) +
      (request.history ?? []).reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) +
      (request.images ?? []).reduce((sum, image) => sum + image.data.length, 0);
    const promptByteLimit = resolveMaxPromptBytes(this.config.agent);
    if (promptBytes > promptByteLimit) {
      throw new Error(`agent prompt exceeds the ${promptByteLimit}-byte request budget`);
    }
    // 以提示词字节数加最大输出量预留预算，避免并发请求突破每日上限。
    const reservedTokens = promptBytes + this.config.agent.maxOutputTokens;
    const budgetDay =
      this.config.agent.dailyTokenBudget > 0
        ? this.store?.reserveModelTokens(this.config.agent.dailyTokenBudget, reservedTokens)
        : undefined;
    if (this.config.agent.dailyTokenBudget > 0 && !this.store) {
      throw new Error("daily model token budget requires a persistent task store");
    }

    let response: ModelResponse;
    let reasoningRetried = false;
    try {
      const sessionSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.config.agent.sessionTimeout)])
        : AbortSignal.timeout(this.config.agent.sessionTimeout);
      try {
        response = await this.runSession(request, workingDirectory, sessionSignal, trace);
      } catch (error) {
        // 推理把输出预算吃光时模型没有产出正文，直接判失败太粗暴。
        // 降级思考等级重试一次，确保至少能拿到正文；重试成功后跳过超限分支。
        if (!signal?.aborted && !reasoningRetried && error instanceof EmptyCompletionError) {
          const lowered = lowerThinkingLevel(this.config.agent.thinkingLevel);
          if (lowered && lowered !== this.config.agent.thinkingLevel) {
            reasoningRetried = true;
            const retryConfig = structuredClone(this.config);
            retryConfig.agent.thinkingLevel = lowered;
            try {
              request.onContextDelta?.({
                id: `context-reason-retry-${Date.now()}`,
                text: this.config.agent.responseLanguage === "zh-CN"
                  ? `模型把输出预算用于思考、没有产出正文，正在降低思考等级（${lowered}）重试。`
                  : `The model spent its output budget on reasoning without producing an answer; retrying at lower thinking level (${lowered}).`,
              });
            } catch (noticeError) {
              console.warn("reasoning retry notice failed", { error: errorMessage(noticeError) });
            }
            console.warn("empty completion after reasoning; retrying at lower thinking level", {
              taskType: request.taskType,
              from: this.config.agent.thinkingLevel,
              to: lowered,
            });
            response = await this.runSession(request, workingDirectory, sessionSignal, trace, retryConfig);
          } else {
            throw error;
          }
        } else if (!signal?.aborted && !reasoningRetried && isContextOverflowError(errorMessage(error))) {
          // 输入重试：去掉全部历史，只保留当前请求。第二轮失败即放弃并如实上报。
        // 自动调优只影响本次会话的有效窗口，不写回模型目录、不改全局配置：
        // 一次偶发的 provider 超限不应该永久缩小所有用户共享的模型设置。
        const nextWindow = nextOverflowRetryContextWindow(this.config.agent.contextWindow);
        const tuneEnabled = this.config.agent.autoContextTune !== false;
        const retryConfig = structuredClone(this.config);
        if (tuneEnabled && nextWindow < retryConfig.agent.contextWindow) {
          retryConfig.agent.contextWindow = nextWindow;
          if (retryConfig.agent.maxInputTokens >= nextWindow) retryConfig.agent.maxInputTokens = 0;
          if (retryConfig.agent.historyTokenBudget > nextWindow) retryConfig.agent.historyTokenBudget = nextWindow;
          console.warn("context window reduced for this session retry", {
            from: this.config.agent.contextWindow,
            to: nextWindow,
          });
        }
        try {
          request.onContextDelta?.({ id: `context-trim-${Date.now()}`, text: contextNoticeText(this.config.agent.responseLanguage, "trim") });
        } catch (error) {
          console.warn("context stream callback failed", { error: errorMessage(error) });
        }
        if (trace) {
          const trimBefore = buildContextSnapshot(request.history ?? [], undefined);
          const trimTrace = this.startTrace(trace, "context", "context.trim", "", null, {
            input: JSON.stringify({ reason: "overflow", nextWindow, before: trimBefore }),
          });
          if (trimTrace !== undefined) {
            this.finishTrace(trimTrace, "succeeded", 0, undefined, undefined, undefined,
              JSON.stringify({ nextWindow, after: { tokens: null, messages: [], summary: "" } }));
          }
        }
        // 重试会创建新会话；已投递的插话只存在于旧会话里，必须作为新会话的历史
        // 重新注入，否则用户的补充会在超限重试后静默丢失。
        const steered = request.steer?.delivered() ?? [];
        const retry: ModelRequest = request.history?.length || steered.length
          ? {
              ...request,
              // 原重试会丢掉全部历史；这里仍然丢掉，只保留用户在运行中的补充。
              history: steered.map((content) => ({ role: "user" as const, content })),
            }
          : request;
        console.warn("model request exceeded the context window; retrying without history", {
          taskType: request.taskType,
          historyMessages: request.history?.length ?? 0,
        });
          response = await this.runSession(retry, workingDirectory, sessionSignal, trace, retryConfig);
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (budgetDay) {
        try {
          // 请求失败时用预留量结算，避免因无法确认服务端是否已计费而释放预算。
          this.store!.settleModelTokens(budgetDay, reservedTokens, reservedTokens);
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            "Pi request failed and daily model token budget settlement also failed",
            { cause: settlementError },
          );
        }
      }
      throw new Error(`Pi agent run failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (budgetDay) {
      try {
        this.store!.settleModelTokens(
          budgetDay,
          reservedTokens,
          response.usage.totalTokens > 0 ? response.usage.totalTokens : reservedTokens,
        );
      } catch (error) {
        throw new Error(`settle daily model token budget: ${String(error)}`, { cause: error });
      }
    }
    if (this.hooks) await callAsyncHook(this.hooks.agentAfterModel, request, response);
    return response;
  }

  private async runSession(
    request: ModelRequest,
    workingDirectory: string,
    parentSignal?: AbortSignal,
    trace?: TraceContext,
    config: CorvexConfig = this.config,
  ): Promise<ModelResponse> {
    // 无响应看门狗独立于上级信号：超时后中止当前会话，让轮次尽快以明确错误收尾，
    // 而不是在「运行中」状态下空等 SDK 多次重试。
    const stallController = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, stallController.signal])
      : stallController.signal;
    const agentDir = resolve(join(config.storage.root, "pi-agent"));
    // 对话轮次恢复同一会话的完整消息（含 tool_use/tool_result），而不是每轮新会话 + 文本历史。
    const sessionKey = request.taskType === "conversation" && request.conversationId && !request.noTools
      ? request.conversationId
      : undefined;
    const restoredEntries = sessionKey
      ? restoreSessionEntries(this.store?.conversationSessionEntries(sessionKey))
      : undefined;
    const repositoryRoot = await realpath(workingDirectory);
    // linked worktree 的 `.git` 文件里写的是镜像裸库的 realpath（macOS 上 /var 会被解析到 /private/var），
    // 沙箱必须按同一 realpath 只读挂载，否则容器里的 git 解析不到 gitdir。
    const mirrorPath = request.conversationProjectId
      ? await realpath(join(resolve(config.storage.root), "mirrors", `${request.conversationProjectId}.git`)).catch(() => undefined)
      : undefined;
    // 专用的持久缓存目录：挂在容器 /corvex-cache，既不占用 tmpfs，也不污染 worktree。
    const cacheDir = request.conversationProjectId
      ? join(resolve(config.storage.root), "exec-cache", String(request.conversationProjectId))
      : undefined;
    if (cacheDir) await mkdir(cacheDir, { recursive: true, mode: 0o750 });
    const managedRoots = request.managedSkillRoots ?? [];
    const skillPathsResolved = [
      ...config.agent.skillPaths.map((path) => resolve(path)),
      // 全局与个人托管技能都进入 Pi 发现与 skill:// 根表；别名由 Runner 按同一顺序派生。
      ...managedRoots.map((root) => resolve(root.path)),
    ];
    const skillRoots = await Promise.all(skillPathsResolved.map((path) => realpath(path)));
    const skillLabels = assignSkillLabels(skillPathsResolved);
    // 模型可见的技能目录：只有 description 常驻上下文，正文用 skill:// URI 按需读取。
    const managedSkillSection = request.managedSkills?.length
      ? buildSkillCatalogSection(
          request.managedSkills
            .filter((skill) => !skill.disableModelInvocation && skill.description)
            .map((skill) => ({
              name: skill.commandName,
              description: `[${skill.scope === "global" ? "global" : "personal"}] ${skill.description}`,
              location: `skill://${skill.alias}/${skill.name}/${skill.skillFile}`,
              baseDir: `skill://${skill.alias}/${skill.name}`,
              ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
            })),
          config.agent.responseLanguage,
        )
      : "";
    // 上传附件是仅本轮有效的只读根；realpath 失败（已被用户删除）时跳过，不让整轮失败。
    const uploadEntries = (await Promise.all((request.uploads ?? []).map(async (upload) => {
      const root = await realpath(resolve(upload.rootPath)).catch(() => undefined);
      return root ? { id: upload.id, path: root } : undefined;
    }))).filter((entry): entry is { id: string; path: string } => entry !== undefined);
    // 虚拟路径协议的根表：模型只看到 worktree:// / skill://<alias> / upload://<id>。
    const readRoots: ReadRoot[] = [
      { scheme: "worktree", label: "", path: repositoryRoot },
      ...skillRoots.map((path, index) => ({ scheme: "skill" as const, label: skillLabels[index]!, path })),
      ...uploadEntries.map((upload) => ({ scheme: "upload" as const, label: upload.id, path: upload.path })),
    ];
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const providerId = "corvex-openai-compatible";
    // 内部 Provider ID 只用于注册 SDK Provider；展示给用户的名称来自控制台的供应商设置。
    const providerLabel = config.agent.providerName || providerId;
    const completionsApi = openAICompletionsApi();
    const requestTimeout = config.agent.requestTimeout;
    // Node 内置 fetch 的 headersTimeout 固定 300 秒，会让 agent_request_timeout 形同虚设。
    // 用同包 undici 的 fetch + Agent，让连接/响应头/响应体都遵循运行时配置的超时。
    const dispatcher = new UndiciAgent({
      connect: { timeout: Math.min(requestTimeout, 30_000) },
      headersTimeout: requestTimeout,
      bodyTimeout: requestTimeout,
    });
    const timedFetch: typeof globalThis.fetch = (input, init) =>
      undiciFetch(input as string | URL, { ...init, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    // 任意模型活动（响应头、正文、思考、工具调用）都会重置看门狗计时。
    let lastActivityAt = performance.now();
    const markActivity = () => { lastActivityAt = performance.now(); };
    // 工具执行期间模型本就在等待：工具自带 timeout，不能被"模型无输出"看门狗抢先中止。
    let runningToolCount = 0;
    let activeModelCall: {
      traceId: number;
      startedAt: number;
      round: number;
      requestStartedAt?: string;
      requestStartedAtMono?: number;
      responseHeadersMs?: number;
      firstTokenAt?: number;
      firstTokenMs?: number;
    } | undefined;
    let pendingRequestTiming: {
      requestStartedAt: string;
      requestStartedAtMono: number;
      responseHeadersMs?: number;
    } | undefined;
    const requestOptions = (options: StreamOptions | undefined) => {
      const timeoutSignal = AbortSignal.timeout(requestTimeout);
      const requestStartedAtMono = performance.now();
      const requestStartedAt = new Date().toISOString();
      const requestTiming: {
        requestStartedAt: string;
        requestStartedAtMono: number;
        responseHeadersMs: number | undefined;
      } = { requestStartedAt, requestStartedAtMono, responseHeadersMs: undefined };
      pendingRequestTiming = requestTiming;
      return {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal,
        timeoutMs: requestTimeout,
        fetch: timedFetch,
        onResponse: async (response: Parameters<NonNullable<StreamOptions["onResponse"]>>[0], responseModel: Parameters<NonNullable<StreamOptions["onResponse"]>>[1]) => {
          markActivity();
          const responseHeadersMs = performance.now() - requestStartedAtMono;
          requestTiming.responseHeadersMs ??= responseHeadersMs;
          if (activeModelCall?.requestStartedAtMono === requestStartedAtMono) {
            activeModelCall.responseHeadersMs ??= responseHeadersMs;
          }
          await options?.onResponse?.(response, responseModel);
        },
      };
    };
    runtime.registerNativeProvider(createProvider({
      id: providerId,
      name: "Corvex OpenAI-compatible provider",
      baseUrl: config.agent.baseUrl.replace(/\/+$/, ""),
      auth: {
        apiKey: {
          name: "Corvex OpenAI-compatible API key",
          resolve: async () => ({ auth: { apiKey: config.agent.apiKey } }),
        },
      },
      models: [
        {
          id: config.agent.model,
          name: config.agent.model,
          api: "openai-completions",
          provider: providerId,
          baseUrl: config.agent.baseUrl.replace(/\/+$/, ""),
          input: config.agent.visionEnabled ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // 推理默认开启：关闭会让模型在工具调用之间跳过思考，容易凭对话文本臆测而不是核实。
          // 不支持推理的服务商可在运维台关闭；用户可在输入框旁单独调整思考等级。
          reasoning: config.agent.reasoningEnabled && config.agent.thinkingLevel !== "off",
          contextWindow: config.agent.contextWindow,
          maxTokens: config.agent.maxOutputTokens,
        },
      ],
      api: {
        "openai-completions": {
          stream: (model, context, options) =>
            completionsApi.stream(model, context, requestOptions(options)),
          streamSimple: (model, context, options) =>
            completionsApi.streamSimple(model, context, requestOptions(options)),
        },
      },
    }));
    const model = runtime.getModel(providerId, config.agent.model);
    if (!model) throw new Error("Pi could not resolve the configured model");
    const toolAccess = getAgentToolAccess(request.taskType, config.agent);
    const gitlab = request.gitlab ?? this.gitlab;
    const workspace = trace?.workspace;
    // 执行环境：自由命令在受控后端执行；仅对话轮次且有 worktree 时注册。
    const execution = config.execution;
    const executionBackend: ExecutionBackend | undefined
      = execution?.enabled && request.taskType === "conversation" && workspace && request.conversationId && request.turnId
        ? execution.backend === "local"
          ? new LocalExecutionBackend()
          : new SandboxExecutionBackend(execution.sandbox)
        : undefined;
    const executionLimits = execution?.backend === "sandbox" ? execution.sandbox : execution?.local;
    // 压缩阈值由工具结果预算推导：SDK 只能估算「最后一条回复之后新增的」工具结果，
    // 预留必须覆盖这段最坏增量加上输出预留，否则估算偏低的请求仍会超窗。
    const compactionReserveTokens = resolveCompactionReserveTokens(
      config.agent.contextWindow,
      config.agent.maxOutputTokens,
      config.agent.compactionReserveTokens,
    );
    const compactionKeepRecentTokens = resolveCompactionKeepRecentTokens(
      config.agent.contextWindow,
      config.agent.compactionKeepRecentTokens,
      compactionReserveTokens,
    );
    // SDK 自身的阈值放到接近窗口，只保留溢出压缩；主动压缩由下面的真实 token 计数在
    // 更早、可控的点触发，避免原始会话里的工具结果把 SDK 估算顶到 62.5% 就压缩。
    const sdkReserveTokens = Math.min(compactionReserveTokens, 1_024);
    const selfCompactRatio = Math.max(0.5, Math.min(0.95, (config.agent.compactionTriggerPercent ?? 85) / 100));
    const compactionHardCap = config.agent.contextWindow - config.agent.maxOutputTokens - 1_024;
    const selfCompactThreshold = Math.max(
      1_024,
      Math.min(
        Math.floor(config.agent.contextWindow * selfCompactRatio),
        compactionHardCap,
      ),
    );

    const emitContextStream = (context: ConversationStreamContext) => {
      if (!request.onContextDelta) return;
      try {
        request.onContextDelta(context);
      } catch (error) {
        console.warn("context stream callback failed", { error: errorMessage(error) });
      }
    };
    // 每个会话一个循环检测器：同一签名重复或连续失败时提示模型换策略，避免长任务空转。
    const toolLoop = createToolLoopState();
    // 任务级软预算：达到轮次/输出上限时用 steer 要求收尾，不中止本轮。
    const taskBudget = createTaskBudgetState();
    const taskBudgetLimits = {
      maxRounds: config.agent.taskMaxRounds,
      maxOutputTokens: config.agent.taskMaxOutputTokens,
    };
    const noticeToolLoop = (notice: ToolLoopNotice) => {
      const language = config.agent.responseLanguage;
      const detail = notice.reason === "failures"
        ? language === "zh-CN"
          ? `工具 ${notice.signature.slice(7)} 已连续失败 ${notice.count} 次，请换一个方法或汇报卡点。`
          : `Tool ${notice.signature.slice(7)} has failed ${notice.count} times in a row; change approach or report the blocker.`
        : language === "zh-CN"
          ? `你已用相同参数重复调用 ${notice.signature.split(":")[0]} ${notice.count} 次，请换策略或向用户汇报进展，不要继续重复。`
          : `You have called ${notice.signature.split(":")[0]} ${notice.count} times with the same arguments; change strategy or report progress instead of repeating.`;
      emitContextStream({
        id: `tool-loop-${notice.signature.slice(0, 60)}-${notice.count}`,
        text: detail,
      });
      console.warn("tool loop detected", { reason: notice.reason, signature: notice.signature, count: notice.count });
    };
    let contextEventCount = 0;
    let contextEventId = "";
    let activeCompactionTrigger: {
      reason?: string;
      tokens?: number;
      window: number;
      threshold: number;
    } | undefined;
    const tokenCounter = createProviderTokenCounter(config.agent.baseUrl);
    const contextObservation: { before?: ContextSnapshot; failures?: number } = {};
    // 项目指导每轮从固定 SHA 的 worktree 现读，不缓存；只注入一条最高优先级文件。
    const projectGuidance = await readProjectGuidance(repositoryRoot, {
      enabled: config.agent.projectAgentsMd,
      maxBytes: config.agent.projectAgentsMdMaxBytes,
      language: config.agent.responseLanguage,
    });
    if (projectGuidance.files.length > 0) {
      emitContextStream({
        id: `project-guidance-${request.conversationId ?? "turn"}`,
        text: projectGuidanceNoticeText(config.agent.responseLanguage, projectGuidance.bytes, projectGuidance.truncated),
      });
    }
    // 命令输出流桥接：定义在扩展工厂之前，便于 run_command 工具在注册时捕获。
    const emitExecStream = (delta: ExecDelta) => {
      if (!request.onExecDelta) return;
      try {
        request.onExecDelta(delta);
      } catch (error) {
        console.warn("exec stream callback failed", { error: errorMessage(error) });
      }
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      // 不自动读取 agent 目录的 context 文件；项目指导完全由下面的 override 提供。
      noContextFiles: true,
      noThemes: true,
      noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: projectGuidance.files }),
      additionalSkillPaths: skillPathsResolved,
      extensionFactories: [
        // 把本轮真实注册的全部工具写进系统提示词：SDK 在自定义 systemPrompt 下不会
        // 自动生成 tools 段，模型只能看到函数 schema，无法在能力类提问中感知全部工具。
        createToolCatalogExtension(config.agent.responseLanguage),
        ...(managedSkillSection ? [createSkillCatalogExtension(managedSkillSection)] : []),
        // 先于其它工具注册：在结果进入会话历史之前按窗口预算截断，避免单轮工具输出
        // 在 SDK 下一次压缩检查之前把窗口顶爆。
        createToolResultBudgetExtension(config.agent.contextWindow),
        createFsReadExtension(
          readRoots,
          workspace && this.git
            ? (query, path) => this.git!.grep(workspace, query, path, signal)
            : undefined,
          workspace && this.git
            ? (path) => this.git!.getWorkspaceDiff(workspace, path, signal)
            : undefined,
        ),
        ...(toolAccess.webFetch
          ? [
              createWebReadExtension(config.agent.webBlockedHosts, signal),
              // 下载仅在对话 worktree 可用时注册；与 web_fetch 共用 SSRF 防护与 DNS 固定。
              createWebDownloadExtension(workingDirectory, config.agent.webBlockedHosts, signal),
            ]
          : []),
        ...(toolAccess.webSearch
          ? [createWebSearchExtension(
              config.agent.webSearchMaxQueries,
              config.agent.webBlockedHosts,
              signal,
              {
                backends: config.agent.webSearchBackends,
                searxngBaseUrl: config.agent.searxngBaseUrl,
                tavilyApiKey: config.agent.tavilyApiKey,
                apiKeys: {
                  tavily: config.agent.tavilyApiKey,
                  exa: config.agent.exaApiKey,
                  you: config.agent.youApiKey,
                },
              },
            )]
          : []),
        ...(executionBackend
          ? (() => {
              const options = {
                backend: executionBackend,
                cwd: repositoryRoot,
                mirrorPath,
                cachePath: cacheDir,
                signal,
                maxTimeoutMs: executionLimits.timeoutMs,
                maxOutputBytes: executionLimits.maxOutputBytes,
                onExecStart: (execId: string, stop: (reason: string) => void) => request.onExecStart?.(execId, stop),
                onExecEnd: (execId: string) => request.onExecEnd?.(execId),
                onExecDelta: emitExecStream,
                onExecuted: (result: ExecutionResult) => {
                  // 审计：记录操作者/会话/轮次/命令前缀/后端/退出码，不记完整敏感命令。
                  if (this.store && request.actorId !== undefined) {
                    this.store.insertExecutionAudit(
                      request.actorId,
                      request.conversationId ?? "",
                      request.turnId ?? "",
                      previewCommand(result.command),
                      result.backend,
                      result.exitCode,
                    );
                  }
                },
              };
              return [
                createExecutionExtension(options),
                // 技能命令沿用同一后端与流式/审计链路；未提供目录时不注册工具。
                ...(request.skillCommandCatalog && request.skillCommandCatalog.available().length > 0
                  ? [createSkillCommandExtension({ ...options, catalog: request.skillCommandCatalog })]
                  : []),
              ];
            })()
          : []),
        ...(request.taskType === "conversation"
          ? [createScheduledTaskExtension({
              ...(request.conversationId && this.store
                ? {
                    conversationId: request.conversationId,
                    store: {
                      create: (input) => this.store!.createScheduledTask(input),
                      list: (ownerUserId) => this.store!.listScheduledTasks(ownerUserId),
                      get: (id) => this.store!.getScheduledTask(id),
                      cancel: (id, ownerUserId) => this.store!.deleteScheduledTask(id, ownerUserId),
                      conversationOwner: (conversationId) => this.store!.getConversation(conversationId)?.ownerUserId,
                    },
                  }
                : {}),
            })]
          : []),
        ...(request.taskType === "conversation"
          ? [createPlanExtension({
              ...(request.conversationId && this.store
                ? {
                    conversationId: request.conversationId,
                    store: {
                      get: (id) => this.store!.getConversationPlan(id),
                      save: (id, steps) => this.store!.saveConversationPlan(id, steps),
                    },
                  }
                : {}),
            })]
          : []),
        ...(request.taskType === "conversation" && request.turnTools
          ? [createTurnToolsExtension(request.turnTools)]
          : []),
        ...(request.taskType === "conversation" && request.fs
          ? [createFsWriteExtension(request.fs)]
          : []),
        ...(request.taskType === "conversation" && request.gitTools
          ? [createGitExtension(request.gitTools)]
          : []),
        ...(request.conversationMode === "gitlab" && gitlab && request.conversationProjectId
          ? [createGitLabExtension({
              getProject: () => gitlab!.getProject(request.conversationProjectId!, signal),
              listIssues: (options) => gitlab!.listIssues(request.conversationProjectId!, options, signal),
              listMergeRequests: (options) => gitlab!.listMergeRequests(request.conversationProjectId!, options, signal),
              getIssue: (issueIid) => gitlab!.getIssue(request.conversationProjectId!, issueIid, signal),
              getMergeRequest: (mrIid) => gitlab!.getMergeRequest(request.conversationProjectId!, mrIid, signal),
              getMergeRequestChanges: (mrIid) => gitlab!.getMergeRequestChanges(request.conversationProjectId!, mrIid, signal),
              getIssueComments: (issueIid, limit) => gitlab!.getIssueComments(request.conversationProjectId!, issueIid, limit, signal),
              getMergeRequestComments: (mrIid, limit) => gitlab!.getMergeRequestComments(request.conversationProjectId!, mrIid, limit, signal),
              getMergeRequestCommits: (mrIid, page, perPage) => gitlab!.getMergeRequestCommits(request.conversationProjectId!, mrIid, page, perPage, signal),
              createIssue: (input) => gitlab!.createIssue(request.conversationProjectId!, input, signal),
              updateIssue: (issueIid, update) => gitlab!.updateIssue(request.conversationProjectId!, issueIid, update, signal),
              deleteIssue: (issueIid) => gitlab!.deleteIssue(request.conversationProjectId!, issueIid, signal),
              postIssueNote: (issueIid, noteBody) => gitlab!.postIssueNote(request.conversationProjectId!, issueIid, noteBody, signal),
              updateIssueNote: (issueIid, noteId, noteBody) => gitlab!.updateIssueNote(request.conversationProjectId!, issueIid, noteId, noteBody, signal),
              deleteIssueNote: (issueIid, noteId) => gitlab!.deleteIssueNote(request.conversationProjectId!, issueIid, noteId, signal),
              createMergeRequest: (input) => gitlab!.createMergeRequest(request.conversationProjectId!, input, signal),
              updateMergeRequest: (mrIid, update) => gitlab!.updateMergeRequest(request.conversationProjectId!, mrIid, update, signal),
              deleteMergeRequest: (mrIid) => gitlab!.deleteMergeRequest(request.conversationProjectId!, mrIid, signal),
              mergeMergeRequest: (mrIid, options) => gitlab!.mergeMergeRequest(request.conversationProjectId!, mrIid, options, signal),
              approveMergeRequest: (mrIid) => gitlab!.approveMergeRequest(request.conversationProjectId!, mrIid, signal),
              unapproveMergeRequest: (mrIid) => gitlab!.unapproveMergeRequest(request.conversationProjectId!, mrIid, signal),
              postMergeRequestNote: (mrIid, noteBody) => gitlab!.postNote(request.conversationProjectId!, mrIid, noteBody, signal),
              updateMergeRequestNote: (mrIid, noteId, noteBody) => gitlab!.updateMergeRequestNote(request.conversationProjectId!, mrIid, noteId, noteBody, signal),
              deleteMergeRequestNote: (mrIid, noteId) => gitlab!.deleteMergeRequestNote(request.conversationProjectId!, mrIid, noteId, signal),
              listMergeRequestDiscussions: (mrIid) => gitlab!.listMergeRequestDiscussions(request.conversationProjectId!, mrIid, signal),
              resolveDiscussion: (mrIid, discussionId, resolve) => gitlab!.resolveDiscussion(request.conversationProjectId!, mrIid, discussionId, resolve, signal),
            })]
          : []),
        createContextObserveExtension(contextObservation, {
          onBeforeCompact: (_snapshot, trigger) => {
            if (!contextEventId) contextEventId = `context-${++contextEventCount}`;
            const window = config.agent.contextWindow;
            const info = {
              reason: trigger.reason,
              tokens: trigger.tokens,
              window,
              threshold: activeCompactionTrigger?.threshold ?? selfCompactThreshold,
            };
            activeCompactionTrigger = info;
            emitContextStream({
              id: contextEventId,
              text: contextNoticeText(config.agent.responseLanguage, "start", info.tokens, undefined, info),
            });
          },
          onFailed: () => {
            if (!contextEventId) contextEventId = `context-${++contextEventCount}`;
            emitContextStream({
              id: contextEventId,
              text: contextNoticeText(config.agent.responseLanguage, "failed"),
            });
          },
        }, tokenCounter, async (event, snapshot, eventSignal) => {
          const { text, usage } = await generateSummaryWithUsage(
            event.preparation.messagesToSummarize as never,
            model,
            undefined,
            config.agent.apiKey,
            undefined,
            eventSignal,
            domainSummaryInstructions(config.agent.responseLanguage),
            event.preparation.previousSummary,
            undefined,
            (summaryModel, context, options) => runtime.streamSimple(summaryModel, context, options),
          );
          return {
            summary: text,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: snapshot.tokens ?? event.preparation.tokensBefore,
            estimatedTokensAfter: Math.ceil(text.length / 4),
            usage,
          };
        }),
        createMicrocompactExtension({
          ...resolveMicrocompactPolicy(config.agent.contextWindow, config.agent.compactionTriggerPercent),
          estimateTokens: (messages) => estimateConservativeTokens(messagesToText(messages)),
          onPruned: (pruned, savedChars, signature) => {
            this.store?.recordContextMetric("microcompact", pruned);
            this.store?.recordContextMetric("microcompact_chars", savedChars);
            emitContextStream({
              id: `microcompact-${signature}`,
              text: microcompactNoticeText(config.agent.responseLanguage, pruned, savedChars),
            });
          },
        }),
        // 上下文洞察通过 hook 接入：PiAgent 只产出有界快照，落库由默认 tap 完成。
        // 关闭时完全不注册扩展，避免每次请求多做一次 token 计数调用。
        ...(this.hooks && config.agent.contextInspectEnabled && request.conversationId && request.turnId
          ? [createContextInspectExtension({
              conversationId: request.conversationId,
              turnId: request.turnId,
              contextWindow: config.agent.contextWindow,
              reservedOutput: config.agent.maxOutputTokens,
              threshold: activeCompactionTrigger?.threshold ?? selfCompactThreshold,
              tokenCounter,
              signal,
              maxItems: config.agent.contextInspectMaxItems,
              maxPreviewChars: config.agent.contextInspectMaxPreviewChars,
              onSnapshot: (snapshot) => {
                void callAsyncHook(this.hooks!.contextSnapshot, snapshot).catch((error: unknown) => {
                  console.warn("context snapshot hook failed", { error: errorMessage(error) });
                });
              },
            })]
          : []),
      ],
      systemPrompt: request.systemPrompt,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      modelRuntime: runtime,
      model,
      resourceLoader,
      // 压缩阈值与配置的上下文窗口绑定：SDK 默认值按 200K 窗口调过，直接沿用
      // 会让 128K 窗口在压缩前就已超限。这里用内存设置管理器覆盖，不落盘。
      settingsManager: SettingsManager.inMemory({
        compaction: {
          enabled: true,
          reserveTokens: sdkReserveTokens,
          keepRecentTokens: compactionKeepRecentTokens,
        },
        // 显式压低各级思考预算（SDK 默认 medium 就 8192，容易吃光整个输出预算）。
        thinkingBudgets: resolveThinkingBudgets(config.agent.maxOutputTokens),
      }),
      sessionManager: restoredEntries
        ? SessionManager.inMemory(agentDir, undefined, restoredEntries)
        : SessionManager.inMemory(),
      noTools: request.noTools ? "all" : "builtin",
      // 显式使用当前生效等级；全局关闭推理时统一为 off。
      thinkingLevel: config.agent.reasoningEnabled ? config.agent.thinkingLevel : "off",
    });
    // 插话在会话就绪后才可投递：一次边界把积压的补充消息一起交给模型，避免
    // 逐条拆散到多次模型调用里，让用户误以为补充只被看见一半。
    if (request.steer) {
      session.setSteeringMode("all");
      request.steer.bind((text) => session.steer(text));
      request.steer.onStatus((status) => request.onSteerStatus?.(status));
    }
    // 历史以独立消息注入：模型看到的是真实轮次，而不是一条巨型 user 消息，
    // SDK 的压缩切点也才能在正确的轮次边界上工作。恢复完整会话时已含这些消息，跳过注入。
    if (!restoredEntries) {
      for (const message of seedHistoryMessages(request.history ?? [], providerId, config.agent.model)) {
        session.sessionManager.appendMessage(message);
      }
    }
    // 动态阈值需要本轮的真实增量：先记录历史注入后的 token 基线，回合结束时用
    // 「最终 token − 基线」衡量本轮增长。只记录文本/思考，与结束时的计数口径一致。
    let baselineTokens: number | undefined;
    if (config.agent.compactionDynamicThreshold) {
      const baselineText = messagesToText((session.sessionManager as unknown as {
        buildSessionProjection(): { messages: unknown[] };
      }).buildSessionProjection().messages);
      const countedBaseline = await tokenCounter.count(baselineText, signal);
      this.store?.recordContextMetric(countedBaseline === undefined ? "token_count_fallback" : "token_count_real", 1);
      baselineTokens = countedBaseline ?? estimateTokens(baselineText);
    }
    const activeTools = new Map<string, { traceId: number; startedAt: number }>();
    let modelCallCount = 0;
    // 缓存命中按本轮所有模型响应累加；SDK 的 session 统计是跨轮累计值，不能直接当本轮用量。
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let currentRound = 0;
    // 单轮内工具结果累计字节：仅作为软提醒阈值，不再中止本轮。阈值收敛到
    // 「四个单轮工具预算」，让提醒在压缩发生前就能到达模型。
    const toolResultByteLimit = resolveTurnToolResultBytes(
      config.agent.contextWindow,
      config.agent.turnToolResultBytes,
    );
    let toolResultBytes = 0;
    let toolBudgetWarningSent = false;
    const recordedContextEntryIds = new Set<string>();
    let hasRecordedContext = false;
    // 最终助手消息的错误原因：`session.prompt()` 在服务端报错（如上下文超限）时仍会正常
    // 返回，若不记录就会把上一条历史回复当成本轮成功结果，超限重试也就永远不会触发。
    let lastAssistantError: string | undefined;
    let lastCompactionSummary: string | undefined;
    // 流式正文、思考与工具调用只做展示，不参与判定；回调异常不能影响模型执行。
    let streamedAssistantText = "";
    let streamedAssistantThinking = "";
    // SDK 的 tool_execution_end 事件不带 args，这里从 start 缓存原始入参供展示、hook 与循环检测共用。
    // 必须存原始对象而不是 JSON 字符串，否则 toolSignature 的稳定序列化会被绕过（键顺序影响签名）。
    const streamToolInputs = new Map<string, unknown>();
    let endedToolArgs: unknown = null;
    const emitStream = (
      callback: ((update: { reset: boolean; text: string }) => void) | undefined,
      label: string,
      reset: boolean,
      text: string,
    ) => {
      if (!callback) return;
      try {
        callback({ reset, text });
      } catch (error) {
        console.warn(`${label} stream callback failed`, { error: errorMessage(error) });
      }
    };
    const emitToolStream = (tool: ConversationStreamTool) => {
      if (!request.onToolDelta) return;
      try {
        request.onToolDelta(tool);
      } catch (error) {
        console.warn("tool stream callback failed", { error: errorMessage(error) });
      }
    };
    const emitScheduleCard = (details: unknown) => {
      if (!request.onScheduleCard) return;
      const card = parseScheduleCard(details);
      if (!card) return;
      try {
        request.onScheduleCard(card);
      } catch (error) {
        console.warn("schedule card callback failed", { error: errorMessage(error) });
      }
    };
    let activeCompaction: {
      streamId: string;
      traceId?: number;
      reason: string;
      startedAt: number;
      before?: ContextSnapshot;
    } | undefined;
    const unsubscribe = session.subscribe((event) => {
      // 只在真正产出内容时重置看门狗：失败响应与 SDK 重试不算「模型有输出」。
      if (event.type === "tool_execution_start") runningToolCount += 1;
      if (event.type === "tool_execution_end") runningToolCount = Math.max(0, runningToolCount - 1);
      // 插话进入模型上下文：SDK 把它从 steering 队列移除时会再次发 queue_update。
      if (event.type === "queue_update" && request.steer) {
        request.steer.markDelivered(event.steering);
      }
      if (event.type === "message_update" || event.type === "tool_execution_start" ||
          event.type === "tool_execution_end" || event.type === "compaction_start" ||
          event.type === "compaction_end") {
        markActivity();
      }
      if (event.type === "compaction_start") {
        const streamId = contextEventId || `context-${++contextEventCount}`;
        contextEventId = streamId;
        if (!activeCompactionTrigger) {
          emitContextStream({ id: streamId, text: contextNoticeText(config.agent.responseLanguage, "start") });
        }
        activeCompaction = {
          streamId,
          reason: event.reason,
          startedAt: performance.now(),
          before: contextObservation.before,
          traceId: trace
            ? this.startTrace(trace, "context", "context.compact", "", null, {
                input: JSON.stringify({
                  phase: "start",
                  reason: event.reason,
                  id: streamId,
                  trigger: activeCompactionTrigger ?? null,
                  before: contextObservation.before ?? null,
                }),
              })
            : undefined,
        };
        return;
      }
      if (event.type === "compaction_end") {
        const active = activeCompaction;
        activeCompaction = undefined;
        contextEventId = "";
        activeCompactionTrigger = undefined;
        const before = active?.before ?? contextObservation.before ?? null;
        contextObservation.before = undefined;
        const result = event.result;
        const language = config.agent.responseLanguage;
        const failed = event.aborted || !result;
        if (!failed && result) lastCompactionSummary = redactSensitiveText(result.summary);
        this.store?.recordContextMetric("compaction", 1);
        if (active?.reason === "threshold" || event.reason === "threshold") {
          this.store?.recordContextMetric("compaction_threshold", 1);
        } else if (active?.reason === "overflow" || event.reason === "overflow") {
          this.store?.recordContextMetric("compaction_overflow", 1);
        }
        emitContextStream({
          id: active?.streamId ?? `context-${++contextEventCount}`,
          text: failed
            ? contextNoticeText(language, "failed")
            : contextNoticeText(language, "end", result.tokensBefore, result.estimatedTokensAfter),
        });
        const details = JSON.stringify({
          phase: "end",
          reason: active?.reason ?? event.reason,
          aborted: event.aborted,
          willRetry: event.willRetry,
          trigger: active?.reason ? { reason: active.reason } : null,
          before,
          after: result
            ? {
                tokens: result.estimatedTokensAfter ?? null,
                summary: result.summary,
                firstKeptEntryId: result.firstKeptEntryId,
              }
            : null,
          ...(event.errorMessage ? { error: event.errorMessage } : {}),
        });
        const duration = active ? performance.now() - active.startedAt : 0;
        if (active?.traceId !== undefined) {
          this.finishTrace(active.traceId, failed ? "failed" : "succeeded", duration, undefined, undefined,
            failed ? event.errorMessage ?? "context compaction aborted" : undefined, details);
        } else if (trace) {
          const traceId = this.startTrace(trace, "context", "context.compact", "", null, { input: details });
          if (traceId !== undefined) this.finishTrace(traceId, failed ? "failed" : "succeeded", duration);
        }
        return;
      }
      if (event.type === "message_start" && event.message.role === "assistant") {
        streamedAssistantText = "";
        streamedAssistantThinking = "";
        emitStream(request.onTextDelta, "assistant text", true, "");
        emitStream(request.onThinkingDelta, "assistant thinking", true, "");
      } else if (event.type === "message_update" && event.message.role === "assistant") {
        // 同一条增量里同时带思考与正文时先推思考，保持流里「先思考、后回答」的顺序。
        const thinking = assistantThinking(event.message);
        if (thinking !== streamedAssistantThinking) {
          streamedAssistantThinking = thinking;
          emitStream(request.onThinkingDelta, "assistant thinking", false, thinking);
        }
        const text = assistantText(event.message);
        if (text !== streamedAssistantText) {
          streamedAssistantText = text;
          emitStream(request.onTextDelta, "assistant text", false, text);
        }
      }
      // 工具事件发生在两轮模型输出之间，先于轨迹落库推送，界面才能按
      // 「思考 → 工具 → 下一轮思考」的真实顺序逐条渲染。
      if (event.type === "tool_execution_start") {
        streamToolInputs.set(event.toolCallId, event.args);
        emitToolStream({
          id: event.toolCallId,
          name: event.toolName,
          input: JSON.stringify(event.args) ?? null,
          status: "running",
          durationMs: null,
        });
      } else if (event.type === "tool_execution_end") {
        // 删除缓存前先取出入参：后面的 hook 与循环检测都在同一个回调的后半段读取。
        endedToolArgs = streamToolInputs.get(event.toolCallId) ?? null;
        const output = event.isError ? null : readToolResultText(event.result);
        emitToolStream({
          id: event.toolCallId,
          name: event.toolName,
          input: JSON.stringify(endedToolArgs) ?? null,
          status: event.isError ? "failed" : "succeeded",
          durationMs: event.durationMs ?? null,
          ...(output ? { output } : {}),
        });
        if (!event.isError) {
          emitScheduleCard((event.result as { details?: unknown } | undefined)?.details);
        }
        streamToolInputs.delete(event.toolCallId);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        lastAssistantError = event.message.stopReason === "error" || event.message.stopReason === "aborted"
          ? event.message.errorMessage ?? `model request ${event.message.stopReason}`
          : undefined;
      }
      if (!trace) return;
      if (event.type === "message_start" && event.message.role === "assistant") {
        const round = ++currentRound;
        const startedAt = performance.now();
        const contextEntries = session.sessionManager.buildContextEntries();
        const currentContextEntryIds = new Set(contextEntries.map((entry) => entry.id));
        const contextReset = !hasRecordedContext ||
          [...recordedContextEntryIds].some((id) => !currentContextEntryIds.has(id));
        const newContextEntries = contextReset
          ? contextEntries
          : contextEntries.filter((entry) => !recordedContextEntryIds.has(entry.id));
        const traceId = this.startTrace(
          trace,
          "llm",
          trace.taskType,
          `${providerLabel}/${event.message.responseModel ?? event.message.model}`,
          // 图片 Base64 绝不进轨迹；只留文件名/类型/字节数元数据。
          modelCallCount === 0 ? JSON.stringify({
            ...request,
            images: request.images?.map(({ filename, mimeType, data }) => ({
              filename, mimeType, bytes: Buffer.byteLength(data, "base64"),
            })),
          }) : null,
          {
            round,
            input: JSON.stringify({
              contextMode: "delta",
              contextReset,
              ...(contextReset ? { systemPrompt: session.systemPrompt } : {}),
              messages: newContextEntries,
            }),
          },
        );
        modelCallCount++;
        if (traceId !== undefined) {
          const requestTiming = pendingRequestTiming;
          pendingRequestTiming = undefined;
          activeModelCall = { traceId, startedAt, round, ...requestTiming };
          recordedContextEntryIds.clear();
          for (const entry of contextEntries) recordedContextEntryIds.add(entry.id);
          hasRecordedContext = true;
        }
      } else if (event.type === "message_update" && event.message.role === "assistant") {
        if (activeModelCall && activeModelCall.firstTokenMs === undefined && hasGeneratedOutput(event.assistantMessageEvent)) {
          activeModelCall.firstTokenAt = performance.now();
          activeModelCall.firstTokenMs = activeModelCall.firstTokenAt -
            (activeModelCall.requestStartedAtMono ?? activeModelCall.startedAt);
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        if (!activeModelCall) return;
        const message = event.message;
        cacheReadTokens += message.usage.cacheRead ?? 0;
        cacheWriteTokens += message.usage.cacheWrite ?? 0;
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        const endedAt = performance.now();
        const durationMs = activeModelCall.requestStartedAtMono === undefined
          ? message.durationMs ?? endedAt - activeModelCall.startedAt
          : endedAt - activeModelCall.requestStartedAtMono;
        const generationDurationMs = activeModelCall.firstTokenAt === undefined
          ? undefined
          : Math.max(0, endedAt - activeModelCall.firstTokenAt);
        this.finishTrace(
          activeModelCall.traceId,
          failed ? "failed" : "succeeded",
          durationMs,
          message.usage.input,
          message.usage.output,
          failed ? message.errorMessage ?? `model request ${message.stopReason}` : undefined,
          JSON.stringify({
            content: message.content.filter((part) => part.type === "text" || part.type === "toolCall"),
            stopReason: message.stopReason,
          }),
          activeModelCall.firstTokenMs,
          generationDurationMs,
          activeModelCall.requestStartedAt,
          activeModelCall.responseHeadersMs,
        );
        activeModelCall = undefined;
        // 任务级软预算：达到轮次/输出上限时用 steer 要求模型收尾汇报。
        if (!failed) {
          const hitRounds = taskBudgetLimits.maxRounds > 0 && taskBudget.rounds + 1 >= taskBudgetLimits.maxRounds;
          const shouldWrapUp = observeTaskBudget(taskBudget, taskBudgetLimits, message.usage.output);
          if (shouldWrapUp) {
            const reason = hitRounds ? "rounds" : "tokens";
            const value = hitRounds ? taskBudget.rounds : taskBudget.outputTokens;
            const notice = wrapUpNotice(config.agent.responseLanguage, reason, value);
            void session.steer(notice).catch((error: unknown) => {
              console.warn("task budget wrap-up notice failed", { error: errorMessage(error) });
            });
            emitContextStream({ id: `task-budget-${reason}`, text: notice });
          }
        }
      } else if (event.type === "tool_execution_start") {
        const traceId = this.startTrace(trace, "tool", event.toolName, "", JSON.stringify(event.args), {
          round: currentRound || undefined,
          input: JSON.stringify(event.args),
          schema: JSON.stringify(session.getToolDefinition(event.toolName)?.parameters ?? null),
        });
        if (traceId !== undefined) {
          activeTools.set(event.toolCallId, { traceId, startedAt: performance.now() });
        }
        if (this.hooks) {
          void callAsyncHook(this.hooks.toolBefore, {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: event.args,
            scope: trace?.scope,
            attempt: trace?.attempt,
          }).catch((error: unknown) => console.warn("tool before hook failed", { error: errorMessage(error) }));
        }
      } else if (event.type === "tool_execution_end") {
        const active = activeTools.get(event.toolCallId);
        if (!active) return;
        if (this.hooks) {
          void callAsyncHook(this.hooks.toolAfter, {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            input: JSON.stringify(endedToolArgs) ?? null,
            output: event.result,
            status: event.isError ? "failed" : "succeeded",
            durationMs: event.durationMs ?? performance.now() - active.startedAt,
            scope: trace?.scope,
            attempt: trace?.attempt,
          }).catch((error: unknown) => console.warn("tool after hook failed", { error: errorMessage(error) }));
        }
        const loopNotice = recordToolCall(toolLoop, event.toolName, endedToolArgs, event.isError);
        if (loopNotice) noticeToolLoop(loopNotice);
        this.finishTrace(
          active.traceId,
          event.isError ? "failed" : "succeeded",
          event.durationMs ?? performance.now() - active.startedAt,
          undefined,
          undefined,
          event.isError ? JSON.stringify(event.result, null, 2) : undefined,
          JSON.stringify(event.result),
        );
        activeTools.delete(event.toolCallId);
        if (toolResultByteLimit > 0) {
          toolResultBytes += Buffer.byteLength(JSON.stringify(event.result) ?? "");
          // 只做软提醒：达到阈值后提示模型优先收尾，但不中止本轮。真正的上下文增长
          // 由 SDK 压缩与服务端超限重试处理，长任务因此能在同一会话内完成。
          if (!toolBudgetWarningSent && toolResultBytes >= toolResultByteLimit * toolBudgetWarningRatio) {
            toolBudgetWarningSent = true;
            void session.steer(getToolBudgetWarningPrompt(
              config.agent.responseLanguage,
              toolResultBytes,
              toolResultByteLimit,
            )).catch((error) => {
              console.warn("tool budget warning could not be delivered", { error: errorMessage(error) });
            });
          }
        }
      }
    });
    const abort = () => {
      void session.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // 无响应看门狗：等待首响应期间定期推送进度提示，超过阈值直接中止本轮。
    const stallMs = config.agent.responseStallTimeout;
    const stallSeconds = Math.round(stallMs / 1000);
    const waitingId = `waiting-${request.conversationId ?? "turn"}`;
    let lastNoticeSecond = 0;
    const stallTimer = stallMs > 0
      ? setInterval(() => {
          // 有工具在跑时不判 stall：模型的"沉默"是等工具结果，而工具自身有 timeout。
          if (runningToolCount > 0) {
            markActivity();
            return;
          }
          const idleMs = performance.now() - lastActivityAt;
          if (idleMs >= stallMs) {
            stallController.abort(new Error(config.agent.responseLanguage === "zh-CN"
              ? `模型超过 ${stallSeconds} 秒无输出，已中止本轮`
              : `No model output for ${stallSeconds}s; the turn was aborted`));
            return;
          }
          const idleSeconds = Math.floor(idleMs / 1000);
          if (idleSeconds >= 5 && idleSeconds - lastNoticeSecond >= 10) {
            lastNoticeSecond = idleSeconds;
            emitContextStream({
              id: waitingId,
              text: responseWaitNoticeText(config.agent.responseLanguage, idleSeconds, stallSeconds),
            });
          }
        }, 1_000)
      : undefined;
    try {
      await session.bindExtensions({});
      if (signal?.aborted) throw new Error(
        signal.reason instanceof Error ? signal.reason.message : "Pi agent run was aborted",
      );
      // 图片作为本轮用户消息的多模态内容注入；data 必须是裸 Base64，SDK 自己拼 data URL。
      await session.prompt(request.userPrompt, request.images?.length
        ? { images: request.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) }
        : undefined);
      // 外部取消优先：中止后的半截文本不能当作完成结果。
      if (signal?.aborted) throw new Error(
        signal.reason instanceof Error ? signal.reason.message : "Pi agent run was aborted",
      );
      // 服务端报错（含上下文超限）时 `prompt()` 不抛出，必须显式上抛，否则会返回历史回复
      // 并让上层的「去掉历史重试一次」失效。
      if (lastAssistantError) throw new Error(lastAssistantError);
      const content = session.getLastAssistantText()?.trim();
      if (!content) throw new EmptyCompletionError();
      const usage = session.getSessionStats().tokens;
      // 回合结束后按真实 token 数主动压缩，为下一轮留出空间；compact() 会先 abort，
      // 因此必须在 prompt() 完全结束之后调用，避免打断正在执行的轮次。
      try {
        const entries = (session.sessionManager as unknown as {
          buildSessionProjection(): { messages: unknown[] };
        }).buildSessionProjection().messages;
        const text = messagesToText(entries);
        const counted = await tokenCounter.count(text, signal);
        this.store?.recordContextMetric(counted === undefined ? "token_count_fallback" : "token_count_real", 1);
        const tokens = counted ?? estimateTokens(text);
        let effectiveThreshold = selfCompactThreshold;
        if (config.agent.compactionDynamicThreshold && baselineTokens !== undefined) {
          const growth = Math.max(0, tokens - baselineTokens);
          const key = request.conversationId;
          const previous = key ? this.growthByConversation.get(key) ?? [] : [];
          const adaptive = resolveAdaptiveCompactionThreshold({
            window: config.agent.contextWindow,
            baseThreshold: selfCompactThreshold,
            capThreshold: compactionHardCap,
            growth,
            previous,
          });
          effectiveThreshold = adaptive.threshold;
          if (key) this.growthByConversation.set(key, adaptive.samples);
        }
        if (tokens >= effectiveThreshold) {
          activeCompactionTrigger = {
            reason: "threshold",
            tokens,
            window: config.agent.contextWindow,
            threshold: effectiveThreshold,
          };
          const compaction = await session.compact();
          lastCompactionSummary = redactSensitiveText(compaction.summary);
          activeCompactionTrigger = undefined;
        }
      } catch (error) {
        activeCompactionTrigger = undefined;
        console.warn("self-triggered context compaction failed", { error: errorMessage(error) });
      }
      // 把完整会话（含本轮 tool_use/tool_result 与压缩边界）持久化，供下一轮恢复真实上下文。
      if (sessionKey) {
        try {
          const manager = session.sessionManager;
          const header = manager.getHeader();
          if (header) {
            // 只持久化活动分支；超限时保留压缩点与最近消息链，而不是放弃整个会话。
            const bounded = boundSessionEntries(
              header as unknown as Parameters<typeof boundSessionEntries>[0],
              stripImageContent(manager.getBranch() as unknown as readonly SessionEntryLike[]),
              maxPersistedSessionBytes,
            );
            if (bounded.entries.length > 0) {
              this.store?.saveConversationSessionEntries(sessionKey, JSON.stringify(bounded.entries));
              if (bounded.truncated) {
                console.warn("conversation session bounded to persistence limit", {
                  conversationId: sessionKey,
                  dropped: bounded.dropped,
                  maxBytes: maxPersistedSessionBytes,
                });
              }
            } else {
              console.warn("conversation session entry exceeds persistence limit", {
                conversationId: sessionKey, maxBytes: maxPersistedSessionBytes,
              });
            }
          }
        } catch (error) {
          console.warn("persist conversation session failed", {
            conversationId: sessionKey, error: errorMessage(error),
          });
        }
      }
      return {
        content,
        model: `${providerLabel}/${model.id}`,
        usage: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          totalTokens: usage.total,
          cacheReadTokens,
          cacheWriteTokens,
        },
        ...(lastCompactionSummary ? { compactionSummary: lastCompactionSummary } : {}),
      };
    } catch (error) {
      if (activeModelCall) {
        const endedAt = performance.now();
        const durationMs = endedAt - activeModelCall.startedAt;
        const generationDurationMs = activeModelCall.firstTokenAt === undefined
          ? undefined
          : Math.max(0, endedAt - activeModelCall.firstTokenAt);
        this.finishTrace(
          activeModelCall.traceId,
          "failed",
          durationMs,
          undefined,
          undefined,
          errorMessage(error),
          undefined,
          activeModelCall.firstTokenMs,
          generationDurationMs,
          activeModelCall.requestStartedAt,
          activeModelCall.responseHeadersMs,
        );
        activeModelCall = undefined;
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (stallTimer) clearInterval(stallTimer);
      void dispatcher.close();
      if (activeModelCall) {
        const endedAt = performance.now();
        const durationMs = endedAt - activeModelCall.startedAt;
        const generationDurationMs = activeModelCall.firstTokenAt === undefined
          ? undefined
          : Math.max(0, endedAt - activeModelCall.firstTokenAt);
        this.finishTrace(
          activeModelCall.traceId,
          "failed",
          durationMs,
          undefined,
          undefined,
          "model request did not complete",
          undefined,
          activeModelCall.firstTokenMs,
          generationDurationMs,
          activeModelCall.requestStartedAt,
          activeModelCall.responseHeadersMs,
        );
      }
      for (const active of activeTools.values()) {
        this.finishTrace(active.traceId, "failed", performance.now() - active.startedAt);
      }
      session.dispose();
    }
  }

  private startTrace(
    trace: TraceContext,
    kind: TraceKind,
    name: string,
    model = "",
    rawContent: string | null = null,
    details: { round?: number; input?: string | null; schema?: string | null } = {},
  ): number | undefined {
    if (!this.store) return undefined;
    try {
      return this.store.startTrace(
        trace.scope,
        trace.attempt,
        kind,
        name.slice(0, 128),
        model.slice(0, 256),
        rawContent,
        details,
      );
    } catch (error) {
      console.warn("record event trajectory start failed", {
        scope: trace.scope,
        kind,
        name: name.slice(0, 128),
        error: errorMessage(error),
      });
      return undefined;
    }
  }

  private finishTrace(
    traceId: number | undefined,
    status: "succeeded" | "failed",
    durationMs: number,
    inputTokens?: number,
    outputTokens?: number,
    errorDetail?: string,
    output?: string,
    firstTokenMs?: number,
    generationDurationMs?: number,
    requestStartedAt?: string,
    responseHeadersMs?: number,
  ): void {
    if (!this.store || traceId === undefined) return;
    try {
      this.store.finishTrace(
        traceId,
        status,
        durationMs,
        inputTokens,
        outputTokens,
        errorDetail,
        output,
        firstTokenMs,
        generationDurationMs,
        requestStartedAt,
        responseHeadersMs,
      );
    } catch (error) {
      console.warn("record event trajectory completion failed", {
        traceId,
        status,
        error: errorMessage(error),
      });
    }
  }
}
