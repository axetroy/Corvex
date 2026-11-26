/** 需要模型调用的任务类型：Server 内联执行的对话轮次。 */
export const modelTaskTypes = ["conversation"] as const;
export type ModelTaskType = (typeof modelTaskTypes)[number];

/** 在边界处校验外部字符串是否为已知模型任务类型。 */
export function isModelTaskType(value: string): value is ModelTaskType {
  return modelTaskTypes.some((type) => type === value);
}

export type ConversationMessageStatus = "queued" | "running" | "completed" | "failed";

/** 对话轮次的执行状态；由 Server 内联执行，不经过事件队列。 */
export const conversationTurnStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "stale",
  "cancelled",
] as const;
export type ConversationTurnStatus = (typeof conversationTurnStatuses)[number];

/** 在边界处校验外部字符串是否为已知对话轮次状态。 */
export function isConversationTurnStatus(value: string): value is ConversationTurnStatus {
  return conversationTurnStatuses.some((status) => status === value);
}

/**
 * 对话模式：决定该对话允许的能力。
 *
 * 对话统一为可读可写：既能读取仓库，也能读取并按用户明确要求写入 GitLab。
 * 保留显式的模式字段是为了让 `conversationCapabilities` 继续作为能力的唯一来源，
 * 新增模式必须同时在存储、执行与界面三处接线。
 */
export const conversationModes = ["gitlab"] as const;
export type ConversationMode = (typeof conversationModes)[number];

/** 新建对话默认使用的模式。 */
export const defaultConversationMode: ConversationMode = "gitlab";

/** 在边界处校验外部字符串是否为已知对话模式。 */
export function isConversationMode(value: string): value is ConversationMode {
  return conversationModes.some((mode) => mode === value);
}

/** 某一对话模式允许的能力；执行与界面都以此为唯一依据。 */
export interface ConversationCapabilities {
  /** 该模式执行的执行步骤名，写入执行记录并展示在轨迹中。 */
  workflowStep: string;
  /** 是否允许仓库写入类工具（打补丁、提交、推送）。 */
  repositoryWrite: boolean;
  /** 是否允许向 GitLab 发布评论、更新 Issue/MR 与关闭它们。 */
  gitlabWrite: boolean;
  /** 是否开放绑定当前 worktree 的 Git 工具集（含提交与写入会话 ref）。 */
  gitToolset: boolean;
}

/** 由模式派生能力；新增模式时这里会因缺少分支而编译失败，强制补齐声明。 */
export function conversationCapabilities(mode: ConversationMode): ConversationCapabilities {
  switch (mode) {
    case "gitlab":
      return { workflowStep: "workflow.gitlab_conversation", repositoryWrite: false, gitlabWrite: true, gitToolset: true };
    default: {
      const exhaustive: never = mode;
      throw new Error(`unhandled conversation mode: ${String(exhaustive)}`);
    }
  }
}

/** 轨迹归属：每条对话轨迹都属于一个轮次。 */
export interface TraceScope {
  turnId: string;
}

/** 模型生成内容的语言；控制台按界面语言传入，服务端缺省使用运行时配置。 */
export type ResponseLanguage = "en" | "zh-CN";

/** 模型思考等级；与 Pi SDK 的 ThinkingLevel 取值一致，前端不依赖 SDK 类型。 */
/** 任务清单中单步的状态；done 的步骤不删除，便于汇报进度。 */
export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

/** 会话的任务清单：跨轮持久化，模型可更新步骤状态。 */
export interface ConversationPlan {
  steps: PlanStep[];
  updatedAt: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const thinkingLevels: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (thinkingLevels as readonly string[]).includes(value);
}

