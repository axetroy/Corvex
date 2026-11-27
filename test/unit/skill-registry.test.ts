import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillRegistry } from "../../src/agent/skill-registry.ts";

const document = (name: string, description = "A skill") => `---
name: ${name}
description: ${description}
---

Do ${name} carefully.
`;

describe("SkillRegistry", () => {
  let directory = "";
  let registry: SkillRegistry;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  async function open(): Promise<SkillRegistry> {
    directory = await mkdtemp(join(tmpdir(), "corvex-skill-registry-"));
    return new SkillRegistry(directory);
  }

  it("keeps personal skills isolated per user and namespaced on collision", async () => {
    registry = await open();
    await registry.global.create(document("review", "Global review"));
    await registry.forUser("user-a").create(document("review", "Personal review"));
    await registry.forUser("user-a").create(document("only-a", "Only A"));
    await registry.forUser("user-b").create(document("only-b", "Only B"));
    await registry.initialize();
    await registry.ensureUser("user-a");
    await registry.ensureUser("user-b");

    const a = registry.listForUser("user-a");
    expect(a.map((skill) => skill.commandName).sort()).toEqual(["me:review", "only-a", "review"]);
    expect(a.find((skill) => skill.commandName === "review")).toMatchObject({ scope: "global", description: "Global review" });
    expect(a.find((skill) => skill.commandName === "me:review")).toMatchObject({ scope: "personal", description: "Personal review" });
    expect(registry.resolve("user-a", "review")?.description).toBe("Global review");
    expect(registry.resolve("user-a", "me:review")?.description).toBe("Personal review");

    const b = registry.listForUser("user-b");
    expect(b.map((skill) => skill.commandName).sort()).toEqual(["only-b", "review"]);
    expect(registry.resolve("user-b", "me:review")).toBeUndefined();
  });

  it("rejects user ids that could escape the personal root", async () => {
    registry = await open();
    expect(() => registry.forUser("../other")).toThrow("invalid user id");
    expect(() => registry.forUser("a/b")).toThrow("invalid user id");
    expect(() => registry.forUser("")).toThrow("invalid user id");
  });
});
