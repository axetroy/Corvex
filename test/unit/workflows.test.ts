import { describe, expect, it, vi } from "vitest";
import type { JobTraceContext, PiAgent } from "../../src/agent/pi.js";
import { getPromptTemplates } from "../../src/agent/prompts.js";
import { FixWorkflow, parseFixResponse } from "../../src/fix/workflow.js";
import type { DiffResult } from "../../src/git/types.js";
import type { JobTraceEntry } from "../../src/jobs/model.js";
import { parseAndValidateReview, ReviewWorkflow } from "../../src/review/workflow.js";

const diff: DiffResult = {
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  skippedFiles: 0,
  changes: [
    {
      path: "src/app.ts",
      status: "M",
      addedLines: 1,
      removedLines: 0,
      skipped: "",
      patch: "@@ -2,0 +3 @@\n+const value = user.input;\n",
    },
  ],
};

const reviewTrace: JobTraceContext = { jobId: "job-1", attempt: 1, taskType: "review" };

function completeFileRead(path: string): JobTraceEntry {
  return {
    id: 1,
    attempt: 1,
    round: 1,
    kind: "tool",
    name: "read_file",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.001Z",
    durationMs: 1,
    model: null,
    inputTokens: null,
    outputTokens: null,
    input: JSON.stringify({ path, startLine: 1, maxLines: 4 }),
    output: JSON.stringify({ content: [{ type: "text", text: "[Lines 1-4]\nconst value = user.input;\n" }], details: {} }),
    schema: null,
    rawContent: null,
    errorDetail: null,
  };
}