export interface ConversationSummary {
  id: string;
  /** 由模型生成的对话标题；尚未生成时为空字符串。 */
  title: string;
  projectId: number;
  projectName: string;
  targetBranch: string;
  /** 该对话的模式；决定允许的能力（当前统一为可读可写的 `gitlab`）。 */
  mode: ConversationMode;
  /**
   * 会话当前与远端同步到的提交，也是本地未发布改动的基线。
   * 只 commit 时保持不变（改动仍处于「未发布」状态）；成功 publish 到目标分支后前进到该提交。
   */
  baseSha: string;
  /**
   * 基线所在的分支。目标分支上时可在新轮次跟随远端快照；
   * 功能分支上则保持基线，否则下一轮会退回目标分支而丢掉发布进度。
   */
  baseBranch: string;
  createdAt: string;
  updatedAt: string;
  /** 该对话的轮次总数（每条助手回复对应一轮）。 */
  turnCount: number;
  /** 最近一轮的状态；尚无轮次时为空。 */
  lastTurnStatus: ConversationTurnStatus | null;
  /** 是否已归档；归档的对话默认不出现在列表里。 */
  archived: boolean;
  /** 拥有该会话的本地用户 ID。 */
  ownerUserId: string;
}

/**
 * 助手回复期间的一次工具调用摘要，供对话列表直接展示该轮读过哪些文件、
 * 调用是否成功以及耗时，无需再跳到轨迹标签。参数沿用轨迹的脱敏与限长结果。
 */
export interface ConversationToolCall {
  name: string;
  status: TraceStatus;
  /** 工具调用参数（脱敏后的 JSON 文本）；未记录时为空。 */
  input: string | null;
  durationMs: number | null;
}

/**
 * 落库的对话过程条目：按发生顺序记录每轮思考、模型的中间回复与工具调用。
 * 最终回答已存于消息的 `content`，这里不再重复保存；思考只在本次会话的流里出现，
 * 但只要产生了文本就会随轮次落库，刷新页面后仍能在过程块里看到。
 */
export type ConversationProcessEntry =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "context"; id: string; text: string }
  | { kind: "interjection"; text: string }
  | { kind: "scheduleCard"; card: ScheduledTaskCard }
  | {
      kind: "tool";
      id?: string;
      name: string;
      input: string | null;
      status: TraceStatus;
      durationMs: number | null;
      /** run_command 的脱敏输出，随过程快照落库，供刷新后回放终端（chunk 已拼接为完整文本）。 */
      execOutput?: {
        stdout: string;
        stderr: string;
        exitCode?: number | null;
        aborted?: boolean;
        reason?: string;
        truncated?: boolean;
      };
    };

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  /** 普通消息或运行中执行中的插话；插话不单独成轮，展示在所属轮次的过程里。 */
  kind: "message" | "interjection";
  content: string;
  status: ConversationMessageStatus;
  /** 助手回复对应的轮次 ID；用户消息为空。 */
  turnId: string | null;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  /** 助手回复所对应轮次的终态；用户消息与未执行回复为空。 */
  turnStatus: ConversationTurnStatus | null;
  /** 助手回复对应轮次已记录的轨迹条目数，供界面提示「有轨迹可看」。 */
  traceCount: number;
  /** 助手回复对应轮次已记录的执行步骤数。 */
  stepCount: number;
  /** 生成这条回复时使用的模型名称。 */
  model: string;
  /** 助手回复对应轮次的端到端耗时；未结束或无法计算时为空。 */
  durationMs: number | null;
  /** 已记录成功模型调用的输出速度（tokens/s）；无有效样本时为空。 */
  tps: number | null;
  /** 本轮缓存命中率（0–100）；供应商未报告缓存读写时为空。 */
  cacheHitRate: number | null;
  /** 命中率分母与分子，供界面提示明细；未报告时为空。 */
  cacheTokens: { input: number; read: number; write: number } | null;
  /** 助手回复已记录的工具调用摘要，按调用时间排序；用户消息为空数组。 */
  toolCalls: ConversationToolCall[];
  /** 该轮落库的过程条目（思考、中间回复、工具调用），按发生顺序排列。 */
  process: ConversationProcessEntry[];
  /** 模型附带并经服务端校验的下一步建议，点击后填入输入框。 */
  suggestions: string[];
}

export interface Conversation extends ConversationSummary {
  messages: ConversationMessage[];
}

/** 供 Agent 回查当前会话历史的轮次摘要；序号按轮次创建顺序从 1 开始。 */
export interface AgentTurnSummary {
  index: number;
  turnId: string;
  status: ConversationTurnStatus;
  createdAt: string;
  request: string;
  answer: string;
  truncated: boolean;
}

