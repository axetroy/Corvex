import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { JobStore } from "../jobs/store.js";
import type { EventResult } from "../jobs/model.js";
import { parseCommand, NotCorvexCommandError } from "../gitlab/command.js";
import { GitLabClient } from "../gitlab/client.js";
import { decodeNoteEvent, MAX_WEBHOOK_BODY_BYTES, validateWebhookToken } from "../gitlab/webhook.js";

function requestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      if (size > MAX_WEBHOOK_BODY_BYTES) return;
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        rejectPromise(new Error("GitLab webhook payload exceeds 1 MiB"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
    request.on("error", rejectPromise);
  });
}

function respond(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}

function contains(values: number[], target: number): boolean {
  return values.includes(target);
}

function eventId(event: ReturnType<typeof decodeNoteEvent>): string {
  return `${event.project.id}:${event.object_attributes.id}`;
}

function parseListenAddress(address: string): { host: string; port: number } {
  const index = address.lastIndexOf(":");
  if (index < 0) throw new Error(`server.listen must contain a port: "${address}"`);
  const port = Number(address.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`server.listen has an invalid port: "${address}"`);
  }
  let host = address.slice(0, index);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return { host: host || "0.0.0.0", port };
}

export class CorvexServer {
  private readonly server: Server;
  private readonly address: { host: string; port: number };

