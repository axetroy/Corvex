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
  /** 包内路径，便于管理员确认来源。 */
  sourcePath: string;
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
}

/** 压缩包只接受 SKILL.md；路径必须停留在包内，不接受绝对路径、上层遍历或符号链接。 */
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
 * 从 ZIP 中发现 SKILL.md：只解析文本指令文档，包内脚本与其它文件一律忽略（技能只提供指令，脚本永不执行）。
 * 返回可导入技能与逐文件问题，单个坏文档不会让整包失败。
 */
export function discoverSkillsFromZip(archive: Buffer, pathPrefix?: string): Promise<SkillImportResult> {
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
        } else if (isSkillFile(path) && (!prefix || path.startsWith(`${prefix}/`))) {
          try {
            const raw = await readEntry(zip, entry, skillImportLimits.maxExtractedBytes);
            const document = raw.toString("utf8");
            const parsed = parseSkillDocument(document);
            const problems = validateSkillDocument(parsed);
            if (problems.length > 0) {
              result.issues.push({ path, message: problems.join("; ") });
            } else if (result.skills.length < skillImportLimits.maxSkills) {
              result.skills.push({
                name: parsed.name,
                description: parsed.description,
                document: document.trim(),
                sourcePath: path,
              });
            }
          } catch (cause) {
            result.issues.push({
              path,
              message: cause instanceof Error ? cause.message : "invalid SKILL.md",
            });
          }
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  });
}
