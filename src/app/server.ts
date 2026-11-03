import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { CorvexConfig } from "../config/config.js";
import { JobStore } from "../jobs/store.js";
import { jobStatuses, jobTypes, type JobStatus, type JobType } from "../jobs/model.js";
import { parseCommand, NotCorvexCommandError } from "../gitlab/command.js";
import { GitLabClient, GitLabWriteError } from "../gitlab/client.js";
import { decodeGitLabNoteEvent, isIssueNoteEvent, MAX_WEBHOOK_BODY_BYTES, validateWebhookToken } from "../gitlab/webhook.js";
import { traceExecutionStep } from "../jobs/execution.js";

const maxReviewRequestCharacters = 2000;
const webhookDeliveryLeaseMs = 60_000;

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

function eventId(event: ReturnType<typeof decodeGitLabNoteEvent>): string {
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

  private respondTrackedWebhook(
    response: ServerResponse,
    status: number,
    body: string,
    deliveryId: string,
    eventId: string | null,
    details: Record<string, string | number | boolean> = {},
  ): void {
    this.store.recordExecutionEvent({
      deliveryId,
      eventId,
      jobId: typeof details.jobId === "string" && details.jobId ? details.jobId : null,
      step: "webhook.http_response",
      status: "succeeded",
      input: { status },
      output: { status, body, reason: details.reason ?? null, jobId: details.jobId ?? null },
    });
    respondWebhook(response, status, body, details);
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
      "/ops/trace.js": { file: "trace.js", contentType: "text/javascript; charset=utf-8" },
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
    const deliveryId = randomUUID();
    if (eventType !== "Note Hook") {
      console.warn("GitLab webhook rejected", { reason: "unsupported_event" });
      this.respondTrackedWebhook(response, 400, "unsupported event\n", deliveryId, null, { reason: "unsupported_event" });
      return;
    }
    let event: ReturnType<typeof decodeGitLabNoteEvent>;
    try {
      const body = await traceExecutionStep(
        this.store,
        { deliveryId },
        "webhook.read_body",
        { eventType, maxBytes: MAX_WEBHOOK_BODY_BYTES },
        () => requestBody(request),
        (value) => ({ bytes: value.byteLength }),
      );
      const bodyBytes = body.byteLength;
      event = await traceExecutionStep(
        this.store,
        { deliveryId },
        "webhook.decode",
        { eventType, bodyBytes },
        () => decodeGitLabNoteEvent(body),
        (value) => {
          const issue = isIssueNoteEvent(value);
          return {
            projectId: value.project.id,
            targetType: issue ? "issue" : "merge_request",
            targetIid: issue ? value.issue.iid : value.merge_request.iid,
            noteId: value.object_attributes.id,
            actorId: value.user.id,
            actorUsername: value.user.username,
            note: value.object_attributes.note,
            noteableType: value.object_attributes.noteable_type,
            system: value.object_attributes.system,
            headSha: issue ? "" : value.merge_request.last_commit?.id ?? "",
          };
        },
      );
    } catch (error) {
      const tooLarge = errorMessage(error).includes("exceeds 1 MiB");
      console.warn("GitLab webhook rejected", {
        reason: tooLarge ? "payload_too_large" : "invalid_payload",
      });
      this.respondTrackedWebhook(
        response,
        tooLarge ? 413 : 400,
        "invalid webhook payload\n",
        deliveryId,
        null,
        { reason: tooLarge ? "payload_too_large" : "invalid_payload" },
      );
      return;
    }
    const id = eventId(event);
    this.store.linkExecutionEventsToEvent(deliveryId, id);
    const isIssue = isIssueNoteEvent(event);
    const targetType = isIssue ? "issue" : "merge_request";
    const targetIid = isIssueNoteEvent(event) ? event.issue.iid : event.merge_request.iid;
    const details = {
      eventId: id,
      projectId: event.project.id,
      targetType,
      targetIid,
      noteId: event.object_attributes.id,
      actorId: event.user.id,
    };
    console.info("GitLab Note Hook validated", {
      ...details,
      actorUsername: event.user.username,
      noteableType: event.object_attributes.noteable_type,
      system: event.object_attributes.system,
      headSha: isIssueNoteEvent(event) ? "" : event.merge_request.last_commit?.id ?? "",
    });
    if (event.object_attributes.system) {
      const reason = "system_note";
      this.store.recordExecutionEvent({
        deliveryId,
        eventId: id,
        step: "webhook.filter",
        status: "ignored",
        input: { actorId: event.user.id, actorUsername: event.user.username, system: event.object_attributes.system },
        output: { reason },
      });
      console.info("GitLab webhook ignored", { ...details, reason });
      this.respondTrackedWebhook(response, 202, "", deliveryId, id, { ...details, reason });
      return;
    }
    if (!contains(this.config.gitlab.allowedProjectIds, event.project.id)) {
      console.warn("GitLab webhook rejected", { ...details, reason: "project_not_allowed" });
      this.store.recordExecutionEvent({
        deliveryId,
        eventId: id,
        step: "webhook.filter",
        status: "failed",
        input: { projectId: event.project.id },
        output: { allowed: false },
        errorDetail: "project_not_allowed",
      });
      this.respondTrackedWebhook(response, 403, "project is not allowed\n", deliveryId, id, {
        ...details,
        reason: "project_not_allowed",
      });
      return;
    }
    if (contains(this.config.gitlab.blockedUserIds, event.user.id)) {
      console.warn("GitLab webhook rejected", { ...details, reason: "user_blocked" });
      this.store.recordExecutionEvent({
        deliveryId,
        eventId: id,
        step: "webhook.filter",
        status: "failed",
        input: { actorId: event.user.id },
        output: { blocked: true },
        errorDetail: "user_blocked",
      });
      this.respondTrackedWebhook(response, 403, "user is blocked\n", deliveryId, id, {
        ...details,
        reason: "user_blocked",
      });
      return;
    }

    let command;
    try {
      command = await traceExecutionStep(
        this.store,
        { deliveryId, eventId: id },
        "webhook.parse_command",
        { note: event.object_attributes.note },
        () => parseCommand(event.object_attributes.note, this.config.gitlab.botUsername),
      );
    } catch (error) {
      if (error instanceof NotCorvexCommandError) {
        this.store.recordExecutionEvent({
          deliveryId,
          eventId: id,
          step: "webhook.command_filter",
          status: "ignored",
          input: { note: event.object_attributes.note },
          output: { reason: "not_corvex_command" },
        });
        console.info("GitLab webhook ignored", { ...details, reason: "not_corvex_command" });
        this.respondTrackedWebhook(response, 202, "", deliveryId, id, { ...details, reason: "not_corvex_command" });
        return;
      }
      console.warn("GitLab command rejected", { ...details, reason: "invalid_command" });
      await this.reply(response, event, errorMessage(error), deliveryId);
      return;
    }
    console.info("GitLab command recognized", { ...details, command: command.name });
    if ((isIssue && command.name !== "chat" && command.name !== "implement") || (!isIssue && command.name === "implement")) {
      const botUsername = this.config.gitlab.botUsername || "corvex";
      await this.reply(
        response,
        event,
        isIssue
          ? `Mention \`@${botUsername}\` with your question or request. Use \`/implement\` only when you explicitly want code changes.`
          : `The \`/implement\` command is only supported on Issues.`,
        deliveryId,
      );
      return;
    }
    if (command.name === "explain" && command.args.length === 0) {
      console.warn("GitLab command rejected", { ...details, command: command.name, reason: "missing_path" });
      this.store.recordExecutionEvent({
        deliveryId,
        eventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, args: command.args },
        output: { accepted: false },
        errorDetail: "missing_path",
      });
      const botUsername = this.config.gitlab.botUsername || "corvex";
      await this.reply(response, event, `Usage: \`@${botUsername} /explain <path>\`. `, deliveryId);
      return;
    }
    const reviewRequest = command.rawArgs.trim() ? command.rawArgs : "";
    const reviewRequestCharacters = [...reviewRequest].length;
    if ((command.name === "review" || command.name === "chat" || command.name === "implement") && reviewRequestCharacters > maxReviewRequestCharacters) {
      this.store.recordExecutionEvent({
        deliveryId,
        eventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, requestCharacters: reviewRequestCharacters },
        output: { accepted: false },
        errorDetail: `${command.name}_request_too_long`,
      });
      await this.reply(response, event, `Request must be ${maxReviewRequestCharacters} characters or fewer.`, deliveryId);
      return;
    }
    if (
      (command.name === "explain" && command.args.length > 1) ||
      ((command.name === "status" || command.name === "cancel") && command.args.length > 0)
    ) {
      console.warn("GitLab command rejected", {
        ...details,
        command: command.name,
        reason: "unexpected_arguments",
      });
      this.store.recordExecutionEvent({
        deliveryId,
        eventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, args: command.args },
        output: { accepted: false },
        errorDetail: "unexpected_arguments",
      });
      await this.reply(response, event, "This command does not accept arguments.", deliveryId);
      return;
    }

    this.store.recordExecutionEvent({
      deliveryId,
      eventId: id,
      step: "webhook.validate_command",
      status: "succeeded",
      input: { name: command.name, args: command.args },
      output: { accepted: true },
    });

    if (isIssueNoteEvent(event)) {
      const projectId = event.project.id;
      const issueIid = event.issue.iid;
      const actorId = event.user.id;
      try {
        const result = await traceExecutionStep(
          this.store,
          { deliveryId, eventId: id },
          "webhook.process_issue_request",
          { command: command.name, projectId, issueIid, actorId },
          () => this.store.createIssueImplementation(
            id,
            `${projectId}:issue:${issueIid}:note:${event.object_attributes.id}`,
            { projectId, issueIid, actorId, request: reviewRequest.trim() },
          ),
          (value) => ({ response: value.response, delivered: value.delivered, job: value.job ?? null }),
        );
        if (result.job) {
          console.info(result.job.created ? "GitLab task enqueued" : "GitLab task already queued", {
            ...details,
            type: "implement",
            jobId: result.job.id,
          });
        }
        if (!result.delivered) {
          const delivery = await this.publishWebhookResponse(
            deliveryId,
            id,
            projectId,
            issueIid,
            result.response,
            result.job?.id,
            "issue",
          );
          if (delivery === "in_progress") {
            this.respondTrackedWebhook(response, 503, "webhook response delivery is in progress\n", deliveryId, id, {
              ...details,
              retryable: true,
            });
            return;
          }
        }
        this.respondTrackedWebhook(response, 202, "", deliveryId, id, {
          ...details,
          command: command.name,
          jobId: result.job?.id ?? "",
        });
      } catch (error) {
        console.error("process GitLab issue command failed", { eventId: id, error: errorMessage(error) });
        this.respondTrackedWebhook(response, 500, "failed to process issue command\n", deliveryId, id, { ...details });
      }
      return;
    }

    const projectId = event.project.id;
    const mrIid = event.merge_request.iid;
    const actorId = event.user.id;
    const headSha = event.merge_request.last_commit?.id ?? "";
    try {
      const result = await traceExecutionStep(
        this.store,
        { deliveryId, eventId: id },
        "webhook.process_command",
        { command: command.name, args: command.args, projectId, mrIid, actorId, headSha },
        () => {
          switch (command.name) {
            case "review":
              return this.store.createReview(id, `${projectId}:${mrIid}:${id}`, {
                projectId,
                mrIid,
                headSha,
                actorId,
                request: reviewRequest,
              });
            case "chat":
              return this.store.createChat(id, `${projectId}:${mrIid}:chat:${id}`, {
                projectId,
                mrIid,
                headSha,
                actorId,
                request: command.rawArgs,
              });
            case "status":
              return this.store.status(id, projectId, mrIid);
            case "cancel":
              return this.store.cancel(id, projectId, mrIid, actorId);
            case "fix":
              return this.store.createFix(
                id,
                `${projectId}:${mrIid}:fix:${id}`,
                { projectId, mrIid, headSha, actorId, request: command.args.join(" ") },
                this.config.fix.enabled,
              );
            case "implement":
              throw new Error("Issue implementation command reached the merge request dispatcher");
            case "explain":
              return this.store.createExplain(id, `${projectId}:${mrIid}:explain:${id}`, {
                projectId,
                mrIid,
                headSha,
                actorId,
                request: command.args[0]!,
              });
          }
        },
        (value) => ({ response: value.response, delivered: value.delivered, job: value.job ?? null }),
      );
      if (result.job) {
        console.info(result.job.created ? "GitLab task enqueued" : "GitLab task already queued", {
          ...details,
          type: command.name,
          jobId: result.job.id,
        });
      } else if (result.delivered) {
        console.info("GitLab webhook duplicate delivery", { ...details, command: command.name });
      } else {
        const reason = command.name === "fix" && !this.config.fix.enabled
          ? "fix_disabled"
          : "command_does_not_enqueue";
        console.info("GitLab command processed without enqueue", {
          ...details,
          command: command.name,
          reason,
        });
      }
      // 只有 GitLab 接受回复后才标记已送达，失败时才能通过 webhook 重投重试。
      if (!result.delivered) {
        const delivery = await this.publishWebhookResponse(
          deliveryId,
          id,
          projectId,
          mrIid,
          result.response,
          result.job?.id,
        );
        if (delivery === "in_progress") {
          this.respondTrackedWebhook(response, 503, "webhook response delivery is in progress\n", deliveryId, id, {
            ...details,
            retryable: true,
          });
          return;
        }
        console.info("GitLab command response published", { ...details, command: command.name });
      }
      this.respondTrackedWebhook(response, 202, "", deliveryId, id, { ...details, command: command.name, jobId: result.job?.id ?? "" });
    } catch (error) {
      console.error("process GitLab command failed", { eventId: id, error: errorMessage(error) });
      this.respondTrackedWebhook(response, 500, "failed to process command\n", deliveryId, id, { ...details });
    }
  }

  private async reply(
    response: ServerResponse,
    event: ReturnType<typeof decodeGitLabNoteEvent>,
    message: string,
    deliveryId: string,
  ): Promise<void> {
    const id = eventId(event);
    const isIssue = isIssueNoteEvent(event);
    const targetType = isIssue ? "issue" : "merge_request";
    const targetIid = isIssue ? event.issue.iid : event.merge_request.iid;
    try {
      const result = await traceExecutionStep(
        this.store,
        { deliveryId, eventId: id },
        "webhook.record_response",
        {
          projectId: event.project.id,
          targetType,
          targetIid,
          body: message,
        },
        () => this.store.recordResponse(id, message),
        (value) => ({ response: value.response, delivered: value.delivered }),
      );
      if (!result.delivered) {
        const delivery = await this.publishWebhookResponse(
          deliveryId,
          id,
          event.project.id,
          targetIid,
          result.response,
          undefined,
          targetType,
        );
        if (delivery === "in_progress") {
          this.respondTrackedWebhook(response, 503, "webhook response delivery is in progress\n", deliveryId, id, {
            retryable: true,
          });
          return;
        }
        console.info("GitLab command feedback published", {
          eventId: id,
          projectId: event.project.id,
          targetIid,
        });
      } else {
        console.info("GitLab webhook duplicate delivery", {
          eventId: id,
          projectId: event.project.id,
          targetIid,
        });
      }
      this.respondTrackedWebhook(response, 202, "", deliveryId, id, {
        eventId: id,
        projectId: event.project.id,
        targetIid,
      });
    } catch (error) {
      console.error("publish GitLab command response failed", { eventId: id, error: errorMessage(error) });
      this.respondTrackedWebhook(response, 502, "failed to publish command response\n", deliveryId, id, { eventId: id });
    }
  }

  private async publishWebhookResponse(
    deliveryId: string,
    eventId: string,
    projectId: number,
    mrIid: number,
    body: string,
    jobId?: string,
    targetType: "merge_request" | "issue" = "merge_request",
  ): Promise<"delivered" | "in_progress"> {
    const claim = this.store.claimWebhookDelivery(eventId, webhookDeliveryLeaseMs);
    if (claim.status !== "claimed") return claim.status;
    const context = { deliveryId, eventId, jobId: jobId ?? null };
    try {
      await traceExecutionStep(
        this.store,
        context,
        "gitlab.post_note",
        { projectId, mrIid, body },
        () => targetType === "issue"
          ? this.gitlab.postIssueNote(projectId, mrIid, body)
          : this.gitlab.postNote(projectId, mrIid, body),
        (receipt) => receipt,
        (error) => error instanceof GitLabWriteError && error.outcomeUnknown ? "unknown" : "failed",
      );
      await traceExecutionStep(
        this.store,
        context,
        "webhook.mark_delivered",
        { eventId },
        () => this.store.markDelivered(eventId, claim.token),
        () => ({ delivered: true }),
      );
      return "delivered";
    } catch (error) {
      if (!(error instanceof GitLabWriteError && error.outcomeUnknown)) {
        this.store.releaseWebhookDelivery(eventId, claim.token);
      }
      throw error;
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