/** 单轮详情：请求、最终回复、真实工具证据与有界过程记录。 */
export interface AgentTurnDetail {
  index: number;
  turnId: string;
  status: ConversationTurnStatus;
  createdAt: string;
  request: string;
  answer: string;
  tools: Array<{ name: string; status: string; input: string; output: string }>;
  notes: string[];
  truncated: boolean;
}

/**
 * 对话轮次的流式事件，经 SSE 推送给 Agent 控制台。
 *
 * 助手正文在落库之前先按增量推送：`reset` 表示模型开始新一轮输出（工具调用之后
 * 可能重新生成正文），界面应丢弃上一轮的临时文本；`text` 是该轮**已累计**的正文，
 * 而不是本次新增的片段，因此客户端漏掉若干事件后仍能凭最新一条自愈。
 * `thinking` 与 `tool` 事件按真实发生顺序穿插推送，界面据此把每次思考与紧接着的
 * 工具调用排成一条时间线，而不是把所有工具调用堆在最终回答下面。
 */
/** 流式工具调用：与落库的摘要同形，但带调用 ID，供界面按发生顺序穿插展示。 */
export interface ConversationStreamTool {
  id: string;
  name: string;
  input: string | null;
  status: TraceStatus;
  durationMs: number | null;
}

export type ConversationStreamContext = { id: string; text: string };

/** 计划任务的调度类型：一次性到点执行后删除，或按 cron 循环。 */
export type ScheduleKind = "once" | "cron";
/** 计划任务状态：启用 / 暂停 / 一次性已完成。 */
export type ScheduledTaskStatus = "active" | "paused" | "done";

/**
 * 定时执行的任务：到点把 prompt 作为一轮普通对话消息交给 ConversationRunner。
 * 任务属于某个用户，执行时用该用户的 OAuth 令牌，绝不回退全局凭据。
 */
