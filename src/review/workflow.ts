import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getPromptTemplates } from "../agent/prompts.js";
import { PiAgent, type JobTraceContext, type ModelRequest, type ModelUsage } from "../agent/pi.js";
import type { ResponseLanguage } from "../config/config.js";
import type { Change, DiffResult } from "../git/types.js";
import type { JobTraceEntry } from "../jobs/model.js";

export interface ReviewContext {
  projectId: number;
  mrIid: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  baseSha: string;
  headSha: string;
}

export interface Finding {
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  filePath: string;
  line: number;
  evidence: string;
  explanation: string;
  suggestion?: string;
  fingerprint: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

export interface ReviewOutcome {
  result: ReviewResult;
  model: string;
  usage: ModelUsage;
  omittedFiles: number;
  rejected: number;
}

export interface Explanation {
  text: string;
  model: string;
  usage: ModelUsage;
}

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

class ReviewJsonDecodeError extends Error {
  constructor(cause: unknown) {
    super(`decode review JSON: ${String(cause)}`, { cause });
  }
}

class ReviewJsonValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, min: number, max: number): value is string {
  return (
    typeof value === "string" &&
    Buffer.from(value).toString("utf8") === value &&
    value.trim().length >= min &&
    value.trim().length <= max
  );
}

function changedFileIsFullyRead(path: string, cwd: string, traces: JobTraceEntry[]): boolean {
  const expectedPath = resolve(cwd, path);
  const ranges: { start: number; end: number; hasMore: boolean }[] = [];

  for (const trace of traces) {
    if (trace.kind !== "tool" || trace.name !== "read_file" || trace.status !== "succeeded" || !trace.input) {
      continue;
    }
    let args: unknown;
    let output: unknown;
    try {
      args = JSON.parse(trace.input);
      output = trace.output ? JSON.parse(trace.output) : undefined;
    } catch {
      continue;
    }
    if (!isRecord(args) || typeof args.path !== "string" || resolve(cwd, args.path) !== expectedPath) continue;
    const ranged = args.startLine !== undefined || args.maxLines !== undefined;
    if (!ranged) return true;
    if (args.startLine !== undefined && (!Number.isSafeInteger(args.startLine) || Number(args.startLine) <= 0)) {
      continue;
    }
    if (args.maxLines !== undefined && (!Number.isSafeInteger(args.maxLines) || Number(args.maxLines) <= 0)) {
      continue;
    }
    const expectedStart = args.startLine ?? 1;
    if (!isRecord(output) || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") continue;
      const header = /^\[Lines (\d+)-(\d+)(?:; more lines available from (\d+))?\]\r?\n/.exec(content.text);
      if (!header || Number(header[1]) !== expectedStart) continue;
      ranges.push({
        start: Number(header[1]),
        end: Number(header[2]),
        hasMore: header[3] !== undefined,
      });
    }
  }

  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  let nextLine = 1;
  for (const range of ranges) {
    if (range.start > nextLine) return false;
    if (range.end < nextLine) continue;
    nextLine = range.end + 1;
    if (!range.hasMore) return true;
  }
  return false;
}

function incompleteChangedFiles(changes: Change[], cwd: string, traces: JobTraceEntry[]): string[] {
  return changes
    .filter((change) => !changedFileIsFullyRead(change.path, cwd, traces))
    .map((change) => change.path);
}

// 仅映射 diff 中的新增行及其 Head 行号，用于验证模型报告的行号和证据。
function addedLines(patch: string): Map<number, string> {
  const lines = new Map<number, string>();
  let current = 0;
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const header = hunkHeader.exec(line);
    if (header) {
      current = Number(header[1]);
      continue;
    }
    if (!line || line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\ No newline")) {
      continue;
    }
    if (line.startsWith("+")) {
      if (current > 0) lines.set(current, line.slice(1));
      current++;
    } else if (line.startsWith(" ")) {
      current++;
    }
  }
  return lines;
}

