import { constants } from "node:fs";
import { isIP } from "node:net";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { ResponseLanguage, ThinkingLevel } from "../model.js";
import { normalizeAllowedOrigin, parseSubmoduleHostTokens } from "../git/submodules.js";

export type { ResponseLanguage };

export interface CorvexConfig {
  server: {
    listen: string;
    readTimeout: number;
    shutdownTimeout: number;
  };
  operations: {
    username: string;
    password: string;
  };
  gitlab: {
    baseUrl: string;
    /** GitLab OAuth Application；留空时登录入口不可用，但站点仍可启动。 */
    oauthClientId: string;
    oauthClientSecret: string;
    oauthRedirectUri: string;
}
  storage: {
    root: string;
    database: string;
    retentionDays: number;
    auditRetentionDays: number;
    /** 对话常驻 worktree 的空闲存活时间（分钟）。 */
    conversationWorkspaceTtlMinutes: number;
    /** 对话常驻 worktree 的数量上限（按最近使用淘汰）。 */
    conversationWorkspaceMax: number;
    /** 单个 worktree 目录的大小上限（MiB）；超限只警告记录，不自动删除。 */
    conversationWorkspaceMaxMb: number;
  };
  agent: {
    responseLanguage: ResponseLanguage;
    baseUrl: string;
    model: string;
    /** 当前模型的供应商展示名；来自控制台模型目录，仅用于展示，不参与连接。 */
    providerName?: string;
    /** 当前激活模型是否支持图片输入；由模型目录同步，决定附件是否走多模态。 */
    visionEnabled: boolean;
    /** 探测或超窗后自动下调模型上下文窗口；关闭后只按人工设置运行。 */
    autoContextTune?: boolean;
    apiKey: string;
    requestTimeout: number;
    sessionTimeout: number;
    /** 等待模型响应期间无任何活动就中止本轮的时长；0 表示关闭。 */
    responseStallTimeout: number;
    maxOutputTokens: number;
    dailyTokenBudget: number;
    webEnabled: boolean;
    webBlockedHosts: string[];
    /** 是否注册 web_search 工具（Tavily 免 key 搜索）。 */
    webSearchEnabled: boolean;
    /** 每个对话轮次最多执行的搜索次数。 */
    webSearchMaxQueries: number;
    /** 免费搜索后端及优先级；按综合健康分排序后依次尝试。 */
    webSearchBackends: string[];
    /** 自托管 SearXNG 根地址；留空则跳过该后端。 */
    searxngBaseUrl: string;
    /** 可选 Tavily API key；设置后改用账号额度，留空走 keyless。 */
    tavilyApiKey: string;
    /** 可选 Exa API key；设置后走 Exa keyed API，留空走 keyless MCP。 */
    exaApiKey: string;
    /** 可选 You.com API key；设置后走 keyed API，留空走 keyless MCP。 */
    youApiKey: string;
    /** 每个对话轮次最多调用的 Git 工具次数；0 表示不限制。 */
    gitToolCallLimit: number;
    /** 首次 publish 到功能分支后是否自动创建（或复用）合并请求。 */
    autoCreateMergeRequest: boolean;
    /** 是否请求模型输出推理过程；不支持推理的模型会忽略或由运行时关闭。 */
    reasoningEnabled: boolean;
    /** 本轮使用的思考等级；用户可在输入框旁覆盖。 */
    thinkingLevel: ThinkingLevel;
    /** 单任务模型调用轮次软上限，达到后要求收尾；0 表示不限制。 */
    taskMaxRounds: number;
    /** 单任务输出 token 软上限，达到后要求收尾；0 表示不限制。 */
    taskMaxOutputTokens: number;
    skillPaths: string[];
    /** 单个上传附件的字节上限；可由运维台覆盖。 */
    uploadMaxBytes: number;
    /** 单条消息最多附带的附件数。 */
    uploadMaxPerMessage: number;
    /** 单个会话累计保留的附件数。 */
    uploadMaxPerConversation: number;
    /** 会话提交正文末尾的 Agent 署名 trailer；空字符串表示不追加。 */
    commitTrailer: string;
    /** 找不到会话拥有者时使用的提交作者名。 */
    fallbackCommitAuthorName: string;
    /** 找不到会话拥有者时使用的提交作者邮箱。 */
    fallbackCommitAuthorEmail: string;
    /** 模型上下文窗口（token）；用于提示词预算与 SDK 压缩阈值。 */
    contextWindow: number;
    /** 单次请求输入 token 上限；0 表示由上下文窗口与输出预留推导。 */
    maxInputTokens: number;
    /** 对话历史注入模型上下文时的 token 预算，超出时按最近优先裁剪。 */
    historyTokenBudget: number;
    /** 单轮内工具结果累计字节的软阈值：达到后提示模型收窄读取，但不中止本轮。 */
    turnToolResultBytes: number;
    /** SDK 压缩预留 token：触发压缩的阈值 = context_window - reserve。 */
    compactionReserveTokens: number;
    /** SDK 压缩后保留的最近 token 数。 */
    compactionKeepRecentTokens: number;
    /** 主动压缩触发点，占上下文窗口的百分比。 */
    compactionTriggerPercent?: number;
    /** 是否按每轮 token 增长动态调整主动压缩阈值。 */
    compactionDynamicThreshold: boolean;
    /** 是否启用跨轮滚动摘要，把被裁剪的历史压缩成持久化摘要。 */
    summaryEnabled: boolean;
    /** 是否在回复末尾附带下一步建议块，并在界面渲染可点击 chip。 */
    followupsEnabled: boolean;
    /** 每次回复附带的最大建议条数（1-5）。 */
    followupsCount: number;
    /** 是否把仓库根目录的 AGENTS.md 作为本轮项目指导注入。 */
    projectAgentsMd: boolean;
    /** 项目指导的最大字节数；超限截断。 */
    projectAgentsMdMaxBytes: number;
    /** 是否在每次模型请求前采集上下文快照；关闭后不增加请求延迟。 */
    contextInspectEnabled: boolean;
    /** 单次快照保留的最大条目数；超出时保留最近的条目。 */
    contextInspectMaxItems: number;
    /** 单条预览的最大字符数。 */
    contextInspectMaxPreviewChars: number;
    /** 允许拉取子模块的额外 origin；空表示只允许配置 GitLab 同源。 */
    submoduleAllowedHosts?: string[];
    /** 第三方 origin 的专用只读 token（JSON 对象），绝不回显到界面。 */
    submoduleHostTokens?: string;
  };
  execution: ExecutionConfig;
}