export interface ScheduledTask {
  /** 8 字符短 ID，便于在对话里口播与取消。 */
  id: string;
  ownerUserId: string;
  /** 在哪个对话里执行；首版绑定现有对话。 */
  conversationId: string;
  prompt: string;
  kind: ScheduleKind;
  /** 5 段 cron（kind=cron 时非空）；kind=once 时为空。 */
  cron: string;
  /** IANA 时区；首版固定 UTC，字段先预留。 */
  timezone: string;
  /** 一次性任务的触发时间；循环任务用 cron 推导。 */
  runAt: string;
  nextRunAt: string;
  status: ScheduledTaskStatus;
  /** 循环任务的过期时间，到点最后执行一次后删除。 */
  expiresAt: string;
  lastRunAt: string;
  lastStatus: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

/** 一次任务触发的执行记录。 */
/** 计划任务在对话里自定义渲染用的结构化卡片；字段来自服务端落库结果，不由模型生成。 */
export interface ScheduledTaskCardItem {
  id: string;
  prompt: string;
  kind: ScheduledTask["kind"];
  cron: string;
  runAt: string;
  timezone: string;
  nextRunAt: string;
  status: string;
}

export type ScheduledTaskCard =
  | { type: "created"; task: ScheduledTaskCardItem }
  | { type: "list"; tasks: ScheduledTaskCardItem[] }
  | { type: "cancelled"; taskId: string; found: boolean };

export interface ScheduledTaskRun {
  id: number;
  taskId: string;
  startedAt: string;
  finishedAt: string;
  status: string;
  turnId: string;
  error: string;
}

/**
 * 用户上传的文本附件：落盘在 storage/uploads/<conversationId>/ 下，不进入 worktree。
 * 作为仅本轮有效的只读根暴露给模型，用现成 read_file 读取。
 */
export interface ConversationUpload {
  id: string;
  conversationId: string;
  ownerUserId: string;
  /** 原始文件名（仅展示，不参与落盘路径）。 */
  filename: string;
  mime: string;
  sizeBytes: number;
  /** 相对 storage.root 的路径，绝不把用户提供的路径拼进去。 */
  storagePath: string;
  sha256: string;
  createdAt: string;
}

/** 排队等待下一轮执行的补充消息；顺序由 position 决定，不依赖创建时间。 */
export interface ConversationFollowUp {
  id: string;
  conversationId: string;
  content: string;
  position: number;
  createdAt: string;
}

export type ConversationStreamEvent =
  | { type: "text"; reset: boolean; text: string }
  | { type: "thinking"; reset: boolean; text: string }
  | { type: "tool"; tool: ConversationStreamTool }
  /**
   * 命令输出增量：execId 为工具调用 ID；chunk 逐段追加，done 时带终态。
   * 输出在服务端已脱敏并按字节上限截断。
   */
  | {
      type: "exec";
      execId: string;
      stream: "stdout" | "stderr";
      chunk: string;
      done?: boolean;
      exitCode?: number | null;
      aborted?: boolean;
      reason?: string;
      truncated?: boolean;
    }
  | { type: "context"; context: ConversationStreamContext }
  /** 插话状态：queued=已接收，等当前工具轮结束；delivered=已进入模型上下文。 */
  | { type: "interjection"; turnId: string; status: "queued" | "delivered"; text: string }
  /** 计划任务工具的结构化结果，供对话里渲染可跳转的自定义卡片。 */
  | { type: "scheduled_task_card"; card: ScheduledTaskCard }
  /** 排队列表发生变化；只带数量，正文由详情接口按需拉取。 */
  | { type: "queue"; count: number }
  | { type: "done"; status: ConversationTurnStatus; error?: string };

/**
 * 对话详情：在列表摘要与消息之外，附带该对话的系统提示词。
 *
 * 提示词由响应语言与对话模式派生，与执行器真正下发给模型的一致；服务端在详情响应中
 * 现算，因此尚未执行过任何轮次的新对话也能查看。
 */
export interface ConversationDetail extends Conversation {
  systemPrompt: string;
}

/**
 * 单轮对话的完整记录：把一轮助手回复背后的轮次状态、轨迹与执行步骤汇总到一起，
 * 使 Agent 控制台可以直接在对话内查看该轮的轨迹，而无需跳到事件详情页。
 */
export interface ConversationTurn {
  conversationId: string;
  /** 该轮助手回复的消息 ID。 */
  messageId: string;
  /** 该轮的独立记录 ID。 */
  turnId: string;
  status: ConversationTurnStatus;
  /** 该轮用户提问的原文。 */
  request: string;
  headSha: string;
  /** 该轮已被领取执行的次数；由 Server 内联执行时累加。 */
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastError: string;
  /** 该轮落库的过程条目，与对话详情里的过程块同源。 */
  process: ConversationProcessEntry[];
  timeline: ConversationTurnTransition[];
  trajectory: TraceEntry[];
  events: ExecutionStep[];
}

/** Web 端维护的模型供应商：一个 Base URL 与凭据，下面挂多个模型。 */
export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** 仅用于内部连接与保存；接口一律不回显原文。 */
  apiKey: string;
  /** 空字符串代表系统级供应商；否则为所属用户 ID。 */
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** 用户选择的模型；未选择时回退到系统当前模型。 */
export interface UserModelSelection {
  userId: string;
  providerId: string;
  modelId: string;
  updatedAt: string;
}

export interface ModelProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
}

