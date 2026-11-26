import { describe, expect, it } from "vitest";
import { adminPath, conversationsPath, pageKindOf } from "../../src/app/ui/lib/routing";

describe("operations UI routing paths", () => {
  it("builds hash-router paths without a hash prefix", () => {
    expect(conversationsPath()).toBe("/conversations");
    expect(conversationsPath("conversation 1")).toBe("/conversations/conversation%201");
    expect(adminPath("users")).toBe("/admin/users");
  });

  it("classifies the scheduled-tasks page as a known page so the guard does not redirect it", () => {
    expect(pageKindOf("/scheduled-tasks")).toBe("scheduled");
    expect(pageKindOf("scheduled-tasks")).toBe("scheduled");
    expect(pageKindOf("/conversations")).toBe("conversations");
    expect(pageKindOf("/settings")).toBe("settings");
    expect(pageKindOf("/admin/users")).toBe("unknown");
    expect(pageKindOf("/totally-unknown")).toBe("unknown");
  });
});