/**
 * 执行环境配置（自由命令 + 双后端）。安全边界配置，只放 YAML / 环境变量，
 * 不进运维台运行时设置，改后需重启。详见 execution-design.md。
 */
export interface ExecutionConfig {
  enabled: boolean;
  backend: "local" | "sandbox";
  sandbox: {
    runtime: "docker" | "podman";
    image: string;
    socket: string;
    memory: string;
    cpus: number;
    pidsLimit: number;
    /** 容器内 /tmp 与缓存目录的 tmpfs 大小（MiB）；与输出上限无关，避免包管理器 ENOSPC。 */
    tmpfsSizeMb: number;
    /** Docker json-file 日志单文件上限（MiB）；防止命令巨量输出撑爆宿主日志文件。 */
    logMaxSizeMb: number;
    /** Docker json-file 日志保留文件个数。 */
    logMaxFile: number;
    network: "none" | "bridge";
    readOnlyMounts: string[];
    timeoutMs: number;
    maxOutputBytes: number;
  };
  local: {
    allowUnsafe: boolean;
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

export type ConfigRole = "server" | "storage";

type JsonObject = Record<string, unknown>;

const defaults: CorvexConfig = {
  server: { listen: "0.0.0.0:8080", readTimeout: 5_000, shutdownTimeout: 30_000 },
  operations: { username: "", password: "" },
  gitlab: {
    baseUrl: "",
    oauthClientId: "",
    oauthClientSecret: "",
    oauthRedirectUri: "",
  },
  storage: { root: "", database: "", retentionDays: 90, auditRetentionDays: 365, conversationWorkspaceTtlMinutes: 60, conversationWorkspaceMax: 8, conversationWorkspaceMaxMb: 2048 },
  agent: {
    responseLanguage: "en",
    baseUrl: "https://api.openai.com/v1",
    model: "",
    visionEnabled: false,
    autoContextTune: true,
    apiKey: "",
    requestTimeout: 120_000,
    sessionTimeout: 30 * 60_000,
    responseStallTimeout: 3 * 60_000,
    maxOutputTokens: 4096,
    dailyTokenBudget: 0,
    webEnabled: true,
    webBlockedHosts: [],
    webSearchEnabled: true,
    webSearchMaxQueries: 5,
    webSearchBackends: ["tavily", "exa", "you", "wikipedia", "hackernews", "duckduckgo", "searxng"],
    searxngBaseUrl: "",
    tavilyApiKey: "",
    exaApiKey: "",
    youApiKey: "",
    gitToolCallLimit: 40,
    autoCreateMergeRequest: true,
    reasoningEnabled: true,
    thinkingLevel: "medium",
    taskMaxRounds: 0,
    taskMaxOutputTokens: 0,
    skillPaths: [],
    uploadMaxBytes: 256 << 10,
    uploadMaxPerMessage: 10,
    uploadMaxPerConversation: 100,
    commitTrailer: "Assisted-by: AI Agent",
    fallbackCommitAuthorName: "Corvex",
    fallbackCommitAuthorEmail: "no.reply@corvex-agent.com",
    contextWindow: 131_072,
    maxInputTokens: 0,
    historyTokenBudget: 24_000,
    turnToolResultBytes: 256 << 10,
    // 0 表示完全由窗口与工具预算推导；固定 16K 会让 32K 窗口在 50% 就压缩。
    compactionReserveTokens: 0,
    compactionKeepRecentTokens: 20_000,
    compactionTriggerPercent: 85,
    compactionDynamicThreshold: true,
    summaryEnabled: true,
    followupsEnabled: true,
    followupsCount: 3,
    projectAgentsMd: true,
    projectAgentsMdMaxBytes: 32 << 10,
    contextInspectEnabled: true,
    contextInspectMaxItems: 80,
    contextInspectMaxPreviewChars: 2_048,
    submoduleAllowedHosts: [],
    submoduleHostTokens: "",
  },
  execution: {
    enabled: false,
    backend: "sandbox",
    sandbox: {
      runtime: "docker",
      image: "",
      socket: "",
      memory: "2g",
      cpus: 1,
      pidsLimit: 256,
      // 2 GiB：常见前端仓库全量 yarn/npm 安装的缓存与解压需要数 GiB，512 MiB 会 ENOSPC。
      tmpfsSizeMb: 2048,
      logMaxSizeMb: 4,
      logMaxFile: 2,
      // 默认 bridge：允许联网（装依赖等），但容器网络命名空间与宿主隔离。
      network: "bridge",
      readOnlyMounts: [],
      // 10 分钟：全量依赖安装 / 大型构建常超过 2 分钟，避免频繁 timeout。
      timeoutMs: 600_000,
      maxOutputBytes: 256 << 10,
    },
    local: {
      allowUnsafe: false,
      timeoutMs: 600_000,
      maxOutputBytes: 256 << 10,
    },
  },
};

function object(value: unknown, label: string): JsonObject {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as JsonObject;
}

function string(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("configuration value must be a string");
  return value;
}

function responseLanguage(value: unknown, fallback: ResponseLanguage): ResponseLanguage {
  const language = string(value, fallback);
  if (language !== "en" && language !== "zh-CN") {
    throw new Error('agent.response_language must be "en" or "zh-CN"');
  }
  return language;
}

function number(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("configuration value must be a finite number");
  }
  return value;
}

function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("configuration value must be a boolean");
  return value;
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)
  ) {
    return value as ThinkingLevel;
  }
  throw new Error("configuration value must be a valid thinking level");
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("configuration value must be an array of strings");
  }
  return value;
}

