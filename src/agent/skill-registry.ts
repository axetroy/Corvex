import { join } from "node:path";
import type { ConversationSkill } from "../model.js";
import { SkillStore, type SkillDiagnostic } from "./skill-store.js";

/** 带作用域的技能视图：全局技能用原名，个人同名技能用 `me:<name>` 命名空间。 */
export interface ScopedSkill extends ConversationSkill {
  scope: "global" | "personal";
  /** 斜杠命令与模型目录里使用的名字。 */
  commandName: string;
}

/**
 * 全局 + 个人技能的分层注册表。
 * 每条每轮只取当前用户的合并快照；个人目录按 userId 隔离，绝不跨用户读取。
 */
export class SkillRegistry {
  readonly global: SkillStore;
  private readonly personal = new Map<string, SkillStore>();
  private readonly initialized = new Set<string>();

  constructor(private readonly storageRoot: string) {
    this.global = new SkillStore(join(storageRoot, "skills"));
  }

  /** 用户 ID 来自服务端身份，只用作目录名；拒绝任何路径字符。 */
  forUser(userId: string): SkillStore {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("invalid user id for personal skills");
    let store = this.personal.get(userId);
    if (!store) {
      store = new SkillStore(join(this.storageRoot, "user-skills", userId));
      this.personal.set(userId, store);
    }
    return store;
  }

  /** 启动时刷新全局技能；个人技能在首次访问时按需加载。 */
  async initialize(): Promise<void> {
    await this.global.refresh();
  }

  async ensureUser(userId: string): Promise<void> {
    if (this.initialized.has(userId)) {
      await this.refreshIfStale(userId);
      return;
    }
    // 全局缓存在启动时由 seed/迁移刷新，技能写操作也会自行刷新，这里只加载个人技能。
    await this.forUser(userId).refresh();
    this.initialized.add(userId);
  }

  /** 每轮按磁盘指纹刷新全局与个人缓存，让直接编辑文件立即生效。 */
  async refreshIfStale(userId: string): Promise<void> {
    await this.global.refreshIfStale();
    await this.forUser(userId).refreshIfStale();
  }

  /** 管理端检索技能诊断，区分全局与个人。 */
  async diagnosticsForUser(userId: string): Promise<Array<SkillDiagnostic & { scope: "global" | "personal" }>> {
    const [globalIssues, personalIssues] = await Promise.all([
      this.global.diagnostics(),
      this.forUser(userId).diagnostics(),
    ]);
    return [
      ...globalIssues.map((item) => ({ ...item, scope: "global" as const })),
      ...personalIssues.map((item) => ({ ...item, scope: "personal" as const })),
    ];
  }

  /** 合并视图：全局优先，个人同名技能不丢弃而是加 `me:` 前缀。 */
  listForUser(userId: string): ScopedSkill[] {
    const globalSkills = this.global.listCached();
    const globalNames = new Set(globalSkills.map((skill) => skill.name));
    const merged: ScopedSkill[] = globalSkills.map((skill) => ({ ...skill, scope: "global", commandName: skill.name }));
    for (const skill of this.forUser(userId).listCached()) {
      merged.push({
        ...skill,
        scope: "personal",
        commandName: globalNames.has(skill.name) ? `me:${skill.name}` : skill.name,
      });
    }
    return merged;
  }

  /** 按斜杠命令名解析：裸名优先全局，`me:` 前缀固定取个人技能。 */
  resolve(userId: string, commandName: string): ScopedSkill | undefined {
    if (commandName.startsWith("me:")) {
      return this.listForUser(userId).find((skill) => skill.scope === "personal" && skill.commandName === commandName);
    }
    return this.listForUser(userId).find((skill) => skill.commandName === commandName);
  }
}
