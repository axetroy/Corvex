import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAgent } from "../src/agent/pi.js";
import { loadConfig } from "../src/config/config.js";
import { JobStore } from "../src/jobs/store.js";
import {
  reviewBenchmarkCases,
  scoreReviewBenchmark,
} from "../src/review/benchmark.js";
import { ReviewWorkflow } from "../src/review/workflow.js";

function parseArgs(args: string[]): { configPath: string; minimumF1: number } {
  let configPath = "configs/config.yaml";
  let minimumF1 = 0.6;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === "--config") {
      configPath = value;
    } else if (arg === "--min-f1") {
      minimumF1 = Number(value);
      if (!Number.isFinite(minimumF1) || minimumF1 < 0 || minimumF1 > 1) {
        throw new Error("--min-f1 must be between 0 and 1");
      }
    } else {
      throw new Error(`unknown benchmark option "${arg}"`);
    }
  }
  return { configPath, minimumF1 };
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath, "worker");
  if (!config.agent.enabled) throw new Error("review benchmark requires agent.enabled=true");
  const store = await JobStore.open(config.storage.database);
  const workspace = await mkdtemp(join(tmpdir(), "corvex-review-benchmark-"));
  try {
    const benchmarkConfig = {
      ...config,
      agent: { ...config.agent, mcpEnabled: false, webEnabled: false, webBlockedHosts: [], skillPaths: [] },
    };
    const workflow = new ReviewWorkflow(
      new PiAgent(benchmarkConfig, store),
      config.review.maxFiles,
      config.review.maxFindings,
      config.review.maxContextBytes,
    );
    const results = [];
    for (const benchmarkCase of reviewBenchmarkCases) {
      const outcome = await workflow.review(
        benchmarkCase.context,
        benchmarkCase.diff,
        workspace,
      );
      results.push({
        name: benchmarkCase.name,
        score: scoreReviewBenchmark(benchmarkCase.expected, outcome.result.findings),
      });
    }
    const totals = results.reduce(
      (sum, result) => ({
        truePositives: sum.truePositives + result.score.truePositives,
        falsePositives: sum.falsePositives + result.score.falsePositives,
        falseNegatives: sum.falseNegatives + result.score.falseNegatives,
      }),
      { truePositives: 0, falsePositives: 0, falseNegatives: 0 },
    );
    const precision =
      totals.truePositives + totals.falsePositives === 0
        ? 1
        : totals.truePositives / (totals.truePositives + totals.falsePositives);
    const recall =
      totals.truePositives + totals.falseNegatives === 0
        ? 1
        : totals.truePositives / (totals.truePositives + totals.falseNegatives);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    console.info(
      JSON.stringify(
        {
          model: config.agent.model,
          minimumF1: options.minimumF1,
          totals: { ...totals, precision, recall, f1 },
          cases: results,
        },
        null,
        2,
      ),
    );
    if (f1 < options.minimumF1) process.exitCode = 1;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    store.close();
  }
}

run().catch((error: unknown) => {
  console.error("review benchmark failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