function duration(value: unknown, fallback: number, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${label} must be a duration string`);
  const match = /^([0-9]+(?:\.[0-9]+)?)(ns|us|µs|ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`invalid duration "${value}" for ${label}`);
  const amount = Number(match[1]);
  const multipliers: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    "µs": 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  return amount * multipliers[match[2]!];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${label} must be one of ${allowed.join(", ")}`);
}

function parseExecution(raw: unknown): ExecutionConfig {
  const execution = object(raw, "execution");
  const sandbox = object(execution.sandbox, "execution.sandbox");
  const local = object(execution.local, "execution.local");
  return {
    enabled: boolean(
      process.env.CORVEX_EXECUTION_ENABLED === undefined
        ? execution.enabled
        : process.env.CORVEX_EXECUTION_ENABLED === "true",
      defaults.execution.enabled,
    ),
    backend: enumValue(
      process.env.CORVEX_EXECUTION_BACKEND ?? execution.backend,
      ["local", "sandbox"] as const,
      defaults.execution.backend,
      "execution.backend",
    ),
    sandbox: {
      runtime: enumValue(sandbox.runtime, ["docker", "podman"] as const, defaults.execution.sandbox.runtime, "execution.sandbox.runtime"),
      image: string(
        process.env.CORVEX_EXECUTION_SANDBOX_IMAGE ?? sandbox.image,
        defaults.execution.sandbox.image,
      ),
      socket: string(
        process.env.CORVEX_EXECUTION_SANDBOX_SOCKET ?? sandbox.socket,
        defaults.execution.sandbox.socket,
      ),
      memory: string(sandbox.memory, defaults.execution.sandbox.memory),
      cpus: number(sandbox.cpus, defaults.execution.sandbox.cpus),
      pidsLimit: number(sandbox.pids_limit, defaults.execution.sandbox.pidsLimit),
      tmpfsSizeMb: number(
        process.env.CORVEX_EXECUTION_SANDBOX_TMPFS_SIZE_MB ?? sandbox.tmpfs_size_mb,
        defaults.execution.sandbox.tmpfsSizeMb,
      ),
      logMaxSizeMb: number(
        process.env.CORVEX_EXECUTION_SANDBOX_LOG_MAX_SIZE_MB ?? sandbox.log_max_size_mb,
        defaults.execution.sandbox.logMaxSizeMb,
      ),
      logMaxFile: number(sandbox.log_max_file, defaults.execution.sandbox.logMaxFile),
      network: enumValue(sandbox.network, ["none", "bridge"] as const, defaults.execution.sandbox.network, "execution.sandbox.network"),
      readOnlyMounts: stringArray(sandbox.read_only_mounts, defaults.execution.sandbox.readOnlyMounts),
      timeoutMs: duration(sandbox.timeout, defaults.execution.sandbox.timeoutMs, "execution.sandbox.timeout"),
      maxOutputBytes: number(sandbox.max_output_bytes, defaults.execution.sandbox.maxOutputBytes),
    },
    local: {
      allowUnsafe: boolean(local.allow_unsafe, defaults.execution.local.allowUnsafe),
      timeoutMs: duration(local.timeout, defaults.execution.local.timeoutMs, "execution.local.timeout"),
      maxOutputBytes: number(local.max_output_bytes, defaults.execution.local.maxOutputBytes),
    },
  };
}

