import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CorvexConfig } from "../../config/config.js";
import type { EventStore } from "../../events/store.js";
import { errorMessage } from "../../errors.js";
import { traceExecutionStep } from "../../events/execution.js";
import { GitLabClient, GitLabWriteError } from "../../gitlab/client.js";
import { NotCorvexCommandError, parseCommand } from "../../gitlab/command.js";
import {
  decodeGitLabNoteEvent,
  isIssueNoteEvent,
  MAX_WEBHOOK_BODY_BYTES,
  validateWebhookToken,
  type IssueNoteEvent,
  type NoteEvent,
} from "../../gitlab/webhook.js";
import { headerValue, sendWebhook } from "./respond.js";

const maxReviewRequestCharacters = 2000;
const webhookDeliveryLeaseMs = 60_000;

type WebhookNoteEvent = NoteEvent | IssueNoteEvent;

function webhookEventId(event: WebhookNoteEvent): string {
  return `${event.project.id}:${event.object_attributes.id}`;
}

/** 接收 GitLab Note Hook：鉴权、解析命令、创建幂等事件并发布回复。 */
export class WebhookHandler {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    private readonly gitlab: GitLabClient,
    /** 事件入队后的回调：唤醒内联执行器，避免等待兜底轮询。 */
    private readonly onEventQueued?: () => void,
  ) {}

  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const eventType = headerValue(request.headers, "x-gitlab-event");
    console.info("GitLab webhook received", {
      eventType: eventType === "Note Hook" ? eventType : eventType ? "unsupported" : "missing",
    });
    if (!validateWebhookToken(this.config.gitlab.webhookSecret, headerValue(request.headers, "x-gitlab-token"))) {
      console.warn("GitLab webhook rejected", { reason: "invalid_token" });
      sendWebhook(reply, 401, "unauthorized\n", { reason: "invalid_token" });
      return;
    }
    const deliveryId = randomUUID();
    if (eventType !== "Note Hook") {
      console.warn("GitLab webhook rejected", { reason: "unsupported_event" });
      this.respondTrackedWebhook(reply, 400, "unsupported event\n", deliveryId, null, {
        reason: "unsupported_event",
      });
      return;
    }
    // Fastify 已按原始字节读取请求体；这里只做大小与结构解析，并保留执行轨迹。
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    let event: WebhookNoteEvent;
    try {
      const bodyBytes = body.byteLength;
      const decodedObject = await traceExecutionStep(
        this.store,
        { deliveryId },
        "webhook.read_body",
        { eventType, maxBytes: MAX_WEBHOOK_BODY_BYTES },
        async () => body,
        (value) => ({ bytes: value.byteLength }),
      );
      event = await traceExecutionStep(
        this.store,
        { deliveryId },
        "webhook.decode",
        { eventType, bodyBytes },
        () => decodeGitLabNoteEvent(decodedObject),
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
        reply,
        tooLarge ? 413 : 400,
        "invalid webhook payload\n",
        deliveryId,
        null,
        { reason: tooLarge ? "payload_too_large" : "invalid_payload" },
      );
      return;
    }
    const id = webhookEventId(event);
    this.store.linkExecutionStepsToEvent(deliveryId, id);
    const isIssue = isIssueNoteEvent(event);
    const targetType = isIssue ? "issue" : "merge_request";
    const targetIid = isIssueNoteEvent(event) ? event.issue.iid : event.merge_request.iid;
    const details = {
      webhookEventId: id,
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
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.filter",
        status: "ignored",
        input: { actorId: event.user.id, actorUsername: event.user.username, system: event.object_attributes.system },
        output: { reason },
      });
      console.info("GitLab webhook ignored", { ...details, reason });
      this.respondTrackedWebhook(reply, 202, "", deliveryId, id, { ...details, reason });
      return;
    }
    if (this.config.gitlab.blockedUserIds.includes(event.user.id)) {
      console.warn("GitLab webhook rejected", { ...details, reason: "user_blocked" });
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.filter",
        status: "failed",
        input: { actorId: event.user.id },
        output: { blocked: true },
        errorDetail: "user_blocked",
      });
      this.respondTrackedWebhook(reply, 403, "user is blocked\n", deliveryId, id, {
        ...details,
        reason: "user_blocked",
      });
      return;
    }

    let command;
    try {
      command = await traceExecutionStep(
        this.store,
        { deliveryId, webhookEventId: id },
        "webhook.parse_command",
        { note: event.object_attributes.note },
        () => parseCommand(event.object_attributes.note, this.config.gitlab.botUsername),
      );
    } catch (error) {
      if (error instanceof NotCorvexCommandError) {
        this.store.recordExecutionStep({
          deliveryId,
          webhookEventId: id,
          step: "webhook.command_filter",
          status: "ignored",
          input: { note: event.object_attributes.note },
          output: { reason: "not_corvex_command" },
        });
        console.info("GitLab webhook ignored", { ...details, reason: "not_corvex_command" });
        this.respondTrackedWebhook(reply, 202, "", deliveryId, id, { ...details, reason: "not_corvex_command" });
        return;
      }
      console.warn("GitLab command rejected", { ...details, reason: "invalid_command" });
      await this.reply(reply, event, errorMessage(error), deliveryId);
      return;
    }
    console.info("GitLab command recognized", { ...details, command: command.name });
    if ((isIssue && command.name !== "chat" && command.name !== "implement") || (!isIssue && command.name === "implement")) {
      const botUsername = this.config.gitlab.botUsername || "corvex";
      await this.reply(
        reply,
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
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, args: command.args },
        output: { accepted: false },
        errorDetail: "missing_path",
      });
      const botUsername = this.config.gitlab.botUsername || "corvex";
      await this.reply(reply, event, `Usage: \`@${botUsername} /explain <path>\`. `, deliveryId);
      return;
    }
    const reviewRequest = command.rawArgs.trim() ? command.rawArgs : "";
    const reviewRequestCharacters = [...reviewRequest].length;
    if ((command.name === "review" || command.name === "chat" || command.name === "implement") && reviewRequestCharacters > maxReviewRequestCharacters) {
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, requestCharacters: reviewRequestCharacters },
        output: { accepted: false },
        errorDetail: `${command.name}_request_too_long`,
      });
      await this.reply(reply, event, `Request must be ${maxReviewRequestCharacters} characters or fewer.`, deliveryId);
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
      this.store.recordExecutionStep({
        deliveryId,
        webhookEventId: id,
        step: "webhook.validate_command",
        status: "failed",
        input: { name: command.name, args: command.args },
        output: { accepted: false },
        errorDetail: "unexpected_arguments",
      });
      await this.reply(reply, event, "This command does not accept arguments.", deliveryId);
      return;
    }

    this.store.recordExecutionStep({
      deliveryId,
      webhookEventId: id,
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
          { deliveryId, webhookEventId: id },
          "webhook.process_issue_request",
          { command: command.name, projectId, issueIid, actorId },
          () => this.store.createIssueImplementation(
            id,
            `${projectId}:issue:${issueIid}:note:${event.object_attributes.id}`,
            { projectId, issueIid, actorId, request: reviewRequest.trim() },
          ),
          (value) => ({ response: value.response, delivered: value.delivered, event: value.event ?? null }),
        );
        if (result.event) {
          console.info(result.event.created ? "GitLab task enqueued" : "GitLab task already queued", {
            ...details,
            type: "implement",
            eventId: result.event.id,
          });
          if (result.event.created) this.onEventQueued?.();
        }
        if (!result.delivered) {
          const delivery = await this.publishWebhookResponse(
            deliveryId,
            id,
            projectId,
            issueIid,
            result.response,
            result.event?.id,
            "issue",
          );
          if (delivery === "in_progress") {
            this.respondTrackedWebhook(reply, 503, "webhook response delivery is in progress\n", deliveryId, id, {
              ...details,
              retryable: true,
            });
            return;
          }
        }
        this.respondTrackedWebhook(reply, 202, "", deliveryId, id, {
          ...details,
          command: command.name,
          eventId: result.event?.id ?? "",
        });
      } catch (error) {
        console.error("process GitLab issue command failed", { webhookEventId: id, error: errorMessage(error) });
        this.respondTrackedWebhook(reply, 500, "failed to process issue command\n", deliveryId, id, { ...details });
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
        { deliveryId, webhookEventId: id },
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
        (value) => ({ response: value.response, delivered: value.delivered, event: value.event ?? null }),
      );
      if (result.event) {
        console.info(result.event.created ? "GitLab task enqueued" : "GitLab task already queued", {
          ...details,
          type: command.name,
          eventId: result.event.id,
        });
        if (result.event.created) this.onEventQueued?.();
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
          result.event?.id,
        );
        if (delivery === "in_progress") {
          this.respondTrackedWebhook(reply, 503, "webhook response delivery is in progress\n", deliveryId, id, {
            ...details,
            retryable: true,
          });
          return;
        }
        console.info("GitLab command response published", { ...details, command: command.name });
      }
      this.respondTrackedWebhook(reply, 202, "", deliveryId, id, {
        ...details,
        command: command.name,
        eventId: result.event?.id ?? "",
      });
    } catch (error) {
      console.error("process GitLab command failed", { webhookEventId: id, error: errorMessage(error) });
      this.respondTrackedWebhook(reply, 500, "failed to process command\n", deliveryId, id, { ...details });
    }
  }

  private respondTrackedWebhook(
    reply: FastifyReply,
    status: number,
    body: string,
    deliveryId: string,
    webhookEventId: string | null,
    details: Record<string, string | number | boolean> = {},
  ): void {
    this.store.recordExecutionStep({
      deliveryId,
      webhookEventId,
      eventId: typeof details.eventId === "string" && details.eventId ? details.eventId : null,
      step: "webhook.http_response",
      status: "succeeded",
      input: { status },
      output: { status, body, reason: details.reason ?? null, eventId: details.eventId ?? null },
    });
    sendWebhook(reply, status, body, details);
  }

  private async reply(
    reply: FastifyReply,
    event: WebhookNoteEvent,
    message: string,
    deliveryId: string,
  ): Promise<void> {
    const id = webhookEventId(event);
    const isIssue = isIssueNoteEvent(event);
    const targetType = isIssue ? "issue" : "merge_request";
    const targetIid = isIssue ? event.issue.iid : event.merge_request.iid;
    try {
      const result = await traceExecutionStep(
        this.store,
        { deliveryId, webhookEventId: id },
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
          this.respondTrackedWebhook(reply, 503, "webhook response delivery is in progress\n", deliveryId, id, {
            retryable: true,
          });
          return;
        }
        console.info("GitLab command feedback published", {
          webhookEventId: id,
          projectId: event.project.id,
          targetIid,
        });
      } else {
        console.info("GitLab webhook duplicate delivery", {
          webhookEventId: id,
          projectId: event.project.id,
          targetIid,
        });
      }
      this.respondTrackedWebhook(reply, 202, "", deliveryId, id, {
        webhookEventId: id,
        projectId: event.project.id,
        targetIid,
      });
    } catch (error) {
      console.error("publish GitLab command response failed", { webhookEventId: id, error: errorMessage(error) });
      this.respondTrackedWebhook(reply, 502, "failed to publish command response\n", deliveryId, id, { webhookEventId: id });
    }
  }

  private async publishWebhookResponse(
    deliveryId: string,
    webhookEventId: string,
    projectId: number,
    mrIid: number,
    body: string,
    eventId?: string,
    targetType: "merge_request" | "issue" = "merge_request",
  ): Promise<"delivered" | "in_progress"> {
    const claim = this.store.claimWebhookDelivery(webhookEventId, webhookDeliveryLeaseMs);
    if (claim.status !== "claimed") return claim.status;
    const context = { deliveryId, webhookEventId, eventId: eventId ?? null };
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
        { webhookEventId },
        () => this.store.markDelivered(webhookEventId, claim.token),
        () => ({ delivered: true }),
      );
      return "delivered";
    } catch (error) {
      if (!(error instanceof GitLabWriteError && error.outcomeUnknown)) {
        this.store.releaseWebhookDelivery(webhookEventId, claim.token);
      }
      throw error;
    }
  }
}

/** 注册 GitLab Note Hook 路由；请求体按原始字节读取，供校验与解析使用。 */
export function registerWebhookRoute(app: FastifyInstance, handler: WebhookHandler): void {
  app.post(
    "/webhooks/gitlab",
    // 多读一个字节，让超限 1 字节的请求进入处理器并留下执行轨迹。
    { bodyLimit: MAX_WEBHOOK_BODY_BYTES + 1 },
    async (request, reply) => {
      await handler.handle(request, reply);
    },
  );
}