describe("review and fix response validation", () => {
  it("keeps task guidance and output contracts aligned in both languages", () => {
    for (const language of ["en", "zh-CN"] as const) {
      const prompts = getPromptTemplates(language);
      const taskPrompts = [prompts.reviewSystem, prompts.fixSystem, prompts.explainSystem];

      for (const prompt of taskPrompts) {
        expect(prompt).toContain("read_file");
        expect(prompt).toContain("git_grep");
        expect(prompt).toContain("search_text");
      }

      expect(prompts.reviewSystem).toContain('"summary"');
      expect(prompts.reviewSystem).toContain('"findings"');
      expect(prompts.fixSystem).toContain('"patch"');
      expect(prompts.fixSystem).toContain(language === "en" ? "Only modify files" : "只允许修改");
      expect(prompts.explainSystem).toContain("Markdown");

      const followup = prompts.reviewCoverageFollowup(["src/app.ts"]);
      expect(followup).toContain("src/app.ts");
      expect(followup).toContain(language === "en" ? "complete file reads" : "分片读取规则");
    }
  });

  it("accepts only review evidence present on the exact added line", () => {
    const raw = JSON.stringify({
      summary: "One concrete defect.",
      findings: [
        {
          severity: "high",
          title: "Unchecked input",
          file_path: "src/app.ts",
          line: 3,
          evidence: "user.input",
          explanation: "The value is used without validation.",
        },
        {
          severity: "critical",
          title: "Unsupported evidence",
          file_path: "src/app.ts",
          line: 3,
          evidence: "not present",
          explanation: "This is not supported by the added line.",
        },
      ],
    });
    const result = parseAndValidateReview(raw, diff, 10);
    expect(result.result.findings).toHaveLength(1);
    expect(result.result.findings[0]?.line).toBe(3);
    expect(result.rejected).toBe(1);
  });

  it("accepts review JSON wrapped in a Markdown code fence", () => {
    const raw = JSON.stringify({ summary: "Review complete", findings: [] });
    const result = parseAndValidateReview(`\`\`\`json\n${raw}\n\`\`\``, diff, 10);
    expect(result.result.summary).toBe("Review complete");
    expect(result.result.findings).toEqual([]);
  });

  it("accepts a matching findings_count field", () => {
    const raw = JSON.stringify({
      summary: "One concrete defect.",
      findings: [{
        severity: "high",
        title: "Unchecked input",
        file_path: "src/app.ts",
        line: 3,
        evidence: "user.input",
        explanation: "The value is used without validation.",
      }],
      findings_count: 1,
    });

    const result = parseAndValidateReview(raw, diff, 10);

    expect(result.result.findings).toHaveLength(1);
    expect(result.result.summary).toBe("One concrete defect.");
  });

  it("rejects a findings_count field that does not match the findings array", () => {
    const raw = JSON.stringify({ summary: "Review complete", findings: [], findings_count: 1 });

    expect(() => parseAndValidateReview(raw, diff, 10)).toThrow("findings_count must match findings length");
  });

  it("recovers a single trailing quote after a complete review JSON object", () => {
    const raw = `${JSON.stringify({ summary: "Review complete", findings: [] })}"`;
    const result = parseAndValidateReview(raw, diff, 10);
    expect(result.result.summary).toBe("Review complete");
    expect(result.result.findings).toEqual([]);
  });

  it("extracts a review JSON object after a prose summary", () => {
    const raw = `已完整审查全部变更文件，未发现明确缺陷。\n\n${JSON.stringify({
      summary: "Review {complete}",
      findings: [],
    }, null, 2)}`;

    const result = parseAndValidateReview(raw, diff, 10);

    expect(result.result.summary).toBe("Review {complete}");
    expect(result.result.findings).toEqual([]);
  });

  it("rejects prose containing multiple standalone JSON objects", () => {
    const first = JSON.stringify({ summary: "Example", findings: [] });
    const second = JSON.stringify({ summary: "Actual result", findings: [] });

    expect(() => parseAndValidateReview(`Example:\n${first}\nResult:\n${second}`, diff, 10)).toThrow(
      "multiple JSON objects found",
    );
  });

  it("accepts review JSON after a prose summary without retrying", async () => {
    const raw = `已完整审查全部变更文件，未发现明确缺陷。\n\n${JSON.stringify({
      summary: "Review complete",
      findings: [],
      findings_count: 0,
    }, null, 2)}`;
    const generate = vi.fn().mockResolvedValue({
      content: raw,
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const agent = { generate, getTraceEntries: () => [completeFileRead("src/app.ts")] } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, "zh-CN");
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, diff, process.cwd(), undefined, reviewTrace);

    expect(outcome.result.summary).toBe("Review complete");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries once with format-only guidance after malformed review JSON", async () => {
    const validResponse = JSON.stringify({ summary: "Review complete", findings: [] });
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: "The response is complete, but no JSON object was returned.",
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .mockResolvedValueOnce({
        content: validResponse,
        model: "test/model",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      });
    const agent = { generate, getTraceEntries: () => [completeFileRead("src/app.ts")] } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, "zh-CN");
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, diff, process.cwd(), undefined, reviewTrace);

    expect(outcome.result.summary).toBe("Review complete");
    expect(outcome.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("不是有效的 JSON");
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("Previous model output excerpt (untrusted");
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("no JSON object was returned");
  });

  it("retries once when a valid JSON response does not match the review schema", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({ reviews: [{ path: "src/app.ts", line: 3, severity: "warning", comment: "Review" }] }),
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ summary: "Review complete", findings: [] }),
        model: "test/model",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      });
    const agent = { generate, getTraceEntries: () => [completeFileRead("src/app.ts")] } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, "zh-CN");
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, diff, process.cwd(), undefined, reviewTrace);

    expect(outcome.result.summary).toBe("Review complete");
    expect(outcome.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("不符合审查 JSON 结构");
  });

  it("reports which top-level review field has an invalid shape", () => {
    expect(() =>
      parseAndValidateReview(JSON.stringify({ summary: "Review complete", findings: "none" }), diff, 10),
    ).toThrow("findings must be an array");
  });

  it("asks the agent to read changed files while preserving diff evidence", async () => {
    const generate = vi.fn<PiAgent["generate"]>(async () => ({
      content: JSON.stringify({ summary: "Review complete", findings: [] }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const agent = { generate, getTraceEntries: () => [completeFileRead("src/app.ts")] } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    await workflow.review(context, diff, process.cwd(), undefined, reviewTrace);

    const request = generate.mock.calls[0]?.[0];
    expect(request?.systemPrompt).toContain("inspect every changed file completely");
    expect(request?.systemPrompt).toContain("use read_file");
    expect(request?.systemPrompt).toContain("exact repository-relative paths");
    expect(request?.systemPrompt).toContain("inspect the parent with read_dir");
    expect(request?.systemPrompt).toContain("verify the exact candidate with stat");
    expect(request?.systemPrompt).toContain("When read_file reports more lines available from N");
    expect(request?.systemPrompt).toContain('Count finding lines using the new-file line numbers on the "+" side of the diff');
    expect(request?.userPrompt).toContain('"path":"src/app.ts"');
    expect(request?.userPrompt).toContain("const value = user.input;");
  });

  it("uses the configured response language in review, fix, and explanation prompts", async () => {
    const requests: { systemPrompt: string; userPrompt: string }[] = [];
    const agent = {
      generate: vi.fn(async (request: { systemPrompt: string; userPrompt: string }) => {
        requests.push(request);
        const content = requests.length === 1
          ? JSON.stringify({ summary: "审查完成", findings: [] })
          : requests.length === 2
            ? JSON.stringify({ summary: "无需修改", patch: "" })
            : "这是文件说明。";
        return {
          content,
          model: "test/model",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }),
      getTraceEntries: () => [completeFileRead("src/app.ts")],
    } as unknown as PiAgent;
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };
    const reviewer = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, "zh-CN");
    const fixer = new FixWorkflow(agent, 1024 * 1024, 128 * 1024, "zh-CN");

    await reviewer.review(context, diff, process.cwd(), undefined, reviewTrace);
    await fixer.fix(context, "", diff, process.cwd(), undefined, { ...reviewTrace, taskType: "fix" });
    await reviewer.explain(
      context,
      "src/app.ts",
      Buffer.from("const value = 1;"),
      process.cwd(),
      undefined,
      { ...reviewTrace, taskType: "explain" },
    );

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.systemPrompt.includes("简体中文"))).toBe(true);
    expect(requests[0]?.systemPrompt).toContain('finding 的行号必须按 diff 的 "+" 新文件侧行号计数');
    expect(requests[0]?.systemPrompt).toContain("先用 read_dir 检查父目录，再用 stat 确认精确候选路径");
  });

  it("does not accept an empty review when changed-file coverage is missing", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({ summary: "Review complete", findings: [] }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const agent = {
      generate,
      getTraceEntries: () => [],
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };
    const trace: JobTraceContext = { jobId: "job-1", attempt: 1, taskType: "review" };

    await expect(workflow.review(context, diff, process.cwd(), undefined, trace)).rejects.toThrow(
      "review coverage is incomplete",
    );
  });

  it("keeps findings and follows up when a non-empty review has unread changed files", async () => {
    const secondChange = {
      ...diff.changes[0]!,
      path: "src/other.ts",
      patch: "@@ -0,0 +1 @@\n+const other = input;\n",
    };
    const multipleChanges: DiffResult = { ...diff, changes: [...diff.changes, secondChange] };
    let followupCompleted = false;
    const responseFor = (path: string, evidence: string) => ({
      content: JSON.stringify({
        summary: `Reviewed ${path}.`,
        findings: [{
          severity: "high",
          title: `Validate ${path}`,
          file_path: path,
          line: path === "src/app.ts" ? 3 : 1,
          evidence,
          explanation: "The added value is not validated.",
        }],
      }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    const generate = vi.fn<PiAgent["generate"]>()
      .mockResolvedValueOnce(responseFor("src/app.ts", "user.input"))
      .mockImplementationOnce(async () => {
        followupCompleted = true;
        return responseFor("src/other.ts", "input");
      });
    const agent = {
      generate,
      getTraceEntries: () => followupCompleted
        ? [completeFileRead("src/app.ts"), completeFileRead("src/other.ts")]
        : [completeFileRead("src/app.ts")],
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, multipleChanges, process.cwd(), undefined, reviewTrace);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("src/other.ts");
    expect(outcome.result.findings.map(({ filePath }) => filePath)).toEqual(["src/app.ts", "src/other.ts"]);
    expect(outcome.result.summary).toContain("Coverage follow-up: Reviewed src/other.ts.");
    expect(outcome.usage).toEqual({ inputTokens: 2, outputTokens: 2, totalTokens: 4 });
  });

  it("marks partial coverage when findings exist but a follow-up still leaves files unread", async () => {
    const secondChange = {
      ...diff.changes[0]!,
      path: "src/other.ts",
      patch: "@@ -0,0 +1 @@\n+const other = input;\n",
    };
    const multipleChanges: DiffResult = { ...diff, changes: [...diff.changes, secondChange] };
    const generate = vi.fn<PiAgent["generate"]>()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          summary: "One issue found.",
          findings: [{
            severity: "high",
            title: "Validate input",
            file_path: "src/app.ts",
            line: 3,
            evidence: "user.input",
            explanation: "The new value is not validated.",
          }],
        }),
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ summary: "No additional issues found.", findings: [] }),
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    const agent = {
      generate,
      getTraceEntries: () => [completeFileRead("src/app.ts")],
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, multipleChanges, process.cwd(), undefined, reviewTrace);

    expect(outcome.result.findings).toHaveLength(1);
    expect(outcome.result.summary).toContain("Coverage is partial: 1 changed file(s) remained unread");
    expect(outcome.usage).toEqual({ inputTokens: 2, outputTokens: 2, totalTokens: 4 });
  });

  it("marks reviews with findings as partial when files were omitted", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({
        summary: "One concrete defect found.",
        findings: [{
          severity: "high",
          title: "Unchecked input",
          file_path: "src/app.ts",
          line: 3,
          evidence: "user.input",
          explanation: "The value is used without validation.",
        }],
      }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const agent = {
      generate,
      getTraceEntries: () => [completeFileRead("src/app.ts")],
    } as unknown as PiAgent;
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    for (const language of ["en", "zh-CN"] as const) {
      const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, language);
      const outcome = await workflow.review(
        context,
        { ...diff, skippedFiles: 1 },
        process.cwd(),
        undefined,
        reviewTrace,
      );

      expect(outcome.result.findings).toHaveLength(1);
      expect(outcome.omittedFiles).toBe(1);
      expect(outcome.result.summary).toContain(
        language === "en" ? "Coverage is partial" : "本次审查覆盖不完整",
      );
      expect(outcome.result.summary).toContain(
        language === "en" ? "1 changed file(s) were omitted" : "有 1 个变更文件",
      );
    }
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("reviews large merge requests in bounded batches with global finding and usage limits", async () => {
    const changes = Array.from({ length: 13 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: "M" as const,
      addedLines: 1,
      removedLines: 0,
      skipped: "",
      patch: `@@ -0,0 +1 @@\n+const value = input${index};\n`,
    }));
    const largeDiff: DiffResult = { ...diff, changes };
    const generate = vi.fn<PiAgent["generate"]>(async (request) => {
      const input = JSON.parse(request.userPrompt) as { changes: { path: string; patch: string }[] };
      const change = input.changes[0];
      if (!change) throw new Error("expected a non-empty review batch");
      const evidence = change.patch.split("\n").find((line) => line.startsWith("+"))?.slice(1);
      if (!evidence) throw new Error("expected an added line in the review batch");
      return {
        content: JSON.stringify({
          summary: `Reviewed ${input.changes.length} files.`,
          findings: [{
            severity: "high",
            title: "Unchecked input",
            file_path: change.path,
            line: 1,
            evidence,
            explanation: "The added value is not validated.",
          }],
        }),
        model: "test/model",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      };
    });
    const agent = {
      generate,
      getTraceEntries: () => changes.map((change) => completeFileRead(change.path)),
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 12, 1, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Large test merge request",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, largeDiff, process.cwd(), undefined, reviewTrace);

    const batchSizes = generate.mock.calls.map(([request]) => {
      const input = JSON.parse(request.userPrompt) as { changes: unknown[] };
      return input.changes.length;
    });
    expect(batchSizes).toEqual([10, 2]);
    expect(outcome.result.findings).toHaveLength(1);
    expect(outcome.rejected).toBe(1);
    expect(outcome.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    expect(outcome.omittedFiles).toBe(1);
    expect(outcome.result.summary).toContain("Coverage is partial");
  });

  it("splits review batches further when serialized context reaches the byte limit", async () => {
    const changes = Array.from({ length: 3 }, (_, index) => ({
      path: `src/large-${index}.ts`,
      status: "M" as const,
      addedLines: 1,
      removedLines: 0,
      skipped: "",
      patch: `@@ -0,0 +1 @@\n+const value = ${"x".repeat(900)};\n`,
    }));
    const largeDiff: DiffResult = { ...diff, changes };
    const generate = vi.fn<PiAgent["generate"]>(async (request) => {
      const input = JSON.parse(request.userPrompt) as { changes: { path: string }[] };
      const change = input.changes[0];
      if (!change || input.changes.length !== 1) throw new Error("context limit should create single-file batches");
      return {
        content: JSON.stringify({
          summary: "Reviewed one large file.",
          findings: [{
            severity: "medium",
            title: "Review the value",
            file_path: change.path,
            line: 1,
            evidence: "const value",
            explanation: "Review the source of the assigned value.",
          }],
        }),
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    });
    const agent = {
      generate,
      getTraceEntries: () => changes.map((change) => completeFileRead(change.path)),
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1800);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Large context test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, largeDiff, process.cwd(), undefined, reviewTrace);

    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls.every(([request]) => Buffer.byteLength(request.userPrompt) <= 1800)).toBe(true);
    expect(outcome.result.findings).toHaveLength(3);
    expect(outcome.usage).toEqual({ inputTokens: 3, outputTokens: 3, totalTokens: 6 });
  });

  it("retries malformed JSON returned by the coverage follow-up", async () => {
    const validResponse = {
      content: JSON.stringify({ summary: "Review complete", findings: [] }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    let coverageComplete = false;
    const generate = vi.fn<PiAgent["generate"]>()
      .mockResolvedValueOnce(validResponse)
      .mockResolvedValueOnce({
        content: "已完整审查全部变更文件。",
        model: "test/model",
        usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      })
      .mockImplementationOnce(async () => {
        coverageComplete = true;
        return validResponse;
      });
    const agent = {
      generate,
      getTraceEntries: () => coverageComplete ? [completeFileRead("src/app.ts")] : [],
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, "zh-CN");
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, diff, process.cwd(), undefined, reviewTrace);

    expect(outcome.result.findings).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[2]?.[0].userPrompt).toContain("已完整审查全部变更文件");
  });

  it("recovers JSON after a prose summary in the coverage follow-up", async () => {
    let coverageComplete = false;
    const generate = vi.fn<PiAgent["generate"]>()
      .mockResolvedValueOnce({
        content: JSON.stringify({ summary: "Review complete", findings: [] }),
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })
      .mockImplementationOnce(async () => {
        coverageComplete = true;
        return {
          content: `已完整审查全部变更文件，未发现明确缺陷。\n\n${JSON.stringify({
            summary: "Review complete",
            findings: [],
          }, null, 2)}`,
          model: "test/model",
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        };
      });
    const agent = {
      generate,
      getTraceEntries: () => coverageComplete ? [completeFileRead("src/app.ts")] : [],
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, "zh-CN");
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    const outcome = await workflow.review(context, diff, process.cwd(), undefined, reviewTrace);

    expect(outcome.result.summary).toBe("Review complete");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not accept an empty review without trace context", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({ summary: "Review complete", findings: [] }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const workflow = new ReviewWorkflow({ generate } as unknown as PiAgent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    await expect(workflow.review(context, diff, process.cwd())).rejects.toThrow(
      "review coverage is unavailable without trace context",
    );
  });

  it("accepts an empty review after contiguous ranges cover every changed file", async () => {
    const traces: JobTraceEntry[] = [];
    const response = {
      content: JSON.stringify({ summary: "Review complete", findings: [] }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const generate = vi.fn<PiAgent["generate"]>()
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(async () => {
        const createReadTrace = (id: number, startLine: number, text: string): JobTraceEntry => ({
          id,
          attempt: 1,
          round: id,
          kind: "tool",
          name: "read_file",
          status: "succeeded",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:00:00.001Z",
          durationMs: 1,
          model: null,
          inputTokens: null,
          outputTokens: null,
          input: JSON.stringify({ path: "src/app.ts", startLine, maxLines: 2 }),
          output: JSON.stringify({ content: [{ type: "text", text }], details: {} }),
          schema: null,
          rawContent: null,
          errorDetail: null,
        });
        traces.push(
          createReadTrace(1, 1, "[Lines 1-2; more lines available from 3]\nconst value = user.input;\n"),
          createReadTrace(2, 3, "[Lines 3-4]\nexport {};\n"),
        );
        return response;
      });
    const agent = {
      generate,
      getTraceEntries: () => traces,
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024, "zh-CN");
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };
    const trace: JobTraceContext = { jobId: "job-1", attempt: 1, taskType: "review" };

    const outcome = await workflow.review(context, diff, process.cwd(), undefined, trace);

    expect(outcome.result.findings).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("自动覆盖校验");
    expect(generate.mock.calls[1]?.[0].userPrompt).toContain("src/app.ts");
    expect(generate.mock.calls[1]?.[0].systemPrompt).toContain("从第 1 行开始读取");
    expect(generate.mock.calls[1]?.[0].systemPrompt).toContain("从 startLine N 继续");
  });

  it("does not accept an empty review when files were omitted from the review context", async () => {
    const generate = vi.fn(async () => ({
      content: JSON.stringify({ summary: "Review complete", findings: [] }),
      model: "test/model",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }));
    const workflow = new ReviewWorkflow({ generate } as unknown as PiAgent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    await expect(
      workflow.review(context, { ...diff, skippedFiles: 1 }, process.cwd()),
    ).rejects.toThrow("1 changed file(s) were omitted");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("does not report no reviewable changes when every changed file was omitted", async () => {
    const generate = vi.fn();
    const workflow = new ReviewWorkflow({ generate } as unknown as PiAgent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };

    await expect(
      workflow.review(context, { ...diff, changes: [], skippedFiles: 1 }, process.cwd()),
    ).rejects.toThrow("1 changed file(s) were omitted");
    expect(generate).not.toHaveBeenCalled();
  });

  it("logs the raw model response when review JSON is rejected", async () => {
    const raw = '["not", "an object"]';
    const agent = {
      generate: async () => ({
        content: raw,
        model: "test/model",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    } as unknown as PiAgent;
    const workflow = new ReviewWorkflow(agent, 10, 10, 1024 * 1024);
    const context = {
      projectId: 1,
      mrIid: 1,
      title: "Test",
      description: "",
      sourceBranch: "feature",
      targetBranch: "main",
      baseSha: diff.baseSha,
      headSha: diff.headSha,
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(workflow.review(context, diff, process.cwd())).rejects.toThrow(
        "top-level value must be an object",
      );
      expect(warning).toHaveBeenCalledWith(
        "model review response rejected",
        expect.objectContaining({ responseContent: raw }),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("validates fix JSON and enforces the patch byte limit", () => {
    expect(parseFixResponse('{"summary":"Safe change","patch":""}', 10)).toEqual({
      summary: "Safe change",
      patch: "",
    });
    expect(() => parseFixResponse('{"summary":"ok","patch":"12345"}', 4)).toThrow(
      "exceeds its configured size limit",
    );
    expect(() => parseFixResponse('{"summary":"ok","patch":"","extra":true}', 10)).toThrow(
      "invalid fix JSON",
    );
  });
});
