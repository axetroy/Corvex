/**
 * 上传目录的空闲清理。
 *
 * 上传是「先 mkdir 再写文件」两步，中间存在目录已创建但文件还没落盘的窗口。
 * 清理与上传运行在同一个 Server 进程里，因此用进程内的在途目录登记表规避竞态：
 * 上传前登记、结束后注销；清理对登记路径及其所有祖先跳过。
 * 即便仍有跨进程竞争，最后的 rmdir 是非递归的，目录里出现新文件时只会收到
 * ENOTEMPTY 并被忽略，不会误删正在写入的内容。
 */

import type { Dirent } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const activePaths = new Set<string>();

export function registerUploadPath(path: string): () => void {
  const normalized = resolve(path);
  activePaths.add(normalized);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePaths.delete(normalized);
  };
}

/** 在上传/认领文件期间保护其目录与祖先不被清理。 */
export async function withActiveUploadPath<T>(path: string, action: () => Promise<T>): Promise<T> {
  const release = registerUploadPath(path);
  try {
    return await action();
  } finally {
    release();
  }
}

function isProtected(dir: string): boolean {
  for (const active of activePaths) {
    if (active === dir || active.startsWith(`${dir}${sep}`) || dir.startsWith(`${active}${sep}`)) return true;
  }
  return false;
}

function isIgnorable(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
  return ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code);
}

/**
 * 递归删除 uploads 下不再含文件的空目录；不删除 uploads 根目录本身，不跟随符号链接。
 * 返回实际删除的目录数。
 */
export async function pruneEmptyUploadDirs(storageRoot: string): Promise<number> {
  const base = resolve(storageRoot, "uploads");
  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (isIgnorable(error)) return 0;
    throw error;
  }

  let removed = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5 || isProtected(dir)) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (!isIgnorable(error)) throw error;
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name), depth + 1);
      // 文件与符号链接都算「非空」，不处理也不跟随。
    }
    try {
      const remaining = await readdir(dir);
      if (remaining.length === 0 && !isProtected(dir)) {
        await rmdir(dir);
        removed += 1;
      }
    } catch (error) {
      // 竞态：刚检查完又有文件写入/其它线程删掉了目录，忽略即可。
      if (!isIgnorable(error)) throw error;
    }
  };

  for (const entry of rootEntries) {
    if (entry.isDirectory()) await walk(join(base, entry.name), 1);
  }
  return removed;
}
