import { describe, expect, it } from "vitest";
import {
  resolveWaitingSince,
  resolveWaitingStage,
  WAIT_LONG_AFTER_MS,
  WAIT_REASSURE_AFTER_MS,
} from "../../src/app/ui/lib/conversationWaiting.js";

describe("conversation model waiting state", () => {
  const start = 1_000;
  const now = 2_000;

  it("enters waiting on every model request", () => {
    expect(resolveWaitingSince(null, { type: "start" }, now)).toBe(now);
    expect(resolveWaitingSince(start, { type: "start" }, now)).toBe(now);
    expect(resolveWaitingSince(null, { type: "toolSettled" }, now)).toBe(now);
  });

  it("leaves waiting as soon as content or a tool run begins", () => {
    expect(resolveWaitingSince(start, { type: "content" }, now)).toBeNull();
    expect(resolveWaitingSince(start, { type: "toolRunning" }, now)).toBeNull();
    expect(resolveWaitingSince(start, { type: "done" }, now)).toBeNull();
  });

  it("re-enters waiting after a tool finishes so the next model call is visible", () => {
    expect(resolveWaitingSince(null, { type: "toolSettled" }, now)).toBe(now);
  });
  it("uses reassuring copy after the wait threshold and escalates later", () => {
    expect(resolveWaitingStage(0)).toBe("normal");
    expect(resolveWaitingStage(WAIT_REASSURE_AFTER_MS - 1)).toBe("normal");
    expect(resolveWaitingStage(WAIT_REASSURE_AFTER_MS)).toBe("slow");
    expect(resolveWaitingStage(WAIT_LONG_AFTER_MS - 1)).toBe("slow");
    expect(resolveWaitingStage(WAIT_LONG_AFTER_MS)).toBe("long");
  });

});
