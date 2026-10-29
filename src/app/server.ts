import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { JobStore } from "../jobs/store.js";
import { jobStatuses, jobTypes, type EventResult, type JobStatus, type JobType } from "../jobs/model.js";
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

function respondWebhook(
  response: ServerResponse,
  status: number,
  body: string,
  details: Record<string, string | number | boolean> = {},
): void {
  console.info("GitLab webhook response", { status, ...details });
  respond(response, status, body);
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function isJobStatus(value: string): value is JobStatus {
  return jobStatuses.some((status) => status === value);
}

function isJobType(value: string): value is JobType {
  return jobTypes.some((type) => type === value);
}

function basicCredentialsMatch(request: IncomingMessage, username: string, password: string): boolean {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]!, "base64");
  if (provided.toString("base64") !== match[1]) return false;
  const expected = Buffer.from(`${username}:${password}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function optionalInteger(value: string | null, minimum: number, maximum: number): number | undefined | false {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : false;
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
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/ops" || path === "/ops/" || path.startsWith("/ops/") || path.startsWith("/api/ops/")) {
      if (!this.config.operations.username || !this.config.operations.password) {
        respond(response, 404, "not found\n");
        return;
      }
      if (!basicCredentialsMatch(request, this.config.operations.username, this.config.operations.password)) {
        response.setHeader("www-authenticate", 'Basic realm="Corvex Operations", charset="UTF-8"');
        respond(response, 401, "authentication required\n");
        return;
      }
      if (path.startsWith("/api/ops/")) {
        this.operationsApi(request, response, url);
        return;
      }
      await this.operationsUi(response, path);
      return;
    }
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

  private operationsApi(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET") {
      respondJson(response, 405, { error: "method not allowed" });
      return;
    }
    if (url.pathname === "/api/ops/overview") {
      const generatedAt = new Date();
      const overview = this.store.operationsOverview(Math.max(this.config.worker.pollInterval * 3, 30_000));
      const oldestQueuedAt = overview.oldestQueuedAt;
      const oldestQueueAgeSeconds = oldestQueuedAt
        ? Math.max(0, Math.floor((generatedAt.valueOf() - Date.parse(oldestQueuedAt)) / 1000))
        : null;
      if (oldestQueueAgeSeconds !== null && !Number.isFinite(oldestQueueAgeSeconds)) {
        throw new Error("SQLite returned an invalid oldest queued timestamp");
      }
      respondJson(response, 200, {
        generatedAt: generatedAt.toISOString(),
        ...overview,
        oldestQueueAgeSeconds,
        modelCalls: this.store.modelCallMetrics(),
      });
      return;
    }
    if (url.pathname === "/api/ops/jobs") {
      const params = url.searchParams;
      const statusValue = params.get("status");
      const typeValue = params.get("type");
      const status = statusValue === null ? undefined : isJobStatus(statusValue) ? statusValue : false;
      const type = typeValue === null ? undefined : isJobType(typeValue) ? typeValue : false;
      const projectId = optionalInteger(params.get("projectId"), 1, Number.MAX_SAFE_INTEGER);
      const mrIid = optionalInteger(params.get("mrIid"), 1, Number.MAX_SAFE_INTEGER);
      const limit = optionalInteger(params.get("limit"), 1, 100) ?? 25;
      const offset = optionalInteger(params.get("offset"), 0, 1_000_000) ?? 0;
      const search = params.get("search") ?? undefined;
      if (
        status === false ||
        type === false ||
        projectId === false ||
        mrIid === false ||
        limit === false ||
        offset === false ||
        (search?.trim().length ?? 0) > 100
      ) {
        respondJson(response, 400, { error: "invalid job list filter" });
        return;
      }
      respondJson(
        response,
        200,
        this.store.listOperationsJobs({
          status,
          type,
          projectId,
          mrIid,
          search,
          limit,
          offset,
        }),
      );
      return;
    }
    const jobMatch = /^\/api\/ops\/jobs\/([^/]+)$/.exec(url.pathname);
    if (jobMatch) {
      let jobId: string;
      try {
        jobId = decodeURIComponent(jobMatch[1]!);
      } catch {
        respondJson(response, 400, { error: "invalid job ID" });
        return;
      }
      const job = this.store.getJobDetails(jobId);
      if (!job) {
        respondJson(response, 404, { error: "job not found" });
        return;
      }
      respondJson(response, 200, job);
      return;
    }
    respondJson(response, 404, { error: "not found" });
  }

  private async operationsUi(response: ServerResponse, path: string): Promise<void> {
    const assets: Record<string, { file: string; contentType: string }> = {
      "/ops/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
      "/ops/i18n.js": { file: "i18n.js", contentType: "text/javascript; charset=utf-8" },
      "/ops/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
    };
    const file = path === "/ops" || path === "/ops/" ? "index.html" : assets[path]?.file;
    if (!file) {
      respond(response, 404, "not found\n");
      return;
    }
    const contentType = path === "/ops" || path === "/ops/"
      ? "text/html; charset=utf-8"
      : assets[path]!.contentType;
    const contents = await readFile(new URL(`./ui/${file}`, import.meta.url));
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.end(contents);
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
    const eventType = header(request, "x-gitlab-event");
    console.info("GitLab webhook received", {
      eventType: eventType === "Note Hook" ? eventType : eventType ? "unsupported" : "missing",
    });
    if (!validateWebhookToken(this.config.gitlab.webhookSecret, header(request, "x-gitlab-token"))) {
      console.warn("GitLab webhook rejected", { reason: "invalid_token" });
      respondWebhook(response, 401, "unauthorized\n", { reason: "invalid_token" });
      return;
    }
    if (eventType !== "Note Hook") {
      console.warn("GitLab webhook rejected", { reason: "unsupported_event" });
      respondWebhook(response, 400, "unsupported event\n", { reason: "unsupported_event" });
      return;
    }
    let event: ReturnType<typeof decodeNoteEvent>;
    try {
      const body = await requestBody(request);
      console.info("GitLab webhook body", { body: body.toString("utf8") });
      event = decodeNoteEvent(body);
    } catch (error) {
      const tooLarge = errorMessage(error).includes("exceeds 1 MiB");
      console.warn("GitLab webhook rejected", {
        reason: tooLarge ? "payload_too_large" : "invalid_payload",
      });
      respondWebhook(
        response,
        tooLarge ? 413 : 400,
        "invalid webhook payload\n",
        { reason: tooLarge ? "payload_too_large" : "invalid_payload" },
      );
      return;
    }
    const id = eventId(event);
    const details = {
      eventId: id,
      projectId: event.project.id,
      mrIid: event.merge_request.iid,
      noteId: event.object_attributes.id,
      actorId: event.user.id,
    };
    console.info("GitLab Note Hook validated", {
      ...details,
      actorUsername: event.user.username,
      note: event.object_attributes.note,
      noteableType: event.object_attributes.noteable_type,
      system: event.object_attributes.system,
      headSha: event.merge_request.last_commit?.id ?? "",
    });
    if (
      event.object_attributes.system ||
      (this.config.gitlab.botUsername &&
        event.user.username.toLowerCase() === this.config.gitlab.botUsername.toLowerCase())
    ) {
      const reason = event.object_attributes.system ? "system_note" : "bot_note";
      console.info("GitLab webhook ignored", { ...details, reason });
      respondWebhook(response, 202, "", { ...details, reason });
      return;
    }
    if (!contains(this.config.gitlab.allowedProjectIds, event.project.id)) {
      console.warn("GitLab webhook rejected", { ...details, reason: "project_not_allowed" });
      respondWebhook(response, 403, "project is not allowed\n", {
        ...details,
        reason: "project_not_allowed",
      });
      return;
    }
    if (!contains(this.config.gitlab.allowedUserIds, event.user.id)) {
      console.warn("GitLab webhook rejected", { ...details, reason: "user_not_allowed" });
      respondWebhook(response, 403, "user is not allowed\n", {
        ...details,
        reason: "user_not_allowed",
      });
      return;
    }

    let command;
    try {
      command = parseCommand(event.object_attributes.note);
    } catch (error) {
      if (error instanceof NotCorvexCommandError) {
        console.info("GitLab webhook ignored", { ...details, reason: "not_corvex_command" });
        respondWebhook(response, 202, "", { ...details, reason: "not_corvex_command" });
        return;
      }
      console.warn("GitLab command rejected", { ...details, reason: "invalid_command" });
      await this.reply(response, event, errorMessage(error));
      return;
    }
    console.info("GitLab command recognized", { ...details, command: command.name });
    if (command.name === "explain" && command.args.length === 0) {
      console.warn("GitLab command rejected", { ...details, command: command.name, reason: "missing_path" });
      await this.reply(response, event, "Usage: `@corvex explain <path>`.");
      return;
    }
    if (
      (command.name === "explain" && command.args.length > 1) ||
      (command.args.length > 0 && command.name !== "fix" && command.name !== "explain")
    ) {
      console.warn("GitLab command rejected", {
        ...details,
        command: command.name,
        reason: "unexpected_arguments",
      });
      await this.reply(response, event, "This command does not accept arguments.");
      return;
    }

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
      if (result.job) {
        console.info(result.job.created ? "GitLab task enqueued" : "GitLab task already queued", {
          ...details,
          type: command.name,
          jobId: result.job.id,
        });
      } else if (result.delivered) {
        console.info("GitLab webhook duplicate delivery", { ...details, command: command.name });
      } else {
        const reason =
          command.name === "fix" && !this.config.fix.enabled
            ? "fix_disabled"
            : command.name === "fix" && !contains(this.config.fix.allowedUserIds, actorId)
              ? "fix_user_not_allowed"
              : "command_does_not_enqueue";
        console.info("GitLab command processed without enqueue", {
          ...details,
          command: command.name,
          reason,
        });
      }
      // 只有 GitLab 接受回复后才标记已送达，失败时才能通过 webhook 重投重试。
      if (!result.delivered) {
        await this.gitlab.postNote(projectId, mrIid, result.response);
        this.store.markDelivered(id);
        console.info("GitLab command response published", { ...details, command: command.name });
      }
      respondWebhook(response, 202, "", { ...details, command: command.name });
    } catch (error) {
      console.error("process GitLab command failed", { eventId: id, error: errorMessage(error) });
      respondWebhook(response, 500, "failed to process command\n", { ...details });
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
        console.info("GitLab command feedback published", {
          eventId: id,
          projectId: event.project.id,
          mrIid: event.merge_request.iid,
        });
      } else {
        console.info("GitLab webhook duplicate delivery", {
          eventId: id,
          projectId: event.project.id,
          mrIid: event.merge_request.iid,
        });
      }
      respondWebhook(response, 202, "", {
        eventId: id,
        projectId: event.project.id,
        mrIid: event.merge_request.iid,
      });
    } catch (error) {
      console.error("publish GitLab command response failed", { eventId: id, error: errorMessage(error) });
      respondWebhook(response, 502, "failed to publish command response\n", { eventId: id });
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
