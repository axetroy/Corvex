import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import type { Dirent } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AppStore } from "../store.js";
import type { ConversationSkill, SkillPack, SkillStatus } from "../model.js";
import {
  defaultSkillDocuments,
  ensureQuickActionMetadata,
  isValidSkillName,
  parseSkillDocument,
  SKILL_SEED_VERSION,
  validateSkillDocument,
} from "./skills.js";
import { extractSkillArchive } from "./skill-import.js";

/** 与 npx skills 锁文件同构的版本号；旧版本不兼容时按空锁处理。 */
export const skillLockVersion = 2;
export const skillLockFileName = "skills-lock.json";

export type { SkillStatus } from "../model.js";

/** 单条锁记录：来源可复现信息 + 按 npx skills 算法算出的内容哈希。 */
export interface SkillLockEntry {
  source: "system" | "manual" | "upload" | "url" | "github" | "gitlab";
  sourceType: string;
  sourceUrl: string;
  ref?: string;
  commit?: string;
  skillPath?: string;
  computedHash: string;
  installedAt: string;
  updatedAt: string;
  /** 同一包派生的技能共享该 ID；系统种子与手动技能为空。 */
  packId?: string;
  packName?: string;
  /** 本地保留的 ZIP（相对技能根目录），让导入包可以离线恢复。 */
  archive?: string;
  /** SKILL.md 相对技能目录的路径；npx skills 允许它不在根目录。 */
  skillFile?: string;
  /** 用户填写的原始来源地址（owner/repo 等），无解析 URL 时用于回源。 */
  sourceValue?: string;
}

export interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
}

export type ManagedSkill = ConversationSkill;
export type ManagedSkillPack = SkillPack;

/** 技能文件被发现/解析时产生的问题；管理端展示，模型目录不暴露。 */
export interface SkillDiagnostic {
  level: "warning" | "error";
  skill: string;
  message: string;
}

export interface SkillImportPackInput {
  name: string;
  archive: Buffer;
  source: "upload" | "url" | "github" | "gitlab";
  sourceValue: string;
  ref?: string;
  commit?: string;
  sourceUrl?: string;
  path?: string;
  overwrite: boolean;
}

/** 更新技能包时由路由提供重新下载能力，存储层不关心 GitLab 令牌与网络细节。 */
export interface SkillPackFetchResult {
  archive: Buffer;
  sourceUrl?: string;
  commit?: string;
}

export interface SkillImportPackResult {
  pack: ManagedSkillPack;
  created: string[];
  skipped: string[];
  errors: string[];
  issues: Array<{ path: string; message: string }>;
}

/** npx skills 内容哈希排除的目录与文件，不参与安装也不参与校验。 */
const excludedNames = new Set(["metadata.json", ".git", "__pycache__", "__pypackages__"]);

/**
 * 按 npx skills 的规则计算一组文件的内容哈希：
 * 路径用 "/"、按 UTF-8 字节排序，文本把 CRLF 归一为 LF，
 * 每个文件依次喂入 path\0<字节长度>\0<内容> 到同一个 SHA-256。
 */
