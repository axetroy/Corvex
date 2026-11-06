import { describe, expect, it } from "vitest";
import {
  decodeJobId,
  jobHash,
  jobQueueFromParams,
  jobQueueQuery,
  jobsBackHash,
  jobsHash,
  parseHash,
  sessionsHash,
} from "../../src/app/ui/routing.ts";

describe("operations UI routing", () => {
  it("treats an empty hash as the overview page", () => {
    expect(parseHash("").page).toEqual({ kind: "overview" });
    expect(parseHash("#").page).toEqual({ kind: "overview" });
    expect(parseHash("overview").page).toEqual({ kind: "overview" });
  });

  it("parses the job list and a job detail route with query parameters", () => {
    expect(parseHash("jobs").page).toEqual({ kind: "jobs" });
    expect(parseHash("#jobs/job-1?status=failed").page).toEqual({ kind: "job", id: "job-1" });
    expect(parseHash("#jobs/job-1?status=failed").params.get("status")).toBe("failed");
    expect(parseHash("jobs/a%20b").page).toEqual({ kind: "job", id: "a b" });
  });

  it("parses and serializes a selected session ID", () => {
    expect(parseHash("#sessions/session-1").page).toEqual({ kind: "sessions", id: "session-1" });
    expect(parseHash("#sessions/%E0%A4%A").page).toEqual({ kind: "unknown" });
    expect(sessionsHash("session 1")).toBe("#sessions/session%201");
    expect(sessionsHash()).toBe("#sessions");
  });

  it("rejects a job route without a usable ID instead of rendering a blank page", () => {
    expect(parseHash("jobs/").page).toEqual({ kind: "unknown" });
    expect(parseHash("jobs/%E0%A4%A").page).toEqual({ kind: "unknown" });
  });

  it("rejects unknown routes", () => {
    expect(parseHash("settings").page).toEqual({ kind: "unknown" });
  });

  it("decodes only well-formed job IDs", () => {
    expect(decodeJobId("a%20b")).toBe("a b");
    expect(decodeJobId("")).toBeUndefined();
    expect(decodeJobId("%")).toBeUndefined();
  });
});

describe("operations UI job list filters in the URL", () => {
  it("restores valid filters and drops invalid values", () => {
    expect(jobQueueFromParams(new URLSearchParams("status=failed&type=fix&search=a%20b&offset=50"))).toEqual({
      status: "failed",
      type: "fix",
      search: "a b",
      offset: 50,
    });
    expect(jobQueueFromParams(new URLSearchParams("status=bogus&type=bogus&offset=-5"))).toEqual({
      status: "",
      type: "",
      search: "",
      offset: 0,
    });
    expect(jobQueueFromParams(new URLSearchParams()).offset).toBe(0);
  });

  it("serializes only non-default filters", () => {
    expect(jobQueueQuery({ status: "failed", type: "", search: "", offset: 0 })).toBe("?status=failed");
    expect(jobQueueQuery({ status: "", type: "", search: "", offset: 0 })).toBe("");
    expect(jobsHash({ status: "failed", type: "", search: "", offset: 25 })).toBe("#jobs?status=failed&offset=25");
  });

  it("keeps the list filters on the detail hash and back link", () => {
    const queue = { status: "", type: "review", search: "1:3", offset: 0 };
    expect(jobHash("job 1", queue)).toBe("#jobs/job%201?type=review&search=1%3A3");
    expect(jobsBackHash(new URLSearchParams("type=review&search=1%3A3"))).toBe("#jobs?type=review&search=1%3A3");
    expect(jobsBackHash(new URLSearchParams())).toBe("#jobs");
  });
});
