import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppStore } from "../../store.js";
import { errorMessage } from "../../errors.js";
import { sendText } from "./respond.js";

function metricsBody(store: AppStore): string {
  const calls = store.modelCallMetrics();
  const lines = [
    "# HELP corvex_model_calls_total Model API calls by task type and outcome.",
    "# TYPE corvex_model_calls_total counter",
    "# HELP corvex_model_call_duration_seconds_sum Total duration of model API calls.",
    "# TYPE corvex_model_call_duration_seconds_sum counter",
    "# HELP corvex_model_input_tokens_total Input tokens reported for model API calls.",
    "# TYPE corvex_model_input_tokens_total counter",
    "# HELP corvex_model_output_tokens_total Output tokens reported for model API calls.",
    "# TYPE corvex_model_output_tokens_total counter",
  ];
  for (const metric of calls) {
    const labels = `task_type=${JSON.stringify(metric.taskType)},outcome=${JSON.stringify(metric.outcome)}`;
    lines.push(`corvex_model_calls_total{${labels}} ${metric.calls}`);
    lines.push(`corvex_model_call_duration_seconds_sum{${labels}} ${(metric.durationMs / 1000).toFixed(3)}`);
    lines.push(`corvex_model_input_tokens_total{${labels}} ${metric.inputTokens}`);
    lines.push(`corvex_model_output_tokens_total{${labels}} ${metric.outputTokens}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 健康检查、就绪检查与 Prometheus 指标。 */
export function registerSystemRoutes(app: FastifyInstance, store: AppStore): void {
  app.get("/healthz", async (_request, reply) => {
    sendText(reply, 200, "ok\n");
  });
  app.get("/readyz", async (_request, reply) => {
    try {
      store.ping();
      sendText(reply, 200, "ready\n");
    } catch {
      sendText(reply, 503, "not ready\n");
    }
  });
  app.get("/metrics", async (_request, reply: FastifyReply) => {
    try {
      void reply
        .code(200)
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .send(metricsBody(store));
    } catch (error) {
      console.error("collect metrics failed", { error: errorMessage(error) });
      sendText(reply, 503, "metrics unavailable\n");
    }
  });
}
