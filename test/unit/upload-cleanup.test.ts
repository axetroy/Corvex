import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneEmptyUploadDirs, registerUploadPath } from "../../src/app/upload-cleanup.js";

async function tree(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(`${prefix}${entry.name}/`);
        await walk(path, `${prefix}${entry.name}/`);
      } else {
        found.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(root, "");
  return found.sort();
}

describe("pruneEmptyUploadDirs", () => {
  it("removes empty directories but keeps files, symlinks and the uploads root", async () => {
    const base = await mkdtemp(join(tmpdir(), "corvex-upload-prune-"));
    try {
      await mkdir(join(base, "uploads", "c1", "u1"), { recursive: true });
      await mkdir(join(base, "uploads", "c1", "u2"), { recursive: true });
      await writeFile(join(base, "uploads", "c1", "u1", "a.txt"), "x");
      await mkdir(join(base, "uploads", "drafts", "owner", "d1"), { recursive: true });
      await symlink(join(base, "uploads", "c1", "u1"), join(base, "uploads", "link"), "dir");

      const removed = await pruneEmptyUploadDirs(base);
      expect(removed).toBeGreaterThanOrEqual(2);
      expect(await tree(join(base, "uploads"))).toEqual([
        "c1/",
        "c1/u1/",
        "c1/u1/a.txt",
        "link",
      ]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("keeps directories registered as in-flight uploads and their ancestors", async () => {
    const base = await mkdtemp(join(tmpdir(), "corvex-upload-race-"));
    try {
      const dir = join(base, "uploads", "c2", "u3");
      await mkdir(dir, { recursive: true });
      const release = registerUploadPath(dir);
      await pruneEmptyUploadDirs(base);
      expect(await tree(join(base, "uploads"))).toEqual(["c2/", "c2/u3/"]);
      release();
      expect(await pruneEmptyUploadDirs(base)).toBeGreaterThanOrEqual(2);
      expect(await tree(join(base, "uploads"))).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
