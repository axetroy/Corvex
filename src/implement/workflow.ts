import { getPromptTemplates } from "../agent/prompts.js";
import { maxAgentUserPromptBytes, PiAgent, type JobTraceContext, type ModelUsage } from "../agent/pi.js";
import type { ResponseLanguage } from "../config/config.js";
import type { IssueComment } from "../gitlab/client.js";

export interface IssueImplementationContext {
  projectId: number;
  issueIid: number;
  title: string;
  description: string;
  webUrl?: string;
  defaultBranch: string;
  baseSha: string;
  comments: IssueComment[];
  implementationEnabled: boolean;
}

export type ImplementationOutcome =
  | { action: "reply"; reply: string; model: string; usage: ModelUsage }
  | { action: "implement"; summary: string; patch: string; targetBranch?: string; model: string; usage: ModelUsage };

interface ParsedIssueReply {
  action: "reply";
  reply: string;
}

interface ParsedIssueImplementation {
  action: "implement";
  summary: string;
  patch: string;
  targetBranch?: string;
}

type ParsedIssueDecision = ParsedIssueReply | ParsedIssueImplementation;

interface IssueModelOutput {
  action: unknown;
  reply?: unknown;
  summary?: unknown;
  patch?: unknown;
  target_branch?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseImplementationResponse(
  raw: string,
  maxPatchBytes: number,
  request = "",
): ParsedIssueDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`decode implementation JSON: ${String(error)}`, { cause: error });
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => !["action", "reply", "summary", "patch", "target_branch"].includes(key)) ||
    typeof parsed.action !== "string"
  ) {
    throw new Error("model returned invalid Issue decision JSON");
  }
  const result = parsed as unknown as IssueModelOutput;
  if (result.action === "reply") {
    if (typeof result.reply !== "string" || !result.reply.trim() || [...result.reply].length > 4000 ||
      result.summary !== undefined || result.patch !== undefined || result.target_branch !== undefined) {
      throw new Error("model returned an invalid Issue reply");
    }
    return { action: "reply", reply: result.reply.trim() };
  }
  if (
    result.action !== "implement" ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    [...result.summary].length > 4000 ||
    typeof result.patch !== "string" ||
    result.patch.trim().length === 0 ||
    (result.target_branch !== undefined && typeof result.target_branch !== "string")
  ) {
    throw new Error("model returned an invalid Issue implementation");
  }
  if (Buffer.byteLength(result.patch) > maxPatchBytes) throw new Error("implementation patch exceeds its configured size limit");
  const branch = typeof result.target_branch === "string" ? result.target_branch.trim() : "";
  const escapedBranch = branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const explicitlyNamed = branch && new RegExp(`(^|[^A-Za-z0-9_./-])${escapedBranch}(?=$|[^A-Za-z0-9_./-])`).test(request);
  if (branch && (branch.length > 255 || !explicitlyNamed)) {
    throw new Error("model selected a target branch not explicitly named in the current request");
  }
  return {
    action: "implement",
    summary: result.summary.trim(),
    patch: result.patch,
    ...(branch ? { targetBranch: branch } : {}),
  };
}

export class ImplementWorkflow {
  private readonly maxContextBytes: number;

  constructor(
    private readonly agent: PiAgent,
    maxContextBytes: number,
    private readonly maxPatchBytes: number,
    private readonly responseLanguage: ResponseLanguage = "en",
  ) {
    if (maxContextBytes <= 0 || maxContextBytes > 8 << 20) throw new Error("max implementation context must be between 1 byte and 8 MiB");
    if (maxPatchBytes <= 0 || maxPatchBytes > 256 << 10) throw new Error("max implementation patch must be between 1 byte and 256 KiB");
    this.maxContextBytes = Math.min(maxContextBytes, maxAgentUserPromptBytes);
  }

  async implement(
    context: IssueImplementationContext,
    request: string,
    cwd: string,
    signal?: AbortSignal,
    trace?: JobTraceContext,
  ): Promise<ImplementationOutcome> {
    if (context.projectId <= 0 || context.issueIid <= 0 || !context.defaultBranch || !context.baseSha) {
      throw new Error("Issue identity, target branch, and exact base SHA are required");
    }
    const { comments, implementationEnabled, ...issue } = context;
    const userPrompt = JSON.stringify({
      issue,
      current_request: request,
      implementation_enabled: implementationEnabled,
      recent_comments: comments,
    });
    if (Buffer.byteLength(userPrompt) > this.maxContextBytes) throw new Error("Issue implementation context exceeds configured size limit");
    const response = await this.agent.generate(
      {
        taskType: "implement",
        systemPrompt: getPromptTemplates(this.responseLanguage).implementSystem({
          implementationEnabled,
          defaultBranch: context.defaultBranch,
          responseLanguage: this.responseLanguage,
        }),
        userPrompt,
      },
      cwd,
      signal,
      trace,
    );
    return { ...parseImplementationResponse(response.content, this.maxPatchBytes, request), model: response.model, usage: response.usage };
  }
}