  constructor(
    private readonly config: CorvexConfig,
    private readonly store: JobStore,
    private readonly gitlab: GitLabClient,
  ) {
    this.address = parseListenAddress(config.server.listen);
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        console.error("handle HTTP request failed", { error: errorMessage(error) });
        if (!response.headersSent) respond(response, 500, "internal server error\n");
        else response.destroy();
      });
    });
    this.server.headersTimeout = config.server.readTimeout;
  }

  async run(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.server.once("error", rejectPromise);
      this.server.listen(this.address.port, this.address.host, () => {
        this.server.removeListener("error", rejectPromise);
        resolvePromise();
      });
    });
    console.info("Corvex server listening", {
      address: `${this.address.host}:${this.address.port}`,
    });
    const retention = new AbortController();
    const stopRetention = () => retention.abort();
    const retentionTask = this.runRetention(retention.signal);
    signal.addEventListener("abort", stopRetention, { once: true });
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const close = () => {
          const timeout = setTimeout(() => {
            rejectPromise(new Error("HTTP server shutdown timed out"));
          }, this.config.server.shutdownTimeout);
          this.server.close((error) => {
            clearTimeout(timeout);
            if (error) rejectPromise(error);
            else resolvePromise();
          });
        };
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
      });
    } finally {
      signal.removeEventListener("abort", stopRetention);
      retention.abort();
      await retentionTask;
    }
  }

  getListeningAddress(): { host: string; port: number } {
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("HTTP server is not listening on TCP");
    return { host: address.address, port: address.port };
  }

  private async runRetention(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const now = new Date();
      const historyBefore = new Date(now);
      historyBefore.setUTCDate(historyBefore.getUTCDate() - this.config.storage.retentionDays);
      const auditBefore = new Date(now);
      auditBefore.setUTCDate(auditBefore.getUTCDate() - this.config.storage.auditRetentionDays);
      try {
        this.store.pruneHistory(historyBefore, auditBefore);
      } catch (error) {
        console.error("prune persisted history failed", { error: errorMessage(error) });
      }
      try {
        await sleep(24 * 60 * 60_000, undefined, { signal });
      } catch {
        if (signal.aborted) return;
        throw new Error("retention timer failed");
      }
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/healthz") {
      respond(response, 200, "ok\n");
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      try {
        this.store.ping();
        respond(response, 200, "ready\n");
      } catch {
        respond(response, 503, "not ready\n");
      }
      return;
    }
    if (request.method === "GET" && path === "/metrics") {
      this.metrics(response);
      return;
    }
    if (request.method === "POST" && path === "/webhooks/gitlab") {
      await this.webhook(request, response);
      return;
    }
    respond(response, 404, "not found\n");
  }

  private metrics(response: ServerResponse): void {
    try {
      const counts = this.store.jobCounts();
      const calls = this.store.modelCallMetrics();
      const lines = [
        "# HELP corvex_jobs Number of persisted tasks by lifecycle status.",
        "# TYPE corvex_jobs gauge",
      ];
      for (const status of [
        "queued",
        "preparing",
        "analyzing",
        "fixing",
        "verifying",
        "publishing",
        "completed",
        "failed",
        "stale",
        "cancelled",
      ]) {
        lines.push(`corvex_jobs{status=${JSON.stringify(status)}} ${counts[status] ?? 0}`);
      }
      lines.push(
        "# HELP corvex_model_calls_total Model API calls by task type and outcome.",
        "# TYPE corvex_model_calls_total counter",
        "# HELP corvex_model_call_duration_seconds_sum Total duration of model API calls.",
        "# TYPE corvex_model_call_duration_seconds_sum counter",
        "# HELP corvex_model_input_tokens_total Input tokens reported for model API calls.",
        "# TYPE corvex_model_input_tokens_total counter",
        "# HELP corvex_model_output_tokens_total Output tokens reported for model API calls.",
        "# TYPE corvex_model_output_tokens_total counter",
      );
      for (const metric of calls) {
        const labels = `task_type=${JSON.stringify(metric.taskType)},outcome=${JSON.stringify(metric.outcome)}`;
        lines.push(`corvex_model_calls_total{${labels}} ${metric.calls}`);
        lines.push(`corvex_model_call_duration_seconds_sum{${labels}} ${(metric.durationMs / 1000).toFixed(3)}`);
        lines.push(`corvex_model_input_tokens_total{${labels}} ${metric.inputTokens}`);
        lines.push(`corvex_model_output_tokens_total{${labels}} ${metric.outputTokens}`);
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      response.end(`${lines.join("\n")}\n`);
    } catch (error) {
      console.error("collect metrics failed", { error: errorMessage(error) });
      respond(response, 503, "metrics unavailable\n");
    }
  }

  private async webhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!validateWebhookToken(this.config.gitlab.webhookSecret, header(request, "x-gitlab-token"))) {
      respond(response, 401, "unauthorized\n");
      return;
    }
    if (header(request, "x-gitlab-event") !== "Note Hook") {
      respond(response, 400, "unsupported event\n");
      return;
    }
    let event: ReturnType<typeof decodeNoteEvent>;
    try {
      event = decodeNoteEvent(await requestBody(request));
    } catch (error) {
      respond(response, errorMessage(error).includes("exceeds 1 MiB") ? 413 : 400, "invalid webhook payload\n");
      return;
    }
    if (
      event.object_attributes.system ||
      (this.config.gitlab.botUsername &&
        event.user.username.toLowerCase() === this.config.gitlab.botUsername.toLowerCase())
    ) {
      respond(response, 202, "");
      return;
    }
    if (!contains(this.config.gitlab.allowedProjectIds, event.project.id)) {
      respond(response, 403, "project is not allowed\n");
      return;
    }
    if (!contains(this.config.gitlab.allowedUserIds, event.user.id)) {
      respond(response, 403, "user is not allowed\n");
      return;
    }

    let command;
    try {
      command = parseCommand(event.object_attributes.note);
    } catch (error) {
      if (error instanceof NotCorvexCommandError) {
        respond(response, 202, "");
        return;
      }
      await this.reply(response, event, errorMessage(error));
      return;
    }
    if (command.name === "explain" && command.args.length === 0) {
      await this.reply(response, event, "Usage: `@corvex explain <path>`.");
      return;
    }
    if (
      (command.name === "explain" && command.args.length > 1) ||
      (command.args.length > 0 && command.name !== "fix" && command.name !== "explain")
    ) {
      await this.reply(response, event, "This command does not accept arguments.");
      return;
    }

    const id = eventId(event);
    const projectId = event.project.id;
    const mrIid = event.merge_request.iid;
    const actorId = event.user.id;
    const headSha = event.merge_request.last_commit?.id ?? "";
    try {
      let result: EventResult;
      switch (command.name) {
        case "review":
          result = this.store.createReview(id, `${projectId}:${mrIid}:${id}`, {
            projectId,
            mrIid,
            headSha,
            actorId,
          });
          break;
        case "status":
          result = this.store.status(id, projectId, mrIid);
          break;
        case "cancel":
          result = this.store.cancel(id, projectId, mrIid, actorId);
          break;
        case "fix":
          result = this.store.createFix(
            id,
            `${projectId}:${mrIid}:fix:${id}`,
            { projectId, mrIid, headSha, actorId, request: command.args.join(" ") },
            this.config.fix.enabled,
            contains(this.config.fix.allowedUserIds, actorId),
          );
          break;
        case "explain":
          result = this.store.createExplain(id, `${projectId}:${mrIid}:explain:${id}`, {
            projectId,
            mrIid,
            headSha,
            actorId,
            request: command.args[0]!,
          });
          break;
      }
      if (!result.delivered) {
        await this.gitlab.postNote(projectId, mrIid, result.response);
        this.store.markDelivered(id);
      }
      respond(response, 202, "");
    } catch (error) {
      console.error("process GitLab command failed", { eventId: id, error: errorMessage(error) });
      respond(response, 500, "failed to process command\n");
    }
  }

  private async reply(
    response: ServerResponse,
    event: ReturnType<typeof decodeNoteEvent>,
    message: string,
  ): Promise<void> {
    const id = eventId(event);
    try {
      const result = this.store.recordResponse(id, message);
      if (!result.delivered) {
        await this.gitlab.postNote(event.project.id, event.merge_request.iid, result.response);
        this.store.markDelivered(id);
      }
      respond(response, 202, "");
    } catch (error) {
      console.error("publish GitLab command response failed", { eventId: id, error: errorMessage(error) });
      respond(response, 502, "failed to publish command response\n");
    }
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