function fingerprint(finding: Omit<Finding, "fingerprint">): string {
  const canonical =
    finding.title.toLowerCase().trim().replace(/\s+/g, " ") +
    "\0" +
    finding.filePath +
    "\0" +
    finding.line +
    "\0" +
    finding.evidence.toLowerCase().trim().replace(/\s+/g, " ");
  return createHash("sha256").update(canonical).digest("hex");
}

function parseReviewJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    if (content.endsWith('"')) {
      try {
        return JSON.parse(content.slice(0, -1));
      } catch {
        // Keep the original parse error when the complete response is still invalid.
      }
    }
    throw error;
  }
}

export function parseAndValidateReview(
  raw: string,
  diff: DiffResult,
  maxFindings: number,
): { result: ReviewResult; rejected: number } {
  if (maxFindings <= 0 || maxFindings > 100) {
    throw new Error("max findings must be between 1 and 100");
  }
  let parsed: unknown;
  try {
    const content = raw.trim();
    const fencedJson = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(content);
    parsed = parseReviewJson(fencedJson?.[1] ?? content);
  } catch (error) {
    throw new ReviewJsonDecodeError(error);
  }
  if (!isRecord(parsed)) {
    throw new ReviewJsonValidationError("model returned invalid review JSON: top-level value must be an object");
  }
  if (Object.keys(parsed).some((key) => !["summary", "findings"].includes(key))) {
    throw new ReviewJsonValidationError("model returned invalid review JSON: unexpected top-level fields");
  }
  if (!validText(parsed.summary, 1, 4000)) {
    throw new ReviewJsonValidationError(
      "model returned invalid review JSON: summary must be non-empty text of at most 4000 characters",
    );
  }
  if (!Array.isArray(parsed.findings)) {
    throw new ReviewJsonValidationError("model returned invalid review JSON: findings must be an array");
  }
  const linesByFile = new Map<string, Map<number, string>>();
  for (const change of diff.changes) {
    if (!change.skipped) linesByFile.set(change.path, addedLines(change.patch));
  }
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const rawFinding of parsed.findings) {
    if (
      !isRecord(rawFinding) ||
      Object.keys(rawFinding).some(
        (key) =>
          !["severity", "title", "file_path", "line", "evidence", "explanation", "suggestion"].includes(key),
      ) ||
      !validText(rawFinding.title, 1, 200) ||
      !validText(rawFinding.evidence, 1, 500) ||
      !validText(rawFinding.explanation, 1, 4000) ||
      !(rawFinding.suggestion === undefined || validText(rawFinding.suggestion, 0, 2000)) ||
      typeof rawFinding.severity !== "string" ||
      typeof rawFinding.file_path !== "string" ||
      !Number.isSafeInteger(rawFinding.line) ||
      Number(rawFinding.line) <= 0
    ) {
      rejected++;
      continue;
    }
    const severity = rawFinding.severity.trim().toLowerCase();
    if (!["critical", "high", "medium", "low"].includes(severity)) {
      rejected++;
      continue;
    }
    const line = linesByFile.get(rawFinding.file_path)?.get(Number(rawFinding.line));
    const evidence = rawFinding.evidence.trim();
    if (!line || !line.trim().includes(evidence)) {
      rejected++;
      continue;
    }
    const normalized = {
      severity: severity as Finding["severity"],
      title: rawFinding.title.trim(),
      filePath: rawFinding.file_path,
      line: Number(rawFinding.line),
      evidence,
      explanation: rawFinding.explanation.trim(),
      ...(rawFinding.suggestion?.trim() ? { suggestion: rawFinding.suggestion.trim() } : {}),
    };
    const id = fingerprint(normalized);
    if (seen.has(id) || findings.length >= maxFindings) {
      rejected++;
      continue;
    }
    seen.add(id);
    findings.push({ ...normalized, fingerprint: id });
  }
  return { result: { summary: parsed.summary.trim(), findings }, rejected };
}

