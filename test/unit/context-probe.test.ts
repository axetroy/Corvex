import { afterEach, describe, expect, it, vi } from "vitest";
import { probeLlamaContext } from "../../src/agent/context-probe.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("llama.cpp context probe", () => {
  it("reads /props at the server root and divides the pool by its slots", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      default_generation_settings: { n_ctx: 131072 },
      total_slots: 4,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeLlamaContext("http://127.0.0.1:8012/v1")).resolves.toEqual({
      contextWindow: 32768,
      slots: 4,
    });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8012/props", expect.any(Object));
  });

  it("ignores services without the llama.cpp props shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await expect(probeLlamaContext("https://api.example.com/v1")).resolves.toBeUndefined();
  });

  it("never throws when the probe fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await expect(probeLlamaContext("http://127.0.0.1:1/v1")).resolves.toBeUndefined();
  });
});