export function computeSkillHash(files: readonly { path: string; content: Buffer }[]): string {
  const normalized = files
    .map((file) => ({ path: file.path.replace(/\\/g, "/"), content: normalizeSkillFile(file.content) }))
    .filter((file) => !excludedNames.has(file.path.split("/").at(-1) ?? ""))
    .filter((file) => !file.path.split("/").some((part) => excludedNames.has(part)))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  const hash = createHash("sha256");
  for (const file of normalized) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(String(file.content.byteLength), "ascii");
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/** 含 NUL 的按二进制处理；纯文本统一换行，避免跨平台 CRLF 造成假修改。 */
function normalizeSkillFile(content: Buffer): Buffer {
  if (content.includes(0)) return content;
  return Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

async function atomicWrite(target: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function emptyLock(): SkillLockFile {
  return { version: skillLockVersion, skills: {} };
}

/** 文件缺失或写坏时用于列表展示的空技能，不让一条坏数据挡住整个运维台。 */
function emptyParsed(name: string): ReturnType<typeof parseSkillDocument> {
  return {
    name, description: "", content: "", license: "", compatibility: "", metadata: {},
    allowedTools: "", enabled: false, quickAction: false, quickLabel: "", commands: [], commandsEnabled: false,
    disableModelInvocation: false, userInvocable: true, whenToUse: "", argumentHint: "", arguments: [],
  };
}

function isSkillLockFile(value: unknown): value is SkillLockFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === skillLockVersion && !!record.skills && typeof record.skills === "object" && !Array.isArray(record.skills);
}

/**
 * 磁盘技能存储：唯一权威来源是 <root> 下的技能目录与 skills-lock.json。
 * 所有写操作串行化并以临时文件 + rename 原子替换，避免并发导入写坏锁文件或目录。
 */
export class SkillStore {
  constructor(private readonly root: string) {}

  private get lockPath(): string {
    return join(this.root, skillLockFileName);
  }

  private skillDir(name: string): string {
    if (!isValidSkillName(name)) throw new Error(`invalid skill name: ${name}`);
    return join(this.root, name);
  }

  private archivePath(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error(`invalid skill pack id: ${id}`);
    return join(this.root, ".archives", `${id}.zip`);
  }

  /** 启动时与每次写后重建的内存镜像；斜杠命令解析是同步的，读它即可。 */
  private cache = new Map<string, ManagedSkill>();
  private lastSignature = "";
  private currentDiagnostics: SkillDiagnostic[] = [];

  /** 重建同步读取用的缓存；磁盘是权威来源，缓存只是快照。 */
  async refresh(): Promise<void> {
    const skills = await this.list();
    this.cache = new Map(skills.filter((skill) => skill.status !== "missing").map((skill) => [skill.name, skill]));
    this.currentDiagnostics = await this.collectDiagnostics();
    this.lastSignature = await this.computeSignature();
  }

  /**
   * 每轮调用：直接改磁盘文件也能被发现，无需重启或走管理 API。
   * 用锁文件与各 SKILL.md 的 mtime 做廉价指纹，命中时完全不读文件。
   */
  async refreshIfStale(): Promise<boolean> {
    if (await this.computeSignature() === this.lastSignature) return false;
    await this.refresh();
    return true;
  }

  /** 管理端可见的解析/发现诊断；模型目录不暴露。 */
  diagnostics(): SkillDiagnostic[] {
    return [...this.currentDiagnostics];
  }

  private async computeSignature(): Promise<string> {
    const parts: string[] = [];
    const lockInfo = await stat(this.lockPath).catch(() => undefined);
    parts.push(`lock:${lockInfo?.mtimeMs ?? 0}`);
    let entries: Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      entries = [];
    }
    for (const entry of entries.filter((item) => item.isDirectory() && isValidSkillName(item.name))) {
      const file = await this.findSkillFile(entry.name);
      const info = file
        ? await stat(join(this.skillDir(entry.name), file)).catch(() => undefined)
        : undefined;
      parts.push(`${entry.name}:${file ?? ""}:${info?.mtimeMs ?? 0}`);
    }
    return parts.join("|");
  }

  /** 汇总坏文档、缺描述、目录名与 frontmatter 名不一致等问题。 */
  private async collectDiagnostics(): Promise<SkillDiagnostic[]> {
    const lock = await this.readLock();
    const result: SkillDiagnostic[] = [];
    const declaredNames = new Map<string, string[]>();
    for (const [name, entry] of Object.entries(lock.skills)) {
      if (!isValidSkillName(name)) continue;
      const allFiles = await this.findAllSkillFiles(name);
      const file = await this.findSkillFile(name, entry.skillFile);
      if (allFiles.length > 1) {
        result.push({
          level: "warning", skill: name,
          message: `multiple SKILL.md files found (${allFiles.join(", ")}); only ${file ?? allFiles[0]} is used`,
        });
      }
      if (!file) {
        result.push({ level: "error", skill: name, message: "SKILL.md not found in the skill directory" });
        continue;
      }
      let document: string;
      try {
        document = await readFile(join(this.skillDir(name), file), "utf8");
      } catch {
        result.push({ level: "error", skill: name, message: "SKILL.md could not be read" });
        continue;
      }
      try {
        const parsed = parseSkillDocument(document);
        if (!parsed.description) {
          result.push({ level: "warning", skill: name, message: "description is missing; the model cannot route to this skill" });
        }
        if (parsed.name !== name) {
          result.push({ level: "warning", skill: name, message: `frontmatter name "${parsed.name}" differs from directory name "${name}"` });
        }
        const owners = declaredNames.get(parsed.name) ?? [];
        owners.push(name);
        declaredNames.set(parsed.name, owners);
      } catch (error) {
        result.push({ level: "error", skill: name, message: error instanceof Error ? error.message : "invalid SKILL.md" });
      }
    }
    for (const [name, owners] of declaredNames) {
      if (owners.length > 1) {
        for (const owner of owners) {
          result.push({
            level: "warning", skill: owner,
            message: `frontmatter name "${name}" is also declared by ${owners.filter((item) => item !== owner).join(", ")}`,
          });
        }
      }
    }
    return result;
  }

  /** 同步读取已加载的技能，供斜杠命令解析等不能 await 的调用点使用。 */
  getCached(name: string): ManagedSkill | undefined {
    return this.cache.get(name);
  }

  /** 同步列出缓存中的技能，供技能命令目录与补全使用。 */
  listCached(): ManagedSkill[] {
    return [...this.cache.values()];
  }

  private queue: Promise<unknown> = Promise.resolve();

  /**
   * 两级锁：进程内 Promise 队列串行化本实例的写，`.skills.lock` 文件锁串行化跨实例/跨进程写。
   * 陈旧锁（超过 30 秒）会被回收，避免进程崩溃后永久卡死。
   */
  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => this.withFileLock(operation), () => this.withFileLock(operation));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const lockPath = join(this.root, ".skills.lock");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let handle;
      try {
        handle = await open(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const info = await stat(lockPath).catch(() => undefined);
        if (info && Date.now() - info.mtimeMs > 30_000) {
          await rm(lockPath, { force: true }).catch(() => undefined);
        } else {
          await sleep(20);
        }
        continue;
      }
      try {
        return await operation();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    }
    throw new Error("could not acquire the skills lock");
  }

  private async readLock(): Promise<SkillLockFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
      return isSkillLockFile(parsed) ? parsed : emptyLock();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLock();
      // 锁文件损坏时按空锁处理，避免整个运维台不可用；下次写入会覆盖它。
      return emptyLock();
    }
  }

  private async writeLock(lock: SkillLockFile): Promise<void> {
    await atomicWrite(this.lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  }

  /** 收集技能目录下参与哈希的文件；越界符号链接与排除项忽略。 */
  private async collectFiles(folder: string, prefix = ""): Promise<Array<{ path: string; content: Buffer }>> {
    const files: Array<{ path: string; content: Buffer }> = [];
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
      throw error;
    }
    for (const entry of entries) {
      if (excludedNames.has(entry.name)) continue;
      const absolute = join(folder, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const target = await realpath(absolute).catch(() => undefined);
        if (!target) continue;
        const within = relative(resolve(folder), resolve(target));
        if (isAbsolute(within) || within.startsWith("..")) continue;
      }
      const info = await stat(absolute).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) {
        files.push(...await this.collectFiles(absolute, path));
      } else if (info.isFile()) {
        files.push({ path, content: await readFile(absolute) });
      }
    }
    return files;
  }

  private async folderHash(name: string): Promise<string | undefined> {
    const folder = this.skillDir(name);
    const info = await stat(folder).catch(() => undefined);
    if (!info?.isDirectory()) return undefined;
    return computeSkillHash(await this.collectFiles(folder));
  }

  /**
   * 按 npm skills 的规则发现 SKILL.md：根目录优先，否则递归子目录，
   * 跳过点目录与 node_modules；文件按名称排序保证结果稳定。
   */
  private async findSkillFile(name: string, hint?: string): Promise<string | undefined> {
    const root = this.skillDir(name);
    if (hint && !isAbsolute(hint) && !hint.split(/[\\/]/).includes("..")) {
      const candidate = join(root, hint);
      if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) {
        return hint.replace(/\\/g, "/");
      }
    }
    const walk = async (directory: string, prefix: string): Promise<string | undefined> => {
      const direct = join(directory, "SKILL.md");
      if (await stat(direct).then((info) => info.isFile()).catch(() => false)) {
        return prefix ? `${prefix}/SKILL.md` : "SKILL.md";
      }
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const nested = prefix ? `${prefix}/${entry.name}` : entry.name;
        const found = await walk(join(directory, entry.name), nested);
        if (found) return found;
      }
      return undefined;
    };
    return walk(root, "");
  }

  /** 递归收集技能目录下所有 SKILL.md，用于冲突诊断。 */
  private async findAllSkillFiles(name: string): Promise<string[]> {
    const root = this.skillDir(name);
    const found: string[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const direct = join(directory, "SKILL.md");
      if (await stat(direct).then((info) => info.isFile()).catch(() => false)) {
        found.push(prefix ? `${prefix}/SKILL.md` : "SKILL.md");
      }
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [] as Dirent[]);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await walk(join(directory, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      }
    };
    await walk(root, "");
    return found.sort();
  }

  /** 读一份技能的 SKILL.md；名称非法或文件缺失时返回 undefined。 */
  async get(name: string): Promise<ManagedSkill | undefined> {
    if (!isValidSkillName(name)) return undefined;
    const lock = await this.readLock();
    const entry = lock.skills[name];
    if (!entry) return undefined;
    const skillFile = await this.findSkillFile(name, entry.skillFile);
    if (!skillFile) return this.toSkill(name, "", emptyParsed(name), entry, "missing", entry.updatedAt);
    let document: string;
    try {
      document = await readFile(join(this.skillDir(name), skillFile), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.toSkill(name, "", emptyParsed(name), entry, "missing", entry.updatedAt);
    }
    const parsed = (() => {
      try {
        return parseSkillDocument(document);
      } catch {
        return emptyParsed(name);
      }
    })();
    const hash = await this.folderHash(name);
    const status: SkillStatus = hash === undefined
      ? "missing"
      : hash === entry.computedHash ? "tracked" : "modified";
    const skill = this.toSkill(name, document, parsed, entry, status, hash ?? entry.updatedAt);
    skill.skillFile = skillFile;
    return skill;
  }

  private toSkill(
    name: string,
    document: string,
    parsed: ReturnType<typeof parseSkillDocument>,
    entry: SkillLockEntry | undefined,
    status: SkillStatus,
    updatedAt: string,
  ): ManagedSkill {
    return {
      id: name,
      document,
      name,
      description: parsed.description,
      content: parsed.content,
      license: parsed.license,
      compatibility: parsed.compatibility,
      metadata: parsed.metadata,
      allowedTools: parsed.allowedTools,
      enabled: parsed.enabled,
      quickAction: parsed.quickAction,
      quickLabel: parsed.quickLabel,
      isSystem: entry?.source === "system",
      createdAt: entry?.installedAt ?? updatedAt,
      updatedAt: entry?.updatedAt ?? updatedAt,
      packId: entry?.packId ?? "",
      status,
      commands: parsed.commands ?? [],
      commandsEnabled: parsed.commandsEnabled === true,
      disableModelInvocation: parsed.disableModelInvocation === true,
      userInvocable: parsed.userInvocable !== false,
      skillFile: typeof entry?.skillFile === "string" && entry.skillFile ? entry.skillFile : "SKILL.md",
      whenToUse: parsed.whenToUse ?? "",
      argumentHint: parsed.argumentHint ?? "",
      arguments: parsed.arguments ?? [],
    };
  }

  /** 列出锁内技能与磁盘上未登记的技能，并标记 tracked / modified / missing / untracked。 */
  async list(): Promise<ManagedSkill[]> {
    const lock = await this.readLock();
    const result: ManagedSkill[] = [];
    for (const [name, entry] of Object.entries(lock.skills)) {
      const skill = await this.get(name);
      if (skill) result.push(skill);
      else if (isValidSkillName(name)) {
        result.push(this.toSkill(name, "", emptyParsed(name), entry, "missing", entry.updatedAt));
      }
    }
    let diskEntries: Dirent[];
    try {
      diskEntries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      diskEntries = [];
    }
    for (const entry of diskEntries) {
      if (!entry.isDirectory() || !isValidSkillName(entry.name) || lock.skills[entry.name]) continue;
      const skillFile = await this.findSkillFile(entry.name);
      if (!skillFile) continue;
      let document: string;
      try {
        document = await readFile(join(this.skillDir(entry.name), skillFile), "utf8");
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = parseSkillDocument(document);
      } catch {
        parsed = emptyParsed(entry.name);
      }
      const untracked = this.toSkill(entry.name, document, parsed, undefined, "untracked", new Date().toISOString());
      untracked.skillFile = skillFile;
      result.push(untracked);
    }
    return result.sort((left, right) => Number(right.isSystem) - Number(left.isSystem) || left.name.localeCompare(right.name));
  }

  /** 供斜杠命令与补全菜单使用的已启用技能。 */
  async listEnabled(): Promise<ManagedSkill[]> {
    return (await this.list()).filter((skill) => skill.enabled && skill.userInvocable && skill.status !== "missing");
  }

  async listPacks(): Promise<ManagedSkillPack[]> {
    const skills = await this.list();
    const lock = await this.readLock();
    const grouped = new Map<string, ManagedSkill[]>();
    for (const skill of skills) {
      if (!skill.packId) continue;
      const members = grouped.get(skill.packId) ?? [];
      members.push(skill);
      grouped.set(skill.packId, members);
    }
    const packs: ManagedSkillPack[] = [];
    for (const [id, members] of grouped) {
      const first = lock.skills[members[0]!.name];
      let size: number;
      try {
        size = (await stat(this.archivePath(id))).size;
      } catch {
        // 无本地包时按技能文档总大小展示。
        size = members.reduce((sum, skill) => sum + Buffer.byteLength(skill.document), 0);
      }
      const status = members.some((skill) => skill.status === "missing") ? "missing"
        : members.some((skill) => skill.status === "modified") ? "modified"
        : members.some((skill) => skill.status === "untracked") ? "untracked"
        : "tracked";
      packs.push({
        id,
        name: first?.packName ?? id,
        size,
        source: first?.source ?? "upload",
        sourceValue: first?.sourceUrl ?? "",
        enabled: members.some((skill) => skill.enabled),
        skillCount: members.length,
        createdAt: members.reduce((min, skill) => skill.createdAt < min ? skill.createdAt : min, members[0]!.createdAt),
        updatedAt: members.reduce((max, skill) => skill.updatedAt > max ? skill.updatedAt : max, members[0]!.updatedAt),
        status,
      });
    }
    return packs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create(document: string): Promise<ManagedSkill> {
    return this.withLock(async () => {
      const parsed = parseSkillDocument(document);
      const problems = validateSkillDocument(parsed);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const lock = await this.readLock();
      if (lock.skills[parsed.name]) throw new Error("skill name already exists");
      const clean = document.trim();
      const now = new Date().toISOString();
      await this.writeSkillDocument(parsed.name, clean);
      lock.skills[parsed.name] = {
        source: "manual", sourceType: "manual", sourceUrl: "",
        computedHash: (await this.folderHash(parsed.name))!,
        installedAt: now, updatedAt: now,
      };
      await this.writeLock(lock);
      const created = this.toSkill(parsed.name, clean, parsed, lock.skills[parsed.name], "tracked", now);
      await this.refresh();
      return created;
    });
  }

  /** 更新技能文档；名称变化等于先删后建，由调用方（管理员 API）先检查重名。 */
  async update(name: string, document: string): Promise<ManagedSkill | undefined> {
    return this.withLock(async () => {
      const lock = await this.readLock();
      const entry = lock.skills[name];
      if (!entry) return undefined;
      const parsed = parseSkillDocument(document);
      const problems = validateSkillDocument(parsed);
      if (problems.length > 0) throw new Error(problems.join("; "));
      const clean = document.trim();
      const skillFile = (await this.findSkillFile(name, entry.skillFile)) ?? "SKILL.md";
      await this.writeSkillDocument(name, clean, skillFile);
      entry.skillFile = skillFile;
      entry.computedHash = (await this.folderHash(name))!;
      entry.updatedAt = new Date().toISOString();
      await this.writeLock(lock);
      const updated = this.toSkill(name, clean, parsed, entry, "tracked", entry.updatedAt);
      await this.refresh();
      return updated;
    });
  }

  private async writeSkillDocument(name: string, document: string, relativePath = "SKILL.md"): Promise<void> {
    await atomicWrite(join(this.skillDir(name), relativePath), document);
  }

  /** 系统种子只允许停用，不允许删除；返回 false 表示不存在或受保护。 */
  async remove(name: string): Promise<boolean> {
    return this.withLock(async () => {
      const lock = await this.readLock();
      const entry = lock.skills[name];
      if (!entry || entry.source === "system") return false;
      await rm(this.skillDir(name), { recursive: true, force: true });
      delete lock.skills[name];
      await this.writeLock(lock);
      await this.refresh();
      return true;
    });
  }

  /** 启停写回 SKILL.md 的 corvex-enabled 元数据，文档本身保持唯一来源。 */
  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    return this.withLock(async () => {
      const lock = await this.readLock();
      const entry = lock.skills[name];
      if (!entry) return false;
      const skillFile = await this.findSkillFile(name, entry.skillFile);
      if (!skillFile) return false;
      let document: string;
      try {
        document = await readFile(join(this.skillDir(name), skillFile), "utf8");
      } catch {
        return false;
      }
      // 只传启停键：parsed.metadata 把命令数组字符串化了，整包回写会丢结构化字段。
      const metadata: Record<string, string | undefined> = enabled
        ? { "corvex-enabled": undefined }
        : { "corvex-enabled": "false" };
      const updated = rewriteFrontmatter(document, metadata);
      await this.writeSkillDocument(name, updated, skillFile);
      entry.skillFile = skillFile;
      entry.computedHash = (await this.folderHash(name))!;
      entry.updatedAt = new Date().toISOString();
      await this.writeLock(lock);
      await this.refresh();
      return true;
    });
  }

  async setPackEnabled(id: string, enabled: boolean): Promise<boolean> {
    const skills = (await this.listPacks()).find((pack) => pack.id === id);
    if (!skills) return false;
    const members = (await this.list()).filter((skill) => skill.packId === id);
    for (const member of members) await this.setEnabled(member.name, enabled);
    return true;
  }

  /** 导入技能包：ZIP 存到磁盘、文件解压到磁盘，派生技能登记进锁。 */
  async importPack(input: SkillImportPackInput): Promise<SkillImportPackResult> {
    return this.withLock(async () => {
      const packId = randomUUID();
      const now = new Date().toISOString();
      const archiveRelative = join(".archives", `${packId}.zip`);
      await atomicWrite(join(this.root, archiveRelative), input.archive);
      const staging = join(this.root, ".staging", packId);
      const extracted = await extractSkillArchive(input.archive, staging, input.path);
      const lock = await this.readLock();
      const created: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];
      try {
        for (const skill of extracted.skills) {
          const existing = lock.skills[skill.name];
          if (existing && !input.overwrite) {
            skipped.push(skill.name);
            continue;
          }
          if (existing && existing.source === "system") {
            skipped.push(skill.name);
            continue;
          }
          if (existing) await rm(this.skillDir(skill.name), { recursive: true, force: true });
          const source = join(staging, skill.folder);
          await cp(source, this.skillDir(skill.name), { recursive: true });
          lock.skills[skill.name] = {
            source: input.source,
            sourceType: input.source,
            sourceUrl: input.sourceUrl ?? input.sourceValue,
            sourceValue: input.sourceValue,
            ...(input.ref ? { ref: input.ref } : {}),
            ...(input.commit ? { commit: input.commit } : {}),
            skillPath: skill.sourcePath,
            skillFile: "SKILL.md",
            computedHash: (await this.folderHash(skill.name))!,
            installedAt: existing?.installedAt ?? now,
            updatedAt: now,
            packId,
            packName: input.name,
            archive: archiveRelative.replace(/\\/g, "/"),
          };
          created.push(skill.name);
        }
        await this.writeLock(lock);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await this.refresh();
      const pack = (await this.listPacks()).find((entry) => entry.id === packId);
      return {
        pack: pack ?? {
          id: packId, name: input.name, size: input.archive.byteLength, source: input.source,
          sourceValue: input.sourceValue, enabled: true, skillCount: 0,
          createdAt: now, updatedAt: now, status: "tracked",
        },
        created, skipped, errors, issues: extracted.issues,
      };
    });
  }

  async deletePack(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const lock = await this.readLock();
      const members = Object.entries(lock.skills).filter(([, entry]) => entry.packId === id);
      if (members.length === 0) return false;
      for (const [name] of members) {
        await rm(this.skillDir(name), { recursive: true, force: true });
        delete lock.skills[name];
      }
      await rm(this.archivePath(id), { force: true });
      await this.writeLock(lock);
      await this.refresh();
      return true;
    });
  }

  /**
   * 按锁里记录的来源重新拉取技能包并替换文件，类似 npx skills update。
   * 来源不可复现（手动上传且无 URL）时拒绝更新。
   */
  async updatePack(
    id: string,
    fetchArchive: (entry: SkillLockEntry) => Promise<SkillPackFetchResult>,
  ): Promise<{ pack: ManagedSkillPack; updated: string[]; removed: string[] }> {
    return this.withLock(async () => {
      const lock = await this.readLock();
      const members = Object.entries(lock.skills).filter(([, entry]) => entry.packId === id);
      if (members.length === 0) throw new Error("skill pack not found");
      const first = members[0]![1];
      if (!first.sourceUrl && !first.sourceValue) throw new Error("this pack has no reproducible source");
      const fetched = await fetchArchive(first);
      const now = new Date().toISOString();
      await atomicWrite(this.archivePath(id), fetched.archive);
      const staging = join(this.root, ".staging", `update-${id}`);
      const extracted = await extractSkillArchive(fetched.archive, staging, first.skillPath?.replace(/\/[^/]+$/, ""));
      const updated: string[] = [];
      const removed: string[] = [];
      try {
        const incoming = new Set(extracted.skills.map((skill) => skill.name));
        for (const [name] of members) {
          if (!incoming.has(name)) {
            await rm(this.skillDir(name), { recursive: true, force: true });
            delete lock.skills[name];
            removed.push(name);
          }
        }
        for (const skill of extracted.skills) {
          const existing = lock.skills[skill.name];
          if (existing?.source === "system") continue;
          if (existing) await rm(this.skillDir(skill.name), { recursive: true, force: true });
          await cp(join(staging, skill.folder), this.skillDir(skill.name), { recursive: true });
          lock.skills[skill.name] = {
            source: first.source,
            sourceType: first.sourceType,
            sourceUrl: fetched.sourceUrl ?? first.sourceUrl ?? first.sourceValue,
            ...(fetched.commit ? { commit: fetched.commit } : first.commit ? { commit: first.commit } : {}),
            ...(first.ref ? { ref: first.ref } : {}),
            skillPath: skill.sourcePath,
            skillFile: "SKILL.md",
            computedHash: (await this.folderHash(skill.name))!,
            installedAt: existing?.installedAt ?? now,
            updatedAt: now,
            packId: id,
            packName: first.packName ?? id,
            archive: `.archives/${id}.zip`,
          };
          updated.push(skill.name);
        }
        await this.writeLock(lock);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await this.refresh();
      const pack = (await this.listPacks()).find((entry) => entry.id === id);
      return {
        pack: pack ?? {
          id, name: first.packName ?? id, size: fetched.archive.byteLength, source: first.source,
          sourceValue: first.sourceUrl ?? first.sourceValue, enabled: true, skillCount: updated.length,
          createdAt: now, updatedAt: now, status: "tracked",
        },
        updated,
        removed,
      };
    });
  }

  /**
   * 校验锁与磁盘是否一致，必要时从本地 ZIP 恢复。frozen 为 true 时任何无法恢复的条目都报错，
   * 对应 npx skills 的 --frozen-lockfile 语义。
   */
  async verifyAndRestore(frozen = false): Promise<Array<{ name: string; status: SkillStatus; restored: boolean; error?: string }>> {
    return this.withLock(async () => {
      const lock = await this.readLock();
      const report: Array<{ name: string; status: SkillStatus; restored: boolean; error?: string }> = [];
      for (const [name, entry] of Object.entries(lock.skills)) {
        const hash = await this.folderHash(name);
        if (hash === entry.computedHash) {
          report.push({ name, status: "tracked", restored: false });
          continue;
        }
        const status: SkillStatus = hash === undefined ? "missing" : "modified";
        if (!entry.archive) {
          const error = "no local archive to restore this skill";
          if (frozen) throw new Error(`${name}: ${error}`);
          report.push({ name, status, restored: false, error });
          continue;
        }
        try {
          const archive = await readFile(join(this.root, entry.archive));
          const staging = join(this.root, ".staging", `restore-${randomUUID()}`);
          // 锁里记录的是 SKILL.md 路径，解压前缀要用它所在的目录。
          const prefix = entry.skillPath?.includes("/")
            ? entry.skillPath.slice(0, entry.skillPath.lastIndexOf("/"))
            : undefined;
          const extracted = await extractSkillArchive(archive, staging, prefix);
          const match = extracted.skills.find((skill) => skill.name === name);
          if (!match) throw new Error("skill not found in the stored archive");
          await rm(this.skillDir(name), { recursive: true, force: true });
          await cp(join(staging, match.folder), this.skillDir(name), { recursive: true });
          await rm(staging, { recursive: true, force: true });
          entry.computedHash = (await this.folderHash(name))!;
          entry.updatedAt = new Date().toISOString();
          await this.writeLock(lock);
          report.push({ name, status, restored: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (frozen) throw new Error(`${name}: ${message}`, { cause: error });
          report.push({ name, status, restored: false, error: message });
        }
      }
      await this.refresh();
      return report;
    });
  }

  /** 系统技能种子：缺失则写入，文档版本落后则刷新，但保留管理员的停用选择。 */
  async seedSystemSkills(): Promise<void> {
    await this.withLock(async () => {
      const lock = await this.readLock();
      // 种子互相独立，并发写入以免启动等待多次串行磁盘往返。
      const updates = await Promise.all(defaultSkillDocuments.map(async (source) => {
        const parsed = parseSkillDocument(source);
        const entry = lock.skills[parsed.name];
        let previousDocument = "";
        let skillFile = "SKILL.md";
        if (entry?.source === "system") {
          const found = await this.findSkillFile(parsed.name, entry.skillFile);
          if (found) {
            skillFile = found;
            previousDocument = await readFile(join(this.skillDir(parsed.name), skillFile), "utf8").catch(() => "");
          }
          if (previousDocument) {
            const previous = parseSkillDocument(previousDocument);
            if (previous.metadata["corvex-seed-version"] === SKILL_SEED_VERSION) return undefined;
          }
        }
        let document = ensureQuickActionMetadata(source);
        if (previousDocument) {
          const previous = parseSkillDocument(previousDocument);
          if (!previous.enabled) {
            document = rewriteFrontmatter(document, { "corvex-enabled": "false" });
          }
        }
        await this.writeSkillDocument(parsed.name, document, skillFile);
        const now = new Date().toISOString();
        return {
          name: parsed.name,
          installedAt: entry?.installedAt ?? now,
          updatedAt: now,
          skillFile,
          computedHash: computeSkillHash([{ path: skillFile, content: Buffer.from(document) }]),
        };
      }));
      let changed = false;
      for (const update of updates) {
        if (!update) continue;
        lock.skills[update.name] = {
          source: "system", sourceType: "system", sourceUrl: "",
          computedHash: update.computedHash,
          installedAt: update.installedAt,
          updatedAt: update.updatedAt,
          skillFile: update.skillFile,
        };
        changed = true;
      }
      if (changed) {
        await this.writeLock(lock);
        await this.refresh();
      }
    });
  }

  /**
   * 一次性把旧 SQLite 里的技能与技能包导出到磁盘，成功后清空旧表。
   * 已有锁文件说明迁移已完成，绝不重复导出覆盖管理员的修改。
   */
  async migrateFromStore(store: AppStore): Promise<{ skills: number; packs: number }> {
    return this.withLock(async () => {
      if (await this.lockExists()) return { skills: 0, packs: 0 };
      const legacySkills = store.legacySkillsForMigration();
      const legacyPacks = store.legacySkillPacksForMigration();
      const lock = emptyLock();
      const now = new Date().toISOString();
      for (const pack of legacyPacks) {
        if (pack.archive) await atomicWrite(this.archivePath(pack.id), pack.archive);
      }
      for (const skill of legacySkills) {
        if (!isValidSkillName(skill.name)) continue;
        await this.writeSkillDocument(skill.name, skill.document);
        lock.skills[skill.name] = {
          source: skill.isSystem ? "system" : "manual",
          sourceType: skill.isSystem ? "system" : "manual",
          sourceUrl: "",
          skillFile: "SKILL.md",
          computedHash: (await this.folderHash(skill.name))!,
          installedAt: skill.createdAt || now,
          updatedAt: skill.updatedAt || now,
          ...(skill.packId ? {
            packId: skill.packId,
            packName: legacyPacks.find((pack) => pack.id === skill.packId)?.name ?? skill.packId,
            archive: `.archives/${skill.packId}.zip`,
          } : {}),
        };
      }
      await this.writeLock(lock);
      store.dropSkillTables();
      await this.refresh();
      return { skills: Object.keys(lock.skills).length, packs: legacyPacks.length };
    });
  }

  private async lockExists(): Promise<boolean> {
    try {
      await stat(this.lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

/** 只改 frontmatter 的 metadata 标量，保留命令数组等结构化字段与正文。 */
function rewriteFrontmatter(document: string, metadata: Record<string, string | undefined>): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(document.trim());
  if (!match) return document;
  let front: unknown;
  try {
    front = YAML.parse(match[1]);
  } catch {
    return document;
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) return document;
  const header = front as Record<string, unknown>;
  const existing = header.metadata && typeof header.metadata === "object" && !Array.isArray(header.metadata)
    ? header.metadata as Record<string, unknown>
    : {};
  const merged: Record<string, unknown> = { ...existing, ...metadata };
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) delete merged[key];
  }
  header.metadata = merged;
  return `---\n${YAML.stringify(header, { lineWidth: 0 }).trim()}\n---\n\n${match[2].trim()}\n`;
}
