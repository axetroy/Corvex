import { getPromptTemplates } from "../agent/prompts.js";
import { PiAgent, type JobTraceContext, type ModelUsage } from "../agent/pi.js";
import type { ResponseLanguage } from "../config/config.js";
import type { DiffResult } from "../git/types.js";
import type { ReviewContext } from "../review/workflow.js";

export interface FixOutcome {
  summary: string;
  patch: string;
  model: string;
  usage: ModelUsage;
}

interface FixModelResult {
  summary: string;
  patch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseFixResponse(raw: string, maxPatchBytes: number): FixModelResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`decode fix JSON: ${String(error)}`, { cause: error });
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "summary" && key !== "patch") ||
    typeof parsed.summary !== "string" ||
    typeof parsed.patch !== "string"
  ) {
    throw new Error("model returned invalid fix JSON");
  }
  const summary = parsed.summary.trim();
  if (!summary || summary.length > 4000) {
    throw new Error("fix summary is empty or too long");
  }
  if (Buffer.byteLength(parsed.patch) > maxPatchBytes) {
    throw new Error("fix patch exceeds its configured size limit");
  }
  return { summary, patch: parsed.patch.trim() ? parsed.patch : "" };
}

export class FixWorkflow {
  constructor(
    private readonly agent: PiAgent,
    private readonly maxContextBytes: number,
    private readonly maxPatchBytes: number,
    private readonly responseLanguage: ResponseLanguage = "en",
  ) {
    if (maxContextBytes <= 0 || maxContextBytes > 8 << 20) {
      throw new Error("max fix context must be between 1 byte and 8 MiB");
    }
    if (maxPatchBytes <= 0 || maxPatchBytes > 256 << 10) {
      throw new Error("max fix patch must be between 1 byte and 256 KiB");
    }
  }

  async fix(
    context: ReviewContext,
    request: string,
    diff: DiffResult,
    cwd: string,
    signal?: AbortSignal,
    trace?: JobTraceContext,
  ): Promise<FixOutcome> {
    if (
      context.projectId <= 0 ||
      context.mrIid <= 0 ||
      !context.baseSha ||
      !context.headSha
    ) {
      throw new Error("merge request identity and exact base/head SHAs are required");
    }
    if (diff.baseSha !== context.baseSha || diff.headSha !== context.headSha) {
      throw new Error("diff commit range does not match the merge request snapshot");
    }
    const changes = diff.changes.filter((change) => !change.skipped && change.patch);
    if (changes.length === 0) {
      return {
        summary: "No safe patch could be proposed because there are no reviewable text changes.",
        patch: "",
        model: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    }
    const userPrompt = JSON.stringify({
      merge_request: context,
      ...(request ? { request } : {}),
      changes,
    });
    if (Buffer.byteLength(userPrompt) > this.maxContextBytes) {
      throw new Error("fix context exceeds configured size limit");
    }
    const response = await this.agent.generate(
      { systemPrompt: getPromptTemplates(this.responseLanguage).fixSystem, userPrompt },
      cwd,
      signal,
      trace,
    );
    const result = parseFixResponse(response.content, this.maxPatchBytes);
    return {
      ...result,
      model: response.model,
      usage: response.usage,
    };
  }
}
