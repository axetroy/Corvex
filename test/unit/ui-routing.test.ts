import { describe, expect, it } from "vitest";
import {
  conversationsHash,
  decodeEventId,
  eventHash,
  eventQueueFromParams,
  eventQueueQuery,
  eventsBackHash,
  eventsHash,
  parseHash,
} from "../../src/app/ui/routing.ts";

describe("operations UI routing", () => {
  it("treats an empty hash as the conversation page", () => {
    expect(parseHash("").page).toEqual({ kind: "conversations" });
    expect(parseHash("#").page).toEqual({ kind: "conversations" });
    expect(parseHash("conversations").page).toEqual({ kind: "conversations" });
    expect(parseHash("overview").page).toEqual({ kind: "overview" });
  });

  it("parses the event list and a event detail route with query parameters", () => {
    expect(parseHash("events").page).toEqual({ kind: "events" });
    expect(parseHash("#events/event-1?status=failed").page).toEqual({ kind: "event", id: "event-1" });
    expect(parseHash("#events/event-1?status=failed").params.get("status")).toBe("failed");
    expect(parseHash("events/a%20b").page).toEqual({ kind: "event", id: "a b" });
  });

  it("parses and serializes a selected conversation ID", () => {
    expect(parseHash("#conversations/conversation-1").page).toEqual({ kind: "conversations", id: "conversation-1" });
    expect(parseHash("#conversations/%E0%A4%A").page).toEqual({ kind: "unknown" });
    expect(conversationsHash("conversation 1")).toBe("#conversations/conversation%201");
    expect(conversationsHash()).toBe("#conversations");
  });

  it("rejects a event route without a usable ID instead of rendering a blank page", () => {
    expect(parseHash("events/").page).toEqual({ kind: "unknown" });
    expect(parseHash("events/%E0%A4%A").page).toEqual({ kind: "unknown" });
  });

  it("rejects unknown routes", () => {
    expect(parseHash("settings").page).toEqual({ kind: "unknown" });
  });

  it("decodes only well-formed event IDs", () => {
    expect(decodeEventId("a%20b")).toBe("a b");
    expect(decodeEventId("")).toBeUndefined();
    expect(decodeEventId("%")).toBeUndefined();
  });
});

describe("operations UI event list filters in the URL", () => {
  it("restores valid filters and drops invalid values", () => {
    expect(eventQueueFromParams(new URLSearchParams("status=failed&type=fix&search=a%20b&offset=50"))).toEqual({
      status: "failed",
      type: "fix",
      search: "a b",
      offset: 50,
    });
    expect(eventQueueFromParams(new URLSearchParams("status=bogus&type=bogus&offset=-5"))).toEqual({
      status: "",
      type: "",
      search: "",
      offset: 0,
    });
    expect(eventQueueFromParams(new URLSearchParams()).offset).toBe(0);
  });

  it("serializes only non-default filters", () => {
    expect(eventQueueQuery({ status: "failed", type: "", search: "", offset: 0 })).toBe("?status=failed");
    expect(eventQueueQuery({ status: "", type: "", search: "", offset: 0 })).toBe("");
    expect(eventsHash({ status: "failed", type: "", search: "", offset: 25 })).toBe("#events?status=failed&offset=25");
  });

  it("keeps the list filters on the detail hash and back link", () => {
    const queue = { status: "", type: "review", search: "1:3", offset: 0 };
    expect(eventHash("event 1", queue)).toBe("#events/event%201?type=review&search=1%3A3");
    expect(eventsBackHash(new URLSearchParams("type=review&search=1%3A3"))).toBe("#events?type=review&search=1%3A3");
    expect(eventsBackHash(new URLSearchParams())).toBe("#events");
  });
});
