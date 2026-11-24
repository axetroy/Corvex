import { createServer, type Server } from "node:http";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitManager, type Workspace } from "../../src/git/manager.js";

const run = promisify(execFileCallback);

/** 本地 git http-backend，提供只读/可推送的 http 远端，不依赖外网。 */
async function startGitHttp(reposRoot: string): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: reposRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.searchParams.toString(),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
        CONTENT_LENGTH: String(request.headers["content-length"] ?? 0),
      },
    });
    let buffer = Buffer.alloc(0);
    let headersSent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return;
      headersSent = true;
      const head = buffer.subarray(0, split).toString();
      const status = /^Status:\s*(\d+)/im.exec(head);
      response.statusCode = status ? Number(status[1]) : 200;
      for (const line of head.split("\r\n")) {
        const match = /^([^:]+):\s*(.*)$/.exec(line);
        if (match && !/^status$/i.test(match[1])) response.setHeader(match[1].trim(), match[2].trim());
      }
      const body = buffer.subarray(split + 4);
      if (body.length) response.write(body);
    });
    child.stdout.on("end", () => response.end());
    child.stderr.on("data", () => undefined);
    request.pipe(child.stdin);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function commitAll(path: string, file: string, content: string): Promise<string> {
  await writeFile(join(path, file), content);
  await run("git", ["-C", path, "add", "-A"]);
  await run("git", ["-C", path, "commit", "-q", "-m", `update ${file}`]);
  return (await run("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
}

describe("Git push recovery", () => {
  let cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    cleanup = [];
  });

  it("recovers a non-fast-forward push via sync + pull + rebase instead of looping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "corvex-push-recovery-"));
    const reposRoot = join(dir, "repos");
    const root = join(dir, "storage");
    await mkdir(reposRoot, { recursive: true });

    const remote = join(reposRoot, "project.git");
    await run("git", ["init", "-q", "--bare", remote]);
    await run("git", ["--git-dir", remote, "config", "http.receivepack", "true"]);
    const { port, close } = await startGitHttp(reposRoot);
    cleanup.push(close);
    const baseUrl = `http://127.0.0.1:${port}`;
    const url = `${baseUrl}/project.git`;

    // 建立远端 master 基线。
    const seed = join(dir, "seed");
    await run("git", ["clone", "-q", url, seed]);
    await run("git", ["-C", seed, "config", "user.email", "test@example.com"]);
    await run("git", ["-C", seed, "config", "user.name", "test"]);
    const baseSha = await commitAll(seed, "a.txt", "base\n");
    await run("git", ["-C", seed, "push", "-q", "origin", "master"]);

    const manager = new GitManager(root, baseUrl);
    await manager.initialize();
    const workspace = await manager.prepareConversationWorkspace(7, "a1111111-1111-4111-8111-111111111111", url, baseSha);
    const bound: Workspace = workspace;
    await run("git", ["-C", bound.path, "config", "user.email", "test@example.com"]);
    await run("git", ["-C", bound.path, "config", "user.name", "test"]);

    // 本轮在 worktree 里写入测试并提交，得到待推送的本地提交。
    await writeFile(join(bound.path, "b.test.ts"), "test\n");
    await run("git", ["-C", bound.path, "add", "-A"]);
    await run("git", ["-C", bound.path, "commit", "-q", "-m", "add tests"]);
    const localSha = (await run("git", ["-C", bound.path, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();

    // 远端分支在 meanwhile 被推进，制造非快进场景。
    await commitAll(seed, "remote.txt", "remote\n");
    await run("git", ["-C", seed, "push", "-q", "origin", "master"]);
    await run("git", ["-C", seed, "push", "-q", "origin", `master:fix/asar`]);

    // 第一次推送应被拒，并给出明确的恢复指引（而不是含糊的非快进错误）。
    await expect(manager.pushBranchToGitLab(7, localSha, "fix/asar", undefined, "token"))
      .rejects.toThrow(/has advanced|rebase onto origin\/fix\/asar/);

    // sync + pull 后 origin/fix/asar 可用，模型可 rebase 恢复。
    const synced = await manager.syncMirrorFromGitLab(7, undefined, "token");
    expect(synced.branches).toContain("fix/asar");
    await manager.fetchFromMirror(bound, undefined, "token");
    const remoteTip = (await run("git", ["-C", bound.path, "rev-parse", "origin/fix/asar"], { encoding: "utf8" })).stdout.trim();
    expect(remoteTip).toMatch(/^[0-9a-f]{40}$/);

    // rebase 到最新远端分支后再次推送成功，闭环。
    await manager.rebaseWorktree(bound, "origin/fix/asar");
    const rebased = (await run("git", ["-C", bound.path, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
    await expect(manager.pushBranchToGitLab(7, rebased, "fix/asar", undefined, "token"))
      .resolves.toMatchObject({ branch: "fix/asar", sha: rebased });
  }, 30_000);
});
