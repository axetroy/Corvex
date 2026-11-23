import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWebFile, downloadRoot } from "../../src/agent/web-download.ts";
import type { WebFetchDependencies } from "../../src/agent/web-read.ts";

const publicAddress = { address: "93.184.216.34", family: 4 };

function dependencies(body: Buffer, contentType = "application/octet-stream"): WebFetchDependencies {
  return {
    resolve: vi.fn(async () => [publicAddress]),
    request: vi.fn(async () => ({ status: 200, contentType, body })),
  };
}

describe("web_download", () => {
  let directory = "";

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("writes binary content under the controlled download directory", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-download-"));
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const deps = dependencies(body, "image/png");
    const result = await downloadWebFile("https://cdn.corp.dev/logo.png", "logo.png", {
      workspacePath: directory,
      dependencies: deps,
    });
    expect(result.path).toBe(`${downloadRoot}/logo.png`);
    expect(result.bytes).toBe(body.byteLength);
    expect(result.contentType).toBe("image/png");
    expect(await readFile(join(directory, downloadRoot, "logo.png"))).toEqual(body);
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it("refuses executable file types and paths outside the worktree", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-download-"));
    await expect(downloadWebFile("https://cdn.corp.dev/tool.exe", "tool.exe", {
      workspacePath: directory,
      dependencies: dependencies(Buffer.from("x")),
    })).rejects.toThrow("executable file type");
    await expect(downloadWebFile("https://cdn.corp.dev/x.png", "../escape.png", {
      workspacePath: directory,
      dependencies: dependencies(Buffer.from("x")),
    })).rejects.toThrow("invalid repository-relative path");
  });

  it("applies the same host blocking as web_fetch", async () => {
    directory = await mkdtemp(join(tmpdir(), "corvex-download-"));
    await expect(downloadWebFile("https://private.corp.dev/x.png", "x.png", {
      workspacePath: directory,
      blockedHosts: ["corp.dev"],
      dependencies: dependencies(Buffer.from("x")),
    })).rejects.toThrow("non-blocked DNS host");
  });
});
