import { describe, expect, it } from "vitest";
import { createSteerChannel } from "../../src/agent/pi.js";

describe("SteerChannel status and delivery", () => {
  it("notifies queued immediately and delivered when SDK drains the steering queue", async () => {
    const channel = createSteerChannel();
    const statuses: string[] = [];
    channel.onStatus((status) => statuses.push(status));
    channel.bind(async () => "queued");
    expect(await channel.send("补充一")).toBe("queued");
    expect(statuses).toEqual(["queued"]);

    // SDK 第一次 queue_update 仍排队，第二次补充消失 → 送达。
    channel.markDelivered(["补充一"]);
    expect(statuses).toEqual(["queued"]);
    channel.markDelivered([]);
    expect(statuses).toEqual(["queued", "delivered"]);
    // 重复事件不重复提示。
    channel.markDelivered([]);
    expect(statuses).toEqual(["queued", "delivered"]);
  });

  it("buffers before bind and returns undelivered on close", async () => {
    const channel = createSteerChannel();
    const statuses: string[] = [];
    channel.onStatus((status) => statuses.push(status));
    expect(await channel.send("等会话")).toBe("buffered");
    expect(statuses).toEqual(["queued"]);
    expect(channel.close()).toEqual(["等会话"]);
  });

  it("flushes buffered texts on bind and clears them on close", async () => {
    const channel = createSteerChannel();
    const delivered: string[] = [];
    await channel.send("先缓存");
    channel.bind(async (text) => { delivered.push(text); return "queued"; });
    expect(delivered).toEqual(["先缓存"]);
    expect(channel.delivered()).toEqual(["先缓存"]);
    expect(channel.close()).toEqual([]);
  });
});