export class ReviewWorkflow {
  constructor(
    private readonly agent: PiAgent,
    private readonly maxFiles: number,
    private readonly maxFindings: number,
    private readonly maxContextBytes: number,
    private readonly responseLanguage: ResponseLanguage = "en",
  ) {
    if (maxFiles <= 0 || maxFiles > 1000) throw new Error("max files must be between 1 and 1000");
    if (maxFindings <= 0 || maxFindings > 100) {
      throw new Error("max findings must be between 1 and 100");
    }
    if (maxContextBytes <= 0 || maxContextBytes > 8 << 20) {
      throw new Error("max context size must be between 1 byte and 8 MiB");
    }
  }

  async review(
    context: ReviewContext,
    diff: DiffResult,
    cwd: string,
    signal?: AbortSignal,
    trace?: JobTraceContext,
  ): Promise<ReviewOutcome> {
    this.validateSnapshot(context, diff);
    const { input, omittedFiles } = this.buildInput(context, diff);
    if (input.changes.length === 0) {
      if (omittedFiles > 0) {
        throw new Error(`review coverage is incomplete: ${omittedFiles} changed file(s) were omitted from the review context`);
      }
      return {
        result: { summary: "No reviewable text changes were available.", findings: [] },
        model: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        omittedFiles,
        rejected: 0,
      };
    }
    const userPrompt = JSON.stringify(input);
    if (Buffer.byteLength(userPrompt) > this.maxContextBytes) {
      throw new Error("review context exceeds configured size limit");
    }
    const prompts = getPromptTemplates(this.responseLanguage);
    const request: ModelRequest = { systemPrompt: prompts.reviewSystem, userPrompt };
    const logRejectedResponse = (response: Awaited<ReturnType<PiAgent["generate"]>>, error: unknown) => {
      console.warn("model review response rejected", {
        projectId: context.projectId,
        mrIid: context.mrIid,
        headSha: context.headSha,
        model: response.model,
        responseBytes: Buffer.byteLength(response.content),
        responseContent: response.content,
        reason: error instanceof Error ? error.message : String(error),
      });
    };
    const parseResponse = (response: Awaited<ReturnType<PiAgent["generate"]>>) => {
      try {
        return parseAndValidateReview(response.content, diff, this.maxFindings);
      } catch (error) {
        logRejectedResponse(response, error);
        throw error;
      }
    };
    let response = await this.agent.generate(request, cwd, signal, trace);
    let usage = response.usage;
    let parsed: ReturnType<typeof parseAndValidateReview>;
    try {
      parsed = parseResponse(response);
    } catch (error) {
      if (!(error instanceof ReviewJsonDecodeError) && !(error instanceof ReviewJsonValidationError)) throw error;
      const retryInstruction =
        error instanceof ReviewJsonDecodeError
          ? prompts.invalidReviewJson
          : prompts.invalidReviewSchema;
      const retryPrompt = `${userPrompt}\n\n${retryInstruction}`;
      if (Buffer.byteLength(retryPrompt) > this.maxContextBytes) throw error;
      const retryResponse = await this.agent.generate(
        { ...request, userPrompt: retryPrompt },
        cwd,
        signal,
        trace,
      );
      usage = {
        inputTokens: usage.inputTokens + retryResponse.usage.inputTokens,
        outputTokens: usage.outputTokens + retryResponse.usage.outputTokens,
        totalTokens: usage.totalTokens + retryResponse.usage.totalTokens,
      };
      response = retryResponse;
      parsed = parseResponse(response);
    }
    const { result } = parsed;
    if (result.findings.length === 0) {
      if (omittedFiles > 0) {
        throw new Error(`review coverage is incomplete: ${omittedFiles} changed file(s) were omitted from the review context`);
      }
      if (!trace) {
        throw new Error("review coverage is unavailable without trace context");
      }
      const missingFiles = incompleteChangedFiles(
        input.changes,
        cwd,
        this.agent.getTraceEntries(trace.jobId, trace.attempt),
      );
      if (missingFiles.length > 0) {
        const coveragePrompt = `${userPrompt}\n\n${prompts.reviewCoverageFollowup(missingFiles)}`;
        if (Buffer.byteLength(coveragePrompt) > this.maxContextBytes) {
          throw new Error("review coverage is incomplete and its targeted follow-up exceeds the configured context limit");
        }
        const coverageResponse = await this.agent.generate(
          { ...request, userPrompt: coveragePrompt },
          cwd,
          signal,
          trace,
        );
        usage = {
          inputTokens: usage.inputTokens + coverageResponse.usage.inputTokens,
          outputTokens: usage.outputTokens + coverageResponse.usage.outputTokens,
          totalTokens: usage.totalTokens + coverageResponse.usage.totalTokens,
        };
        response = coverageResponse;
        parsed = parseResponse(response);
        if (parsed.result.findings.length === 0) {
          const remainingFiles = incompleteChangedFiles(
            input.changes,
            cwd,
            this.agent.getTraceEntries(trace.jobId, trace.attempt),
          );
          if (remainingFiles.length > 0) {
            throw new Error(`review coverage is incomplete for changed file(s): ${remainingFiles.join(", ")}`);
          }
        }
      }
    }
    const { result: finalResult, rejected: finalRejected } = parsed;
    return { result: finalResult, model: response.model, usage, omittedFiles, rejected: finalRejected };
  }

