import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import yauzl from "yauzl";
import { parseSkillDocument, validateSkillDocument } from "./skills.js";

/** 与主流 skills CLI 同量级的导入上限，防止压缩包炸弹与超大文本占用。 */
export const skillImportLimits = {
  maxArchiveBytes: 10 << 20,
  maxExtractedBytes: 25 << 20,
  maxFiles: 1_000,
  maxSkills: 100,
} as const;

export interface DiscoveredSkill {
  name: string;
  description: string;
  document: string;
  /** 包内 SKILL.md 路径，便于管理员确认来源。 */
  sourcePath: string;
  /** 磁盘化后该技能的目录在解压根里的相对路径（"/" 分隔，根目录为 "."）。 */
  folder: string;
}

export interface SkillImportIssue {
  path: string;
  message: string;
}

export interface SkillImportResult {
  skills: DiscoveredSkill[];
  issues: SkillImportIssue[];
  /** 原始 ZIP，供技能包原样入库。 */
  archive?: Buffer;
  /** 解析后的下载地址，便于后续按同一来源更新。 */
  sourceUrl?: string;
  /** 来源提交（分支/tag 时由调用方记录已知 ref）。 */
  commit?: string;
}

/** 压缩包只接受安全相对路径；绝对路径、上层遍历、Windows 分隔符与 NUL 一律拒绝。 */
function safeEntryPath(fileName: string): string | undefined {
  if (!fileName || fileName.includes("\0") || fileName.includes("\\")) return undefined;
  if (fileName.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(fileName)) return undefined;
  return fileName;
}

function isSkillFile(path: string): boolean {
  return path.split("/").pop()?.toLowerCase() === "skill.md";
}

/** 读取一个 ZIP 条目，流式累计并在超限时中止，不把整个包一次性解压到内存。 */
function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (streamError, stream) => {
      if (streamError || !stream) {
        reject(streamError ?? new Error("cannot read archive entry"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(error);
      };
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          fail(new Error("archive entry exceeds the size limit"));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", fail);
      stream.once("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    });
  });
}

/**
 * 遍历技能包。outputDir 提供时把安全条目写到磁盘，使技能目录包含 SKILL.md 及配套文件；
 * 不提供时只做发现（旧接口语义）。其它文件只作为只读素材，不会被自动执行；
 * 只有 SKILL.md 里显式声明并开启的命令才会由 run_skill_command 执行。
 */
function unpackSkillArchive(
  archive: Buffer,
  pathPrefix: string | undefined,
  outputDir?: string,
): Promise<SkillImportResult> {
  return new Promise((resolve, reject) => {
    if (archive.byteLength > skillImportLimits.maxArchiveBytes) {
      reject(new Error(`archive exceeds the ${skillImportLimits.maxArchiveBytes} byte limit`));
      return;
    }
    yauzl.fromBuffer(archive, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("invalid ZIP archive"));
        return;
      }
      const result: SkillImportResult = { skills: [], issues: [], archive };
      const prefix = pathPrefix?.replace(/\/+$/, "");
      let entriesSeen = 0;
      let bytesSeen = 0;
      let done = false;
      const abort = (message: string) => {
        if (done) return;
        done = true;
        result.issues.push({ path: "", message });
        zip.close();
        resolve(result);
      };

      zip.on("error", (cause) => {
        if (!done) {
          done = true;
          reject(cause);
        }
      });
      zip.on("end", () => {
        if (!done) {
          done = true;
          zip.close();
          resolve(result);
        }
      });
      zip.on("entry", async (entry) => {
        if (done) return;
        entriesSeen += 1;
        if (entriesSeen > skillImportLimits.maxFiles) {
          abort(`archive contains more than ${skillImportLimits.maxFiles} files`);
          return;
        }
        bytesSeen += entry.uncompressedSize;
        if (bytesSeen > skillImportLimits.maxExtractedBytes) {
          abort(`archive expands beyond ${skillImportLimits.maxExtractedBytes} bytes`);
          return;
        }
        const path = safeEntryPath(entry.fileName);
        if (!path) {
          result.issues.push({ path: entry.fileName, message: "unsafe archive path ignored" });
          zip.readEntry();
          return;
        }
        try {
          // ZIP 目录项不需要读取内容；跳过的同时仍计入条目上限。
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          const raw = await readEntry(zip, entry, skillImportLimits.maxExtractedBytes);
          // 落盘发生在校验路径之后；目标始终在 outputDir 内。
          if (outputDir) {
            const target = join(outputDir, path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, raw);
          }
          if (isSkillFile(path) && (!prefix || path.startsWith(`${prefix}/`))) {
            const document = raw.toString("utf8");
            const parsed = parseSkillDocument(document);
            const problems = validateSkillDocument(parsed);
            if (problems.length > 0) {
              result.issues.push({ path, message: problems.join("; ") });
            } else if (result.skills.length < skillImportLimits.maxSkills) {
              const slash = path.lastIndexOf("/");
              result.skills.push({
                name: parsed.name,
                description: parsed.description,
                document: document.trim(),
                sourcePath: path,
                folder: slash < 0 ? "." : path.slice(0, slash),
              });
            }
          }
        } catch (cause) {
          result.issues.push({
            path,
            message: cause instanceof Error ? cause.message : "invalid SKILL.md",
          });
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

/** 只解析不落盘，供导入预览与现有调用方使用。 */
export function discoverSkillsFromZip(archive: Buffer, pathPrefix?: string): Promise<SkillImportResult> {
  return unpackSkillArchive(archive, pathPrefix);
}

/** 解压到磁盘并返回发现的技能及其目录，供磁盘化技能存储使用。 */
export function extractSkillArchive(
  archive: Buffer,
  outputDir: string,
  pathPrefix?: string,
): Promise<SkillImportResult> {
  return unpackSkillArchive(archive, pathPrefix, outputDir);
}