function parseConfig(raw: unknown): CorvexConfig {
  const root = object(raw, "configuration");
  const server = object(root.server, "server");
  const gitlab = object(root.gitlab, "gitlab");
  const storage = object(root.storage, "storage");
  const agent = object(root.agent, "agent");
  return {
    server: {
      listen: process.env.CORVEX_LISTEN ?? string(server.listen, defaults.server.listen),
      readTimeout: duration(server.read_timeout, defaults.server.readTimeout, "server.read_timeout"),
      shutdownTimeout: duration(
        server.shutdown_timeout,
        defaults.server.shutdownTimeout,
        "server.shutdown_timeout",
      ),
    },
    // 控制台凭据由运维台设置写入 SQLite；启动时默认无凭据，即不启用认证。
    operations: { username: "", password: "" },
    gitlab: {
      baseUrl:
        process.env.CORVEX_GITLAB_BASE_URL ?? string(gitlab.base_url, defaults.gitlab.baseUrl),
      // GitLab 访问只使用当前登录用户的 OAuth token，不再读取运维台/环境变量中的 PAT。
      oauthClientId: "",
      oauthClientSecret: "",
      oauthRedirectUri: "",
    },
    storage: {
      root: process.env.CORVEX_STORAGE_ROOT ?? string(storage.root, defaults.storage.root),
      database:
        process.env.CORVEX_DATABASE ?? string(storage.database, defaults.storage.database),
      retentionDays: number(storage.retention_days, defaults.storage.retentionDays),
      auditRetentionDays: number(
        storage.audit_retention_days,
        defaults.storage.auditRetentionDays,
      ),
      conversationWorkspaceTtlMinutes: number(
        storage.conversation_workspace_ttl_minutes,
        defaults.storage.conversationWorkspaceTtlMinutes,
      ),
      conversationWorkspaceMax: number(
        storage.conversation_workspace_max,
        defaults.storage.conversationWorkspaceMax,
      ),
      conversationWorkspaceMaxMb: number(
        storage.conversation_workspace_max_mb,
        defaults.storage.conversationWorkspaceMaxMb,
      ),
    },
    agent: {
      responseLanguage: responseLanguage(agent.response_language, defaults.agent.responseLanguage),
      baseUrl:
        process.env.CORVEX_MODEL_BASE_URL ?? string(agent.base_url, defaults.agent.baseUrl),
      model: process.env.CORVEX_MODEL_NAME ?? string(agent.model, defaults.agent.model),
      // 视觉能力来自模型目录，不由 YAML 提供；启动时由 applyActiveModel 同步。
      visionEnabled: false,
      autoContextTune: boolean(agent.auto_context_tune, defaults.agent.autoContextTune ?? true),
      apiKey: "",
      requestTimeout: duration(
        agent.request_timeout,
        defaults.agent.requestTimeout,
        "agent.request_timeout",
      ),
      sessionTimeout: duration(
        agent.session_timeout,
        defaults.agent.sessionTimeout,
        "agent.session_timeout",
      ),
      responseStallTimeout: duration(
        agent.response_stall_timeout,
        defaults.agent.responseStallTimeout,
        "agent.response_stall_timeout",
      ),
      maxOutputTokens: number(agent.max_output_tokens, defaults.agent.maxOutputTokens),
      dailyTokenBudget: number(agent.daily_token_budget, defaults.agent.dailyTokenBudget),
      webEnabled: boolean(agent.web_enabled, defaults.agent.webEnabled),
      webBlockedHosts: stringArray(agent.web_blocked_hosts, defaults.agent.webBlockedHosts),
      webSearchEnabled: boolean(agent.web_search_enabled, defaults.agent.webSearchEnabled),
      webSearchMaxQueries: number(agent.web_search_max_queries, defaults.agent.webSearchMaxQueries),
      webSearchBackends: stringArray(agent.web_search_backends, defaults.agent.webSearchBackends),
      searxngBaseUrl: string(agent.searxng_base_url, defaults.agent.searxngBaseUrl),
      tavilyApiKey: string(agent.tavily_api_key, defaults.agent.tavilyApiKey),
      exaApiKey: string(agent.exa_api_key, defaults.agent.exaApiKey),
      youApiKey: string(agent.you_api_key, defaults.agent.youApiKey),
      gitToolCallLimit: number(agent.git_tool_call_limit, defaults.agent.gitToolCallLimit),
      autoCreateMergeRequest: boolean(agent.auto_create_merge_request, defaults.agent.autoCreateMergeRequest),
      thinkingLevel: parseThinkingLevel(agent.thinking_level) ?? defaults.agent.thinkingLevel,
      taskMaxRounds: number(agent.task_max_rounds, defaults.agent.taskMaxRounds),
      taskMaxOutputTokens: number(agent.task_max_output_tokens, defaults.agent.taskMaxOutputTokens),
      reasoningEnabled: boolean(agent.reasoning_enabled, defaults.agent.reasoningEnabled),
      skillPaths: stringArray(agent.skill_paths, defaults.agent.skillPaths),
      uploadMaxBytes: number(agent.upload_max_bytes, defaults.agent.uploadMaxBytes),
      uploadMaxPerMessage: number(agent.upload_max_per_message, defaults.agent.uploadMaxPerMessage),
      uploadMaxPerConversation: number(agent.upload_max_per_conversation, defaults.agent.uploadMaxPerConversation),
      commitTrailer: string(agent.commit_trailer, defaults.agent.commitTrailer),
      fallbackCommitAuthorName: string(agent.fallback_commit_author_name, defaults.agent.fallbackCommitAuthorName),
      fallbackCommitAuthorEmail: string(agent.fallback_commit_author_email, defaults.agent.fallbackCommitAuthorEmail),
      contextWindow: number(agent.context_window, defaults.agent.contextWindow),
      maxInputTokens: number(agent.max_input_tokens, defaults.agent.maxInputTokens),
      historyTokenBudget: number(agent.history_token_budget, defaults.agent.historyTokenBudget),
      turnToolResultBytes: number(agent.turn_tool_result_bytes, defaults.agent.turnToolResultBytes),
      compactionReserveTokens: number(agent.compaction_reserve_tokens, defaults.agent.compactionReserveTokens),
      compactionKeepRecentTokens: number(agent.compaction_keep_recent_tokens, defaults.agent.compactionKeepRecentTokens),
      compactionTriggerPercent: number(agent.compaction_trigger_percent, defaults.agent.compactionTriggerPercent ?? 85),
      compactionDynamicThreshold: boolean(agent.compaction_dynamic_threshold, defaults.agent.compactionDynamicThreshold),
      summaryEnabled: boolean(agent.summary_enabled, defaults.agent.summaryEnabled),
      followupsEnabled: boolean(agent.followups_enabled, defaults.agent.followupsEnabled),
      followupsCount: number(agent.followups_count, defaults.agent.followupsCount),
      projectAgentsMd: boolean(agent.project_agents_md, defaults.agent.projectAgentsMd),
      projectAgentsMdMaxBytes: number(agent.project_agents_md_max_bytes, defaults.agent.projectAgentsMdMaxBytes),
      contextInspectEnabled: boolean(agent.context_inspect_enabled, defaults.agent.contextInspectEnabled),
      contextInspectMaxItems: number(agent.context_inspect_max_items, defaults.agent.contextInspectMaxItems),
      contextInspectMaxPreviewChars: number(agent.context_inspect_max_preview_chars, defaults.agent.contextInspectMaxPreviewChars),
      submoduleAllowedHosts: stringArray(agent.submodule_allowed_hosts, defaults.agent.submoduleAllowedHosts ?? []),
      submoduleHostTokens: typeof agent.submodule_host_tokens === "string"
        ? agent.submodule_host_tokens
        : defaults.agent.submoduleHostTokens,
    },
    execution: parseExecution(root.execution),
  };
}

