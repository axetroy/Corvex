import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderTokenCounter } from "../../src/agent/token-counter.ts";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

describe("provider token counter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts tokens through the llama.cpp /tokenize endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ tokens: [1, 2, 3] }));
    vi.stubGlobal("fetch", fetchMock);
    const counter = createProviderTokenCounter("http://127.0.0.1:8012/v1");
    await expect(counter.count("hello")).resolves.toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8012/tokenize",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ content: "hello", add_special: false }) }),
    );
  });

  it("falls back to heuristic and stops probing after an unsupported response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "not found" }, false));
    vi.stubGlobal("fetch", fetchMock);
    const counter = createProviderTokenCounter("http://127.0.0.1:8012/v1");
    await expect(counter.count("hello")).resolves.toBeUndefined();
    await expect(counter.count("hello again")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("handles network failures without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const counter = createProviderTokenCounter("http://127.0.0.1:8012/v1");
    await expect(counter.count("hello")).resolves.toBeUndefined();
  });
});
