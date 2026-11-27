import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { AppStore } from "../../src/store.ts";
import {
  computeSkillHash,
  skillLockFileName,
  SkillStore,
} from "../../src/agent/skill-store.ts";

/** CRC32（ZIP store 模式需要），仅供测试构造最小压缩包。 */
function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

/** 用 store 模式构造一个最小合法 ZIP。 */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const nameBuffer = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const sampleDocument = `---
name: custom
description: Custom skill
metadata:
  corvex-quick-action: "true"
  corvex-quick-label: "Custom"
---

Do $ARGUMENTS
`;

describe("SkillStore", () => {
  let directory = "";
  let skills: SkillStore;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  async function openStore(): Promise<SkillStore> {
    directory = await mkdtemp(join(tmpdir(), "corvex-skill-store-"));
    return new SkillStore(join(directory, "skills"));
  }

  it("computes the same content hash as npx skills lock files", () => {
    expect(computeSkillHash([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(computeSkillHash([{ path: "SKILL.md", content: Buffer.from("# hi\n") }]))
      .toBe("93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55");
    expect(computeSkillHash([
      { path: "docs/b.md", content: Buffer.from("b\n") },
      { path: "SKILL.md", content: Buffer.from("a\n") },
    ])).toBe("b22c4d22aa319d2924312fa18fcbfedc88fa89c74dbd8f298c683e1caf7b7f24");
    // CRLF 与 LF 视为同一内容，避免 Windows 上误报修改。
    expect(computeSkillHash([{ path: "SKILL.md", content: Buffer.from("# hi\r\n") }]))
      .toBe(computeSkillHash([{ path: "SKILL.md", content: Buffer.from("# hi\n") }]));
  });

  it("stores skills on disk with a lock file and full CRUD", async () => {
    skills = await openStore();
    await skills.seedSystemSkills();
    expect(await skills.list()).toHaveLength(7);
    expect(await skills.listEnabled()).toHaveLength(7);
    expect(await skills.getCached("docs")?.content).toContain("documentation");

    const created = await skills.create(sampleDocument);
    expect(created.status).toBe("tracked");
    expect(created.isSystem).toBe(false);
    expect(created.quickLabel).toBe("Custom");
    expect(await readFile(join(directory, "skills", "custom", "SKILL.md"), "utf8")).toContain("name: custom");
    const lock = JSON.parse(await readFile(join(directory, "skills", skillLockFileName), "utf8")) as {
      version: number; skills: Record<string, { computedHash: string; source: string }>;
    };
    expect(lock.version).toBe(2);
    expect(lock.skills.custom.source).toBe("manual");
    expect(lock.skills.custom.computedHash).toMatch(/^[a-f0-9]{64}$/);

    const updated = await skills.update("custom", sampleDocument.replace("Do $ARGUMENTS", "Do it now"));
    expect(updated?.content).toBe("Do it now");
    expect(await skills.setEnabled("custom", false)).toBe(true);
    expect((await skills.get("custom"))?.enabled).toBe(false);
    expect(await skills.setEnabled("custom", true)).toBe(true);
    expect(await skills.remove("custom")).toBe(true);
    expect(await skills.get("custom")).toBeUndefined();
    // 系统种子不可删除。
    expect(await skills.remove("docs")).toBe(false);
  });

  it("detects modified, missing and untracked skills against the lock", async () => {
    skills = await openStore();
    await skills.seedSystemSkills();
    const before = await skills.get("docs");
    expect(before?.status).toBe("tracked");

    await writeFile(join(directory, "skills", "docs", "SKILL.md"), `${before!.document}\n\nextra\n`);
    expect((await skills.get("docs"))?.status).toBe("modified");
    await rm(join(directory, "skills", "docs"), { recursive: true, force: true });
    expect((await skills.get("docs"))?.status).toBe("missing");

    await mkdir(join(directory, "skills", "outsider"), { recursive: true });
    await writeFile(join(directory, "skills", "outsider", "SKILL.md"), sampleDocument.replace("name: custom", "name: outsider"));
    expect((await skills.list()).find((skill) => skill.name === "outsider")?.status).toBe("untracked");
  });

  it("imports a pack to disk and restores it from the stored archive", async () => {
    skills = await openStore();
    const archive = zip({
      "skills/demo/SKILL.md": "---\nname: demo\ndescription: Demo skill\n---\n\nDo demo things\n",
      "skills/demo/notes.md": "reference notes\n",
    });
    const result = await skills.importPack({
      name: "demo-pack", archive, source: "upload", sourceValue: "demo.zip", overwrite: false,
    });
    expect(result.created).toEqual(["demo"]);
    expect(result.pack.skillCount).toBe(1);
    expect(await readFile(join(directory, "skills", "demo", "notes.md"), "utf8")).toBe("reference notes\n");
    expect(await skills.get("demo")).toMatchObject({ status: "tracked", packId: result.pack.id });

    // 改坏文件后用锁里的哈希发现差异，并从磁盘上的 ZIP 恢复。
    await writeFile(join(directory, "skills", "demo", "SKILL.md"), "broken");
    const report = await skills.verifyAndRestore(false);
    expect(report.find((entry) => entry.name === "demo")).toMatchObject({ status: "modified", restored: true });
    expect((await skills.get("demo"))?.status).toBe("tracked");

    expect(await skills.deletePack(result.pack.id)).toBe(true);
    expect(await skills.get("demo")).toBeUndefined();
  });

  it("exports a legacy SQLite skill table once and drops the old tables", async () => {
    skills = await openStore();
    const databasePath = join(directory, "state.db");
    let store = await AppStore.open(databasePath);
    store.close();
    const raw = new DatabaseSync(databasePath);
    raw.exec(`CREATE TABLE conversation_skills (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, content TEXT, metadata TEXT,
      enabled INTEGER, is_system INTEGER, created_at TEXT, updated_at TEXT
    )`);
    raw.exec(`INSERT INTO conversation_skills VALUES ('1','legacy','Legacy skill','Old body','{"corvex-quick-label":"Legacy"}',1,0,'2026-01-01','2026-01-02')`);
    raw.exec(`CREATE TABLE skill_packs (id TEXT PRIMARY KEY, name TEXT, archive BLOB, size INTEGER, source TEXT, source_value TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT)`);
    raw.close();

    store = await AppStore.open(databasePath);
    const migrated = await skills.migrateFromStore(store);
    expect(migrated.skills).toBe(1);
    expect((await skills.get("legacy"))?.content).toBe("Old body");
    expect(await skills.get("legacy")).toMatchObject({ isSystem: false, quickLabel: "Legacy" });
    // 第二次调用不会覆盖磁盘内容。
    expect((await skills.migrateFromStore(store)).skills).toBe(0);
    await writeFile(join(directory, "skills", "legacy", "SKILL.md"), sampleDocument.replace("name: custom", "name: legacy"));
    expect((await skills.migrateFromStore(store)).skills).toBe(0);
    expect((await skills.get("legacy"))?.content).toBe("Do $ARGUMENTS");
    store.close();
  });
});
