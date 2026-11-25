import { describe, expect, it } from "vitest";
import { adminPath, conversationsPath } from "../../src/app/ui/lib/routing";

describe("operations UI routing paths", () => {
  it("builds hash-router paths without a hash prefix", () => {
    expect(conversationsPath()).toBe("/conversations");
    expect(conversationsPath("conversation 1")).toBe("/conversations/conversation%201");
    expect(adminPath("users")).toBe("/admin/users");
  });
});
