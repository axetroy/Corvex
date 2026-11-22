import { describe, expect, it } from "vitest";
import { createSteerChannel } from "../../src/agent/pi.ts";

describe("conversation steer channel", () => {
  it("buffers messages until the session is ready and drains them in order", async () => {
    const channel = createSteerChannel();
    const delivered: string[] = [];
    expect(await channel.send("first")).toBe("buffered");
    expect(await channel.send("second")).toBe("buffered");
    channel.bind(async (text) => {
      delivered.push(text);
      return "queued";
    });
    expect(delivered).toEqual(["first", "second"]);
    expect(await channel.send("third")).toBe("queued");
    expect(delivered).toEqual(["first", "second", "third"]);
  });

  it("returns the SDK disposition and maps delivery errors to unavailable", async () => {
    const channel = createSteerChannel();
    channel.bind(async () => "handled");
    expect(await channel.send("hello")).toBe("handled");
    channel.bind(async () => { throw new Error("session finished"); });
    expect(await channel.send("hello again")).toBe("unavailable");
  });

  it("rebinds to a fresh session after an overflow retry", async () => {
    const channel = createSteerChannel();
    const first: string[] = [];
    const second: string[] = [];
    channel.bind(async (text) => { first.push(text); return "queued"; });
    expect(await channel.send("before retry")).toBe("queued");
    channel.bind(async (text) => { second.push(text); return "handled"; });
    expect(await channel.send("after retry")).toBe("handled");
    expect(first).toEqual(["before retry"]);
    expect(second).toEqual(["after retry"]);
  });

  it("drops buffered messages and rejects new ones after the turn ends", async () => {
    const channel = createSteerChannel();
    expect(await channel.send("too late")).toBe("buffered");
    channel.close();
    expect(await channel.send("still too late")).toBe("unavailable");
    const delivered: string[] = [];
    channel.bind(async (text) => { delivered.push(text); return "queued"; });
    expect(delivered).toEqual([]);
  });
});
