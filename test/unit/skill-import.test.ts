import { describe, expect, it } from "vitest";
import { discoverSkillsFromZip, skillImportLimits } from "../../src/agent/skill-import.ts";

/** CRC32（ZIP store 模式需要），仅供测试构造最小压缩包。 */
function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

/** 用 store 模式构造一个最小合法 ZIP，避免测试依赖压缩库。 */
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
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
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
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} skill\n---\n\nDo ${name} carefully.\n`;

describe("skill package import", () => {
  it("discovers SKILL.md files and ignores other entries", async () => {
    const result = await discoverSkillsFromZip(zip({
      "README.md": "not a skill",
      "skills/web/SKILL.md": skill("web-design"),
      "skills/api/SKILL.md": skill("api-guide"),
    }));
    expect(result.skills.map((item) => item.name).sort()).toEqual(["api-guide", "web-design"]);
    expect(result.issues).toEqual([]);
    expect(result.archive?.byteLength).toBeGreaterThan(0);
  });

  it("filters by subdirectory prefix", async () => {
    const result = await discoverSkillsFromZip(zip({
      "skills/web/SKILL.md": skill("web-design"),
      "other/SKILL.md": skill("other"),
    }), "skills");
    expect(result.skills.map((item) => item.name)).toEqual(["web-design"]);
  });

  it("rejects archives with path traversal and isolates invalid SKILL.md", async () => {
    await expect(discoverSkillsFromZip(zip({
      "../escape/SKILL.md": skill("escape"),
    }))).rejects.toThrow();

    const result = await discoverSkillsFromZip(zip({
      "broken/SKILL.md": "not valid frontmatter",
    }));
    expect(result.skills).toEqual([]);
    expect(result.issues.some((issue) => issue.path === "broken/SKILL.md")).toBe(true);
  });

  it("enforces the archive size cap", async () => {
    await expect(discoverSkillsFromZip(Buffer.alloc(skillImportLimits.maxArchiveBytes + 1)))
      .rejects.toThrow(/byte limit/);
  });
});
