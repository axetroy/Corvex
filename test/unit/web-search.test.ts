import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebSearchExtension, searchWeb } from "../../src/agent/web-search.ts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recorder(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse(payload, status);
  });
  return { calls, request, dependencies: { request } };
}

describe("keyless web search", () => {
  it("calls Tavily with the keyless header and no API key", async () => {
    const recorderMock = recorder({
      results: [{ title: "Node 26", url: "https://docs.example.org/node", content: "Release notes" }],
    });
    const result = await searchWeb("  node 26 release  ", 3, {
      blockedHosts: [],
      dependencies: recorderMock.dependencies,
    });

    expect(recorderMock.calls).toHaveLength(1);
    expect(recorderMock.calls[0]?.url).toBe("https://api.tavily.com/search");
    const headers = recorderMock.calls[0]?.init.headers as Record<string, string>;
    expect(headers["X-Tavily-Access-Mode"]).toBe("keyless");
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.parse(String(recorderMock.calls[0]?.init.body))).toMatchObject({
      query: "node 26 release",
      max_results: 3,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    });
    expect(result.results).toEqual([
      { title: "Node 26", url: "https://docs.example.org/node", snippet: "Release notes" },
    ]);
  });

  it("drops unsafe links and caps third-party snippets", async () => {
    const recorderMock = recorder({
      results: [
        { title: "private", url: "https://10.0.0.1/admin", content: "private" },
        { title: "blocked", url: "https://api.corp.dev/x", content: "blocked" },
        { title: "plain http", url: "http://docs.example.org/x", content: "http" },
        { title: "portal", url: "https://docs.example.org/portal", content: "portal" },
        { title: "long", url: "https://docs.example.org/long", content: "x".repeat(2_000) },
      ],
    });
    const result = await searchWeb("query", 10, {
      blockedHosts: ["corp.dev"],
      dependencies: recorderMock.dependencies,
    });

    expect(result.results.map((item) => item.url)).toEqual([
      "https://docs.example.org/portal",
      "https://docs.example.org/long",
    ]);
    expect(result.results[1]?.snippet).toHaveLength(800);
  });

  it("turns a keyless rate limit into a notice instead of failing the turn", async () => {
    const recorderMock = recorder({ error: "rate limited" }, 429);
    const result = await searchWeb("query", 5, { dependencies: recorderMock.dependencies });
    expect(result).toEqual({ results: [], notice: expect.stringContaining("rate-limited") });
  });

  it("surfaces non-rate-limit HTTP failures", async () => {
    const recorderMock = recorder({ error: "bad request" }, 400);
    await expect(searchWeb("query", 5, { dependencies: recorderMock.dependencies })).rejects.toThrow("HTTP 400");
  });

  it("validates the query length before calling the network", async () => {
    const recorderMock = recorder({ results: [] });
    await expect(searchWeb("", 5, { dependencies: recorderMock.dependencies })).rejects.toThrow("between 1 and 500");
    await expect(searchWeb("x".repeat(501), 5, { dependencies: recorderMock.dependencies })).rejects.toThrow("between 1 and 500");
    expect(recorderMock.request).not.toHaveBeenCalled();
  });

  it("enforces the per-session query cap and reports tool failures as text", async () => {
    let execute:
      | ((toolCallId: string, params: { query: string; count?: number }) => Promise<{ content: Array<{ text: string }> }>)
      | undefined;
    createWebSearchExtension(2, [])({
      registerTool: (tool) => { execute = tool.execute; },
    } as unknown as ExtensionAPI);
    if (!execute) throw new Error("web_search tool was not registered");

    const failed = await execute("call-1", { query: "" });
    expect(JSON.parse(failed.content[0]?.text ?? "{}").notice).toContain("Web search failed");
    await execute("call-2", { query: "" });
    const limited = await execute("call-3", { query: "still searching" });
    expect(JSON.parse(limited.content[0]?.text ?? "{}").notice).toContain("session limit of 2 queries reached");
  });
});