function validHttpUrl(value: string, allowCredentials = false): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname !== "" &&
      (allowCredentials || (!url.username && !url.password && !url.search && !url.hash))
    );
  } catch {
    return false;
  }
}

function validBlockedWebHost(value: string): boolean {
  if (!value || value !== value.trim() || value.includes("*") || value.includes(":") || isIP(value) !== 0) {
    return false;
  }
  try {
    const url = new URL(`https://${value}`);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return (
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      hostname.split(".").length >= 2 &&
      hostname.length <= 253 &&
      hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    );
  } catch {
    return false;
  }
}

export function validateConfig(config: CorvexConfig, role?: ConfigRole): void {
  const problems: string[] = [];
  if (!config.server.listen.trim()) problems.push("server.listen is required");
  if (config.server.readTimeout <= 0 || config.server.shutdownTimeout <= 0) {
    problems.push("server timeouts must be positive");
  }
  // 凭据可以在运维台设置；两者必须同时设置或同时留空。
  const operationsUsername = config.operations.username.trim();
  const operationsPassword = config.operations.password;
  if (Boolean(operationsUsername) !== Boolean(operationsPassword)) {
    problems.push("both operations username and password must be set together");
  }
  if (operationsUsername || operationsPassword) {
    const operationsCredentials = operationsUsername + operationsPassword;
    const hasControlCharacters = [...operationsCredentials].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (operationsUsername.includes(":") || hasControlCharacters) {
      problems.push("operations console credentials contain invalid characters");
    }
  }
  // GitLab 地址可以通过运维台设置写入 SQLite，因此配置文件/环境变量里可以为空；
  // 一旦填写就必须合法，避免把明显错误的地址带进运行时。
  if (config.gitlab.baseUrl && !validHttpUrl(config.gitlab.baseUrl)) {
    problems.push("gitlab.base_url must be a valid HTTP(S) URL");
  }
  if (config.gitlab.oauthRedirectUri && !validHttpUrl(config.gitlab.oauthRedirectUri)) {
    problems.push("gitlab.oauth_redirect_uri must be a valid HTTP(S) URL");
  }
  if (
    Boolean(config.gitlab.oauthClientId) !== Boolean(config.gitlab.oauthClientSecret) ||
    Boolean(config.gitlab.oauthClientId) !== Boolean(config.gitlab.oauthRedirectUri)
  ) {
    problems.push("GitLab OAuth requires client ID, client secret and redirect URI together");
  }
  // GitLab 令牌可以在运维台设置写入 SQLite，启动时不要求环境变量或配置文件提供；
  // 未配置时 API 调用会明确报错。
  if (!config.storage.root.trim()) problems.push("storage.root is required");
  if (!config.storage.database.trim()) problems.push("storage.database is required");
  if (config.storage.retentionDays < 1 || config.storage.retentionDays > 36_500) {
    problems.push("storage.retention_days must be between 1 and 36500");
  }
  if (config.storage.auditRetentionDays < 1 || config.storage.auditRetentionDays > 36_500) {
    problems.push("storage.audit_retention_days must be between 1 and 36500");
  }
  if (config.storage.conversationWorkspaceTtlMinutes < 1 || config.storage.conversationWorkspaceTtlMinutes > 14_400) {
    problems.push("storage.conversation_workspace_ttl_minutes must be between 1 and 14400");
  }
  if (config.storage.conversationWorkspaceMax < 1 || config.storage.conversationWorkspaceMax > 200) {
    problems.push("storage.conversation_workspace_max must be between 1 and 200");
  }
  if (config.storage.conversationWorkspaceMaxMb < 64 || config.storage.conversationWorkspaceMaxMb > 20_480) {
    problems.push("storage.conversation_workspace_max_mb must be between 64 and 20480");
  }
  if (config.agent.webBlockedHosts.length > 100) {
    problems.push("agent.web_blocked_hosts must contain no more than 100 hostnames");
  }
  if (config.agent.webBlockedHosts.some((host) => !validBlockedWebHost(host))) {
    problems.push("agent.web_blocked_hosts must contain DNS hostnames without wildcards, ports, or paths");
  }
  const allowedSubmoduleHosts = config.agent.submoduleAllowedHosts ?? [];
  if (allowedSubmoduleHosts.length > 50 ||
      allowedSubmoduleHosts.some((host) => !normalizeAllowedOrigin(host))) {
    problems.push("agent.submodule_allowed_hosts must contain at most 50 valid host[:port] or http(s) origins");
  }
  try {
    parseSubmoduleHostTokens(config.agent.submoduleHostTokens ?? "");
  } catch (error) {
    problems.push(`agent.submodule_host_tokens: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.agent.webSearchMaxQueries < 1 || config.agent.webSearchMaxQueries > 50) {
    problems.push("agent.web_search_max_queries must be between 1 and 50");
  }
  if (config.agent.gitToolCallLimit < 0 || config.agent.gitToolCallLimit > 200) {
    problems.push("agent.git_tool_call_limit must be between 0 and 200");
  }
  // 执行环境：安全边界配置，fail-closed。开发模式由环境变量显式声明。
  const execution = config.execution;
  const devMode = process.env.CORVEX_DEV === "1" || process.env.NODE_ENV === "development";
  if (execution?.enabled) {
    if (execution.backend === "local" && !devMode) {
      problems.push("execution.backend=local is only allowed in development (set CORVEX_DEV=1); use sandbox in production");
    }
    if (execution.backend === "local" && !execution.local.allowUnsafe) {
      problems.push("execution.local.allow_unsafe must be true to enable the local backend");
    }
    if (execution.backend === "sandbox") {
      if (!execution.sandbox.image.trim()) problems.push("execution.sandbox.image is required when backend=sandbox");
      if (!execution.sandbox.socket.trim()) problems.push("execution.sandbox.socket is required when backend=sandbox");
      if (execution.sandbox.cpus <= 0) problems.push("execution.sandbox.cpus must be positive");
      if (execution.sandbox.pidsLimit < 1) problems.push("execution.sandbox.pids_limit must be at least 1");
      if (execution.sandbox.tmpfsSizeMb < 16 || execution.sandbox.tmpfsSizeMb > 4096) {
        problems.push("execution.sandbox.tmpfs_size_mb must be between 16 and 4096");
      }
      if (execution.sandbox.logMaxSizeMb < 1 || execution.sandbox.logMaxSizeMb > 1024) {
        problems.push("execution.sandbox.log_max_size_mb must be between 1 and 1024");
      }
      if (!Number.isInteger(execution.sandbox.logMaxFile) || execution.sandbox.logMaxFile < 1 || execution.sandbox.logMaxFile > 100) {
        problems.push("execution.sandbox.log_max_file must be an integer between 1 and 100");
      }
    }
    const limits = execution.backend === "sandbox" ? execution.sandbox : execution.local;
    if (limits.timeoutMs < 1 || limits.timeoutMs > 3_600_000) {
      problems.push(`execution.${execution.backend}.timeout must be between 1ms and 1h`);
    }
    if (limits.maxOutputBytes < 1 || limits.maxOutputBytes > 64 << 20) {
      problems.push(`execution.${execution.backend}.max_output_bytes must be between 1 and 64 MiB`);
    }
  }
  if (role !== "storage") {
    // 模型名、Base URL 与 API Key 可以在运维台运行时配置（或由环境变量提供），
    // 因此配置文件不再强制要求它们；但一旦配置就必须合法。
    if (config.agent.baseUrl && !validHttpUrl(config.agent.baseUrl)) {
      problems.push("agent.base_url must be a valid HTTP(S) URL without credentials");
    }
    if (config.agent.requestTimeout <= 0) problems.push("agent.request_timeout must be positive");
    if (config.agent.sessionTimeout <= 0) problems.push("agent.session_timeout must be positive");
    // 输出上限没有固定天花板；只要求为正且小于上下文窗口，否则输入预算会被挤空。
    if (config.agent.maxOutputTokens <= 0 || config.agent.maxOutputTokens >= config.agent.contextWindow) {
      problems.push("agent.max_output_tokens must be positive and less than context_window");
    }
    if (config.agent.taskMaxRounds < 0 || config.agent.taskMaxRounds > 10_000) {
      problems.push("agent.task_max_rounds must be between 0 and 10000");
    }
    if (config.agent.taskMaxOutputTokens < 0) problems.push("agent.task_max_output_tokens must not be negative");
    if (config.agent.dailyTokenBudget < 0 || config.agent.dailyTokenBudget > 1_000_000_000) {
      problems.push("agent.daily_token_budget must be between 0 and 1000000000");
    }
    if (config.agent.followupsCount < 1 || config.agent.followupsCount > 5) {
      problems.push("agent.followups_count must be between 1 and 5");
    }
    if (config.agent.contextWindow < 1_024 || config.agent.contextWindow > 10_000_000) {
      problems.push("agent.context_window must be between 1024 and 10000000");
    }
    if (config.agent.maxInputTokens < 0 || config.agent.maxInputTokens >= config.agent.contextWindow) {
      problems.push("agent.max_input_tokens must be 0 or less than agent.context_window");
    }
    if (config.agent.historyTokenBudget < 0 || config.agent.historyTokenBudget > config.agent.contextWindow) {
      problems.push("agent.history_token_budget must be between 0 and agent.context_window");
    }
    if (config.agent.turnToolResultBytes < 0 || config.agent.turnToolResultBytes > 64 << 20) {
      problems.push("agent.turn_tool_result_bytes must be between 0 and 64 MiB");
    }
    if (
      config.agent.compactionReserveTokens < 0 ||
      config.agent.compactionReserveTokens >= config.agent.contextWindow
    ) {
      problems.push("agent.compaction_reserve_tokens must be 0 or less than agent.context_window");
    }
    if (
      config.agent.compactionKeepRecentTokens < 0 ||
      config.agent.compactionKeepRecentTokens > config.agent.contextWindow
    ) {
      problems.push("agent.compaction_keep_recent_tokens must be between 0 and agent.context_window");
    }
    if (config.agent.contextInspectMaxItems < 1 || config.agent.contextInspectMaxItems > 500) {
      problems.push("agent.context_inspect_max_items must be between 1 and 500");
    }
    if (config.agent.contextInspectMaxPreviewChars < 128 || config.agent.contextInspectMaxPreviewChars > 16_384) {
      problems.push("agent.context_inspect_max_preview_chars must be between 128 and 16384");
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
}

export async function loadConfig(path: string, role?: ConfigRole): Promise<CorvexConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`read config "${path}": ${String(error)}`, { cause: error });
  }
  let config: CorvexConfig;
  try {
    config = parseConfig(parse(contents));
  } catch (error) {
    throw new Error(`parse config "${path}": ${String(error)}`, { cause: error });
  }
  validateConfig(config, role);
  await mkdir(dirname(config.storage.database), { recursive: true });
  await mkdir(join(config.storage.root, "mirrors"), { recursive: true });
  await mkdir(join(config.storage.root, "workspaces"), { recursive: true });
  return config;
}

/**
 * 读取配置文件但不做角色校验，用于Agent 控制台在运行时重新加载设置。
 * 调用方负责在应用前校验；解析失败时抛出错误，调用方保留旧配置。
 */
export async function reloadConfig(path: string): Promise<CorvexConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`read config "${path}": ${String(error)}`, { cause: error });
  }
  try {
    return parseConfig(parse(contents));
  } catch (error) {
    throw new Error(`parse config "${path}": ${String(error)}`, { cause: error });
  }
}

export async function initializeConfig(path: string): Promise<void> {
  if (!path.trim()) throw new Error("config path is required");
  const template = fileURLToPath(new URL("../../configs/config.example.yaml", import.meta.url));
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await copyFile(template, output, constants.COPYFILE_EXCL);
}
