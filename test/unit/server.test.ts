import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { CorvexServer } from "../../src/app/server.js";
import type { CorvexConfig } from "../../src/config/config.js";
import { JobStore } from "../../src/jobs/store.js";
import { GitLabClient } from "../../src/gitlab/client.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");
  return address.port;
}

describe("CorvexServer", () => {
  it("authenticates and queues a GitLab command idempotently", async () => {
    let postedNotes = 0;
    let pausePostNotes = false;
    let notifyPostStarted!: () => void;
    let releasePostNote!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      notifyPostStarted = resolve;
    });
    const postGate = new Promise<void>((resolve) => {
      releasePostNote = resolve;
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fakeGitLab = createServer(async (request, response) => {
      if (request.method === "POST" && request.url?.endsWith("/notes")) {
        postedNotes++;
        if (pausePostNotes) {
          notifyPostStarted();
          await postGate;
        }
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: 1 }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    const gitlabPort = await listen(fakeGitLab);
    const store = await JobStore.open(":memory:");
    const config: CorvexConfig = {
      server: { listen: "127.0.0.1:0", readTimeout: 5000, shutdownTimeout: 5000 },
      operations: { username: "operator", password: "a secure password with 16 chars" },
      gitlab: {
        baseUrl: `http://127.0.0.1:${gitlabPort}`,
        readToken: "read",
        writeToken: "write",
        webhookSecret: "secret",
        allowedProjectIds: [1],
        blockedUserIds: [3],
        botUsername: "corvex-bot",
      },
      storage: {
        root: ".",
        database: ":memory:",
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        responseLanguage: "en",
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
        model: "",
        apiKey: "",
        requestTimeout: 120000,
        sessionTimeout: 30 * 60_000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        mcpEnabled: false,
        webEnabled: true,
        webBlockedHosts: [],
        skillPaths: [],
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20, batchConcurrency: 2 },
      worker: { pollInterval: 2000, jobTimeout: 30 * 60_000 },
      fix: { enabled: false, maxPatchBytes: 128 << 10 },
      issue: { implementEnabled: false, historyComments: 20 },
    };
    const controller = new AbortController();
    const application = new CorvexServer(
      config,
      store,
      new GitLabClient(config.gitlab.baseUrl, "", "write"),
    );
    const running = application.run(controller.signal);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          application.getListeningAddress();
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const address = application.getListeningAddress();
      const base = `http://127.0.0.1:${address.port}`;
      const authorization = `Basic ${Buffer.from(
        `${config.operations.username}:${config.operations.password}`,
      ).toString("base64")}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      config.operations.username = "";
      config.operations.password = "";
      expect((await fetch(`${base}/ops`)).status).toBe(404);
      config.operations.username = "operator";
      config.operations.password = "a secure password with 16 chars";
      expect((await fetch(`${base}/api/ops/overview`)).status).toBe(401);
      const rejected = await fetch(`${base}/api/ops/overview`, {
        headers: { authorization: `Basic ${Buffer.from("operator:wrong").toString("base64")}` },
      });
      expect(rejected.status).toBe(401);
      expect(rejected.headers.get("www-authenticate")).toContain("Basic");
      expect((await fetch(`${base}/api/ops/overview`, { headers: { authorization } })).status).toBe(200);
      expect(
        (await fetch(`${base}/api/ops/overview`, { method: "POST", headers: { authorization } })).status,
      ).toBe(405);
      const dashboard = await fetch(`${base}/ops`, { headers: { authorization } });
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain('id="language"');
      expect(
        (await fetch(`${base}/ops/app.js`, { headers: { authorization } })).status,
      ).toBe(200);
      expect(
        (await fetch(`${base}/ops/i18n.js`, { headers: { authorization } })).status,
      ).toBe(200);
      expect(
        (await fetch(`${base}/ops/trace.js`, { headers: { authorization } })).status,
      ).toBe(200);
      expect((await fetch(`${base}/webhooks/gitlab`, { method: "POST" })).status).toBe(401);

      const payload = {
        object_kind: "note",
        user: { id: 99, username: "developer" },
        project: { id: 1 },
        object_attributes: {
          id: 99,
          note: "@corvex-bot /review\n重点检查安全与代码质量\n\n请按示例核对：\n  输入：  user input\n  输出：validated value",
          noteable_type: "MergeRequest",
          system: false,
        },
        merge_request: { iid: 10, last_commit: { id: "a".repeat(40) } },
      };
      const send = () =>
        fetch(`${base}/webhooks/gitlab`, {
          method: "POST",
          headers: {
            "x-gitlab-token": "secret",
            "x-gitlab-event": "Note Hook",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      pausePostNotes = true;
      const activeDelivery = send();
      await postStarted;
      expect((await send()).status).toBe(503);
      releasePostNote();
      expect((await activeDelivery).status).toBe(202);
      pausePostNotes = false;
      expect((await send()).status).toBe(202);
      expect(store.jobCounts().queued).toBe(1);
      expect(postedNotes).toBe(1);
      expect(info).toHaveBeenCalledWith(
        "GitLab webhook received",
        expect.objectContaining({ eventType: "Note Hook" }),
      );
      expect(info).not.toHaveBeenCalledWith("GitLab webhook body", expect.anything());
      expect(JSON.stringify(info.mock.calls)).not.toContain("x-gitlab-token");
      expect(JSON.stringify(info.mock.calls)).not.toContain("@corvex-bot /review");
      expect(info).toHaveBeenCalledWith(
        "GitLab Note Hook validated",
        expect.objectContaining({
          actorUsername: "developer",
          system: false,
        }),
      );
      expect(info).toHaveBeenCalledWith(
        "GitLab task enqueued",
        expect.objectContaining({
          eventId: "1:99",
          projectId: 1,
          targetType: "merge_request",
          targetIid: 10,
          type: "review",
        }),
      );
      const reviewJob = store.listJobs("queued", 10).find((job) => job.type === "review");
      if (!reviewJob) throw new Error("expected a review job");
      expect(reviewJob.request).toBe("重点检查安全与代码质量\n\n请按示例核对：\n  输入：  user input\n  输出：validated value");
      const webhookSteps = store.getJobDetails(reviewJob.id)?.events ?? [];
      expect(webhookSteps.map((step) => step.step)).toEqual(expect.arrayContaining([
        "webhook.read_body",
        "webhook.decode",
        "webhook.parse_command",
        "webhook.validate_command",
        "webhook.process_command",
        "gitlab.post_note",
        "webhook.mark_delivered",
        "webhook.http_response",
      ]));
      expect(new Set(webhookSteps.map((step) => step.deliveryId)).size).toBe(3);
      expect(JSON.stringify(webhookSteps)).not.toContain("secret");

      const ignoredResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          object_attributes: {
            ...payload.object_attributes,
            id: 101,
            note: "ordinary comment",
          },
        }),
      });
      expect(ignoredResponse.status).toBe(202);
      expect(store.jobCounts().queued).toBe(1);
      expect(info).toHaveBeenCalledWith(
        "GitLab webhook ignored",
        expect.objectContaining({ eventId: "1:101", reason: "not_corvex_command" }),
      );

      const unauthorizedBotResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          user: { id: 3, username: "corvex-bot" },
          object_attributes: {
            ...payload.object_attributes,
            id: 102,
            note: "@corvex-bot /review",
          },
        }),
      });
      expect(unauthorizedBotResponse.status).toBe(403);
      expect(store.jobCounts().queued).toBe(1);

      config.fix.enabled = true;
      const fixPayload = {
        ...payload,
        user: { id: 99, username: "developer" },
        object_attributes: {
          ...payload.object_attributes,
          id: 100,
          note: "@corvex-bot /fix handle this error more gracefully",
        },
      };
      const fixResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify(fixPayload),
      });
      expect(fixResponse.status).toBe(202);
      expect(store.jobCounts().queued).toBe(2);
      expect(postedNotes).toBe(2);

      const chatRequest = "总结这个 PR\n\n再建议一个标题";
      const chatResponse = await fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          object_attributes: {
            ...payload.object_attributes,
            id: 103,
            note: `@corvex-bot ${chatRequest}`,
          },
        }),
      });
      expect(chatResponse.status).toBe(202);
      expect(store.jobCounts().queued).toBe(3);
      expect(postedNotes).toBe(3);
      expect(store.listJobs("queued", 10).find((job) => job.type === "chat")?.request).toBe(chatRequest);

      const issuePayload = {
        object_kind: "note",
        user: { id: 99, username: "developer" },
        project: { id: 1 },
        object_attributes: {
          id: 104,
          note: "@corvex-bot Is implementing the requested labels feasible?",
          noteable_type: "Issue",
          system: false,
        },
        issue: { iid: 17 },
      };
      const sendIssue = (noteId: number) => fetch(`${base}/webhooks/gitlab`, {
        method: "POST",
        headers: {
          "x-gitlab-token": "secret",
          "x-gitlab-event": "Note Hook",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...issuePayload,
          object_attributes: {
            ...issuePayload.object_attributes,
            id: noteId,
            note: noteId === 104
              ? issuePayload.object_attributes.note
              : "@corvex-bot /implement Add issue labels",
          },
        }),
      });
      expect((await sendIssue(104)).status).toBe(202);
      const assistantJob = store.listJobs("queued", 10).find((job) => job.type === "implement");
      expect(assistantJob?.request).toBe("Is implementing the requested labels feasible?");
      config.issue.implementEnabled = true;
      const enabledIssueResponse = await sendIssue(105);
      expect(enabledIssueResponse.status).toBe(202);
      const implementationJob = store.listJobs("queued", 10).find((job) => job.request === "Add issue labels");
      expect(implementationJob).toMatchObject({
        targetType: "issue",
        targetIid: 17,
        mrIid: 0,
        request: "Add issue labels",
      });
      expect(postedNotes).toBe(5);

      const jobsResponse = await fetch(`${base}/api/ops/jobs?status=queued&limit=1`, {
        headers: { authorization },
      });
      expect(jobsResponse.status).toBe(200);
      const jobs = (await jobsResponse.json()) as { items: Array<{ id: string }>; total: number };
      expect(jobs.total).toBe(5);
      expect(jobs.items).toHaveLength(1);
      store.startJobTrace(jobs.items[0]!.id, 1, "llm", "review", "test/model", "review prompt");
      const failedTrace = store.startJobTrace(
        jobs.items[0]!.id,
        1,
        "tool",
        "read_file",
        "",
        '{"path":"missing.vue"}',
      );
      store.finishJobTrace(failedTrace, "failed", 5, undefined, undefined, "ENOENT: file not found");
      const detailResponse = await fetch(`${base}/api/ops/jobs/${jobs.items[0]!.id}`, {
        headers: { authorization },
      });
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        status: "queued",
        attempts: [],
        events: expect.arrayContaining([
          expect.objectContaining({ step: "webhook.decode", deliveryId: expect.any(String), jobId: jobs.items[0]!.id }),
          expect.objectContaining({ step: "webhook.http_response", status: "succeeded", jobId: jobs.items[0]!.id }),
        ]),
        trajectory: [
          expect.objectContaining({ kind: "tool", errorDetail: "ENOENT: file not found" }),
          expect.objectContaining({ kind: "llm", rawContent: "review prompt" }),
        ],
      });
      expect(
        (await fetch(`${base}/api/ops/jobs?status=invalid`, { headers: { authorization } })).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${base}/api/ops/jobs?search=${"x".repeat(101)}`, {
            headers: { authorization },
          })
        ).status,
      ).toBe(400);
    } finally {
      controller.abort();
      await running;
      store.close();
      await new Promise<void>((resolve, reject) =>
        fakeGitLab.close((error) => (error ? reject(error) : resolve())),
      );
      info.mockRestore();
    }
  });
});