  async explain(
    context: ReviewContext,
    filePath: string,
    content: Uint8Array,
    cwd: string,
    signal?: AbortSignal,
    trace?: JobTraceContext,
  ): Promise<Explanation> {
    if (context.projectId <= 0 || context.mrIid <= 0 || !context.headSha) {
      throw new Error("merge request identity and exact head SHA are required");
    }
    if (!validText(filePath, 1, 1024)) throw new Error("file path is empty or too long");
    if (
      content.byteLength === 0 ||
      content.byteLength > this.maxContextBytes ||
      !Buffer.from(content).toString("utf8")
    ) {
      throw new Error("file content is empty, invalid UTF-8, or exceeds the configured context limit");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const userPrompt = JSON.stringify({ merge_request: context, path: filePath, content: text });
    if (Buffer.byteLength(userPrompt) > this.maxContextBytes) {
      throw new Error("explanation context exceeds configured size limit");
    }
    const response = await this.agent.generate(
      {
        systemPrompt: getPromptTemplates(this.responseLanguage).explainSystem,
        userPrompt,
      },
      cwd,
      signal,
      trace,
    );
    const explanation = response.content.trim();
    if (!validText(explanation, 1, 8000)) {
      throw new Error("model returned an empty, invalid, or oversized explanation");
    }
    return { text: explanation, model: response.model, usage: response.usage };
  }

  private validateSnapshot(context: ReviewContext, diff: DiffResult): void {
    if (context.projectId <= 0 || context.mrIid <= 0 || !context.baseSha || !context.headSha) {
      throw new Error("merge request identity and exact base/head SHAs are required");
    }
    if (diff.baseSha !== context.baseSha || diff.headSha !== context.headSha) {
      throw new Error("diff commit range does not match the merge request snapshot");
    }
  }

  private buildInput(context: ReviewContext, diff: DiffResult): {
    input: { merge_request: ReviewContext; changes: Change[]; notice?: string };
    omittedFiles: number;
  } {
    const changes: Change[] = [];
    const representedSkipped = diff.changes.filter((change) => change.skipped).length;
    let omittedFiles = Math.max(0, diff.skippedFiles - representedSkipped);
    let totalBytes =
      Buffer.byteLength(context.title) +
      Buffer.byteLength(context.description) +
      Buffer.byteLength(context.sourceBranch) +
      Buffer.byteLength(context.targetBranch) +
      256;
    for (const change of diff.changes) {
      if (change.skipped || changes.length >= this.maxFiles || !change.patch) {
        omittedFiles++;
        continue;
      }
      const size = Buffer.byteLength(change.path) + Buffer.byteLength(change.patch) + 64;
      if (totalBytes + size > this.maxContextBytes) {
        omittedFiles++;
        continue;
      }
      totalBytes += size;
      changes.push(change);
    }
    return {
      input: {
        merge_request: context,
        changes,
        ...(omittedFiles > 0
          ? {
              notice: `${omittedFiles} changed file(s) were omitted by the review size or file policy.`,
            }
          : {}),
      },
      omittedFiles,
    };
  }
}