/** 供应商下的一个模型；全局只有一个处于使用中。 */
export interface ProviderModel {
  id: string;
  providerId: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModelInput {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
}

/** 供应商及其模型，供控制台一次读取完整列表。 */
export interface ModelProviderDetails extends ModelProvider {
  models: ProviderModel[];
}

/**
 * 管理员在运维台添加的对话技能：唯一来源是 SKILL.md 文档，
 * 其余字段由 frontmatter 解析后冗余返回，方便列表与补全菜单直接使用。
 */
export interface ConversationSkill {
  id: string;
  /** 完整 SKILL.md（YAML frontmatter + Markdown 正文）。 */
  document: string;
  name: string;
  description: string;
  content: string;
  license: string;
  compatibility: string;
  metadata: Record<string, string>;
  /** 规范实验字段；Corvex 不据此放宽授权，仅作为配置保存。 */
  allowedTools: string;
  /** metadata.corvex-enabled !== "false" */
  enabled: boolean;
  /** metadata.corvex-quick-action === "true" */
  quickAction: boolean;
  /** metadata.corvex-quick-label；缺省时界面回退到 description。 */
  quickLabel: string;
  /** 系统种子技能：可编辑、可停用，但不可删除。 */
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
  /** 来源技能包 ID；手动添加的技能为空。 */
  packId: string;
}

/** 导入的技能包：ZIP 原样存库，技能文档是它的派生视图。 */
export interface SkillPack {
  id: string;
  name: string;
  size: number;
  /** upload / url / github / gitlab */
  source: string;
  /** 原始地址或文件名，便于追溯。 */
  sourceValue: string;
  enabled: boolean;
  skillCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 当前使用的模型及其供应商连接参数。 */
export interface ActiveModel {
  provider: ModelProvider;
  model: ProviderModel;
}

/** 一次 Git 存储清理（CLI、Server 保留任务或启动清扫）的结果记录。 */
export interface StorageCleanupRecord {
  id: number;
  startedAt: string;
  finishedAt: string;
  /** 触发来源：cli / retention / startup。 */
  source: string;
  applied: boolean;
  olderThanDays: number;
  removedWorkspaces: number;
  removedMirrors: number;
  error: string;
}

/** 控制台「仓库信息」用到的只读项目详情，字段来自 GitLab 项目接口。 */
export interface RepositoryDetails {
  id: number;
  name: string | null;
  path_with_namespace: string | null;
  description: string | null;
  default_branch: string | null;
  web_url: string | null;
  http_url_to_repo: string;
}

export interface ConversationPage {
  items: ConversationSummary[];
  total: number;
}

/**
 * 合并轨迹里的一段轮次边界：只保留在一条轨迹中划分轮次所需的字段，
 * 轨迹与执行步骤通过各自的 `turnId` 归属到对应分段。
 */
export interface ConversationTurnSegment {
  turnId: string;
  status: ConversationTurnStatus;
  /** 该轮用户提问原文，作为轨迹中的用户消息。 */
  request: string;
  headSha: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastError: string;
}

/**
 * 整段对话的轨迹：把该对话全部轮次的轨迹与执行步骤合并成一条时间线，
 * 并带上按轮分组的边界，供 Agent 控制台默认在一条轨迹里展示所有轮次。
 */
export interface ConversationTurns {
  conversationId: string;
  /** 合并后的轮次分段，按轮次创建时间升序。 */
  turns: ConversationTurnSegment[];
  /** 全部轮次合并后的轨迹，按开始时间升序。 */
  trajectory: TraceEntry[];
  /** 全部轮次合并后的执行步骤，按开始时间升序。 */
  events: ExecutionStep[];
}

/**
 * 单轮对话的用量与耗时汇总，供对话页「统计」标签展示。
 * 时间与用量来自该轮对话的轨迹记录；缺失字段按未记录处理。
 */
export interface ConversationTurnStats {
  /** 该轮助手回复的消息 ID。 */
  messageId: string;
  turnId: string;
  status: ConversationTurnStatus;
  /** 该轮用户提问原文，用于统计表定位。 */
  request: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  /** 该轮记录的模型调用次数（对话轨迹中 `kind='llm'`）。 */
  modelCalls: number;
  /** 该轮记录的工具调用次数（对话轨迹中 `kind='tool'`）。 */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** 整个对话的用量与耗时汇总，以及逐轮明细。 */
export interface ConversationStats {
  conversationId: string;
  /** 助手回复轮次总数。 */
  turnCount: number;
  /** 各终态轮次数量。 */
  completedTurns: number;
  failedTurns: number;
  /** 仍在排队或执行的轮次数量。 */
  activeTurns: number;
  /** 已完成轮次的耗时之和（毫秒）。 */
  totalDurationMs: number;
  /** 已记录耗时的轮次数量，用于计算平均值。 */
  measuredTurns: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  turns: ConversationTurnStats[];
}

/**
 * 模型生成的标题可能是一段话；按界面语言收敛成一行短标题。
 * 中文最多 20 个字，英文最多 8 个单词。
 */
export function normalizeConversationTitle(raw: string, language: ResponseLanguage): string {
  let title = raw.trim()
    .replace(/^[\s>*#`"'“”‘’]+/, "")
    .split(/\r?\n/, 1)[0]!
    .trim()
    .split(/[。！？!?]/, 1)[0]!
    .replace(/[*`_]/g, "")
    .replace(/[\s`"':：；，,、.]+$/, "")
    .trim();
  if (language === "zh-CN") title = [...title].slice(0, 20).join("");
  else title = title.split(/\s+/).slice(0, 8).join(" ");
  if (!title) title = [...raw.trim()].slice(0, 20).join("");
  return title;
}

export interface CreateConversationInput {
  /** 拥有该会话的本地用户 ID。 */
  ownerUserId: string;
  projectId: number;
  projectName: string;
  targetBranch: string;
  headSha: string;
  actorId: number;
  request: string;
  /** 随本轮传入的上传附件 ID；服务端已校验归属，缺省为空。 */
  uploadIds?: string[];
  /** 对话模式；省略时使用 `defaultConversationMode`。 */
  mode?: ConversationMode;
}

export interface StatusTransition<S extends string = ConversationTurnStatus> {
  from: S;
  to: S;
  at: string;
}

export type ConversationTurnTransition = StatusTransition<ConversationTurnStatus>;

export type TraceKind = "tool" | "llm" | "context";
export type TraceStatus = "running" | "succeeded" | "failed";

export interface TraceEntry {
  id: number;
  /** 该轨迹条目所属的对话轮次 ID。 */
  turnId: string;
  attempt: number;
  round: number | null;
  kind: TraceKind;
  name: string;
  status: TraceStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  requestStartedAt: string | null;
  responseHeadersMs: number | null;
  firstTokenMs: number | null;
  generationDurationMs: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  input: string | null;
  output: string | null;
  schema: string | null;
  rawContent: string | null;
  errorDetail: string | null;
}

/**
 * 执行步骤的持久化状态。`unknown` 表示副作用可能已生效但未收到回执；
 * `interrupted` 表示步骤因轮次中断而未能正常收尾。
 */
export type ExecutionStepStatus = "running" | "succeeded" | "failed" | "ignored" | "unknown" | "interrupted";

/** 单个对话执行步骤的脱敏追踪记录。 */
export interface ExecutionStep {
  id: number;
  /** 该步骤所属的对话轮次 ID。 */
  turnId: string;
  /** 轮次尝试序号。 */
  attempt: number;
  step: string;
  status: ExecutionStepStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** 脱敏且有大小上限的 JSON 文本；超限时会截断。 */
  input: string | null;
  /** 脱敏且有大小上限的 JSON 文本；超限时会截断。 */
  output: string | null;
  errorDetail: string | null;
}

/** 运维概览：按轮次状态汇总当前活动，供 `/api/ops/overview` 使用。 */
export interface OperationsOverview {
  counts: Record<ConversationTurnStatus, number>;
  oldestQueuedAt: string | null;
  conversationCount: number;
}

export interface ModelCallMetric {
  taskType: ModelTaskType;
  outcome: "success" | "failure";
  calls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** 上下文治理计数：按事件类型累计，供概览页观察压缩与裁剪成本。 */
export interface ContextMetric {
  key: "compaction" | "compaction_threshold" | "compaction_overflow" | "microcompact" | "microcompact_chars" | "token_count_real" | "token_count_fallback";
  value: number;
}

export const contextMetricKeys: readonly ContextMetric["key"][] = [
  "compaction",
  "compaction_threshold",
  "compaction_overflow",
  "microcompact",
  "microcompact_chars",
  "token_count_real",
  "token_count_fallback",
];

/** 对话轮次创建后返回给调用方的标识。 */
export interface CreatedConversationTurn {
  conversationId: string;
  turnId: string;
}

/** 对话轮次执行所需的上下文快照；允许的能力由 `mode` 决定。 */
export interface ConversationTurnContext {
  turnId: string;
  conversationId: string;
  projectId: number;
  projectName: string;
  targetBranch: string;
  /** 该对话的模式；执行器据此派生工作流步骤名与允许的工具能力。 */
  mode: ConversationMode;
  headSha: string;
  actorId: number;
  request: string;
  attempt: number;
  /** 该轮之前已完成的历史消息，按时间升序；带消息 ID 以便推进摘要边界。 */
  history: { id: string; role: "user" | "assistant"; content: string; turnId?: string }[];
  /** 该对话已生成的滚动摘要；覆盖 `summary_message_id` 之前的历史。 */
  summary: string | null;
  /** 摘要覆盖到的最后一条消息 ID；为空表示摘要为空。 */
  summaryMessageId: string | null;
}
