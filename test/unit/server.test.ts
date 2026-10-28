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
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const fakeGitLab = createServer((request, response) => {
      if (request.method === "POST" && request.url?.endsWith("/notes")) {
        postedNotes++;
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
        allowedUserIds: [2],
        botUsername: "corvex-bot",
      },
      storage: {
        root: ".",
        database: ":memory:",
        retentionDays: 90,
        auditRetentionDays: 365,
      },
      agent: {
        enabled: false,
        baseUrl: "https://api.openai.com/v1",
        model: "",
        apiKey: "",
        requestTimeout: 120000,
        maxOutputTokens: 4096,
        dailyTokenBudget: 0,
        mcpEnabled: false,
        webEnabled: true,
        webBlockedHosts: [],
        skillPaths: [],
      },
      review: { maxFiles: 100, maxFindings: 30, maxContextBytes: 2 << 20 },
      worker: { pollInterval: 2000, jobTimeout: 30 * 60_000 },
      fix: { enabled: false, allowedUserIds: [], maxPatchBytes: 128 << 10 },
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
      expect((await fetch(`${base}/webhooks/gitlab`, { method: "POST" })).status).toBe(401);

      const payload = {
        object_kind: "note",
        user: { id: 2, username: "developer" },
        project: { id: 1 },
        object_attributes: {
          id: 99,
          note: "@corvex review",
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
      expect((await send()).status).toBe(202);
      expect((await send()).status).toBe(202);
      expect(store.jobCounts().queued).toBe(1);
      expect(postedNotes).toBe(1);
      expect(info).toHaveBeenCalledWith(
        "GitLab webhook received",
        expect.objectContaining({ eventType: "Note Hook" }),
      );
      expect(info).toHaveBeenCalledWith(
        "GitLab Note Hook validated",
        expect.objectContaining({
          actorUsername: "developer",
          note: "@corvex review",
          system: false,
        }),
      );
      expect(info).toHaveBeenCalledWith(
        "GitLab task enqueued",
        expect.objectContaining({ eventId: "1:99", projectId: 1, mrIid: 10, type: "review" }),
      );

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

      config.fix.enabled = true;
      config.fix.allowedUserIds = [2];
      const fixPayload = {
        ...payload,
        object_attributes: {
          ...payload.object_attributes,
          id: 100,
          note: "@corvex fix handle this error more gracefully",
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

      const jobsResponse = await fetch(`${base}/api/ops/jobs?status=queued&limit=1`, {
        headers: { authorization },
      });
      expect(jobsResponse.status).toBe(200);
      const jobs = (await jobsResponse.json()) as { items: Array<{ id: string }>; total: number };
      expect(jobs.total).toBe(2);
      expect(jobs.items).toHaveLength(1);
      const detailResponse = await fetch(`${base}/api/ops/jobs/${jobs.items[0]!.id}`, {
        headers: { authorization },
      });
      expect(detailResponse.status).toBe(200);
      expect(await detailResponse.json()).toMatchObject({
        status: "queued",
        attempts: [],
        trajectory: [],
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
