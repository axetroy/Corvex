import { describe, expect, it } from "vitest";
import {
  adminPath,
  conversationsPath,
  eventPath,
  eventQueueFromParams,
  eventQueueQuery,
  eventsBackPath,
  eventsPath,
} from "../../src/app/ui/routing.ts";

describe("operations UI routing paths", () => {
  it("builds hash-router paths without a hash prefix", () => {
    expect(eventsPath({ status: "", type: "", search: "", offset: 0 })).toBe("/events");
    expect(conversationsPath()).toBe("/conversations");
    expect(conversationsPath("conversation 1")).toBe("/conversations/conversation%201");
    expect(adminPath("users")).toBe("/admin/users");
    expect(adminPath("settings/model")).toBe("/admin/settings/model");
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
    expect(eventQueueQuery({ status: "failed", type: "", search: "", offset: 0 })).toBe("status=failed");
    expect(eventQueueQuery({ status: "", type: "", search: "", offset: 0 })).toBe("");
    expect(eventsPath({ status: "failed", type: "", search: "", offset: 25 })).toBe("/events?status=failed&offset=25");
  });

  it("keeps the list filters on the detail path and back link", () => {
    const queue = { status: "", type: "review", search: "1:3", offset: 0 };
    expect(eventPath("event 1", queue)).toBe("/events/event%201?type=review&search=1%3A3");
    expect(eventsBackPath(new URLSearchParams("type=review&search=1%3A3"))).toBe("/events?type=review&search=1%3A3");
    expect(eventsBackPath(new URLSearchParams())).toBe("/events");
  });
});
