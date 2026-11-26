/**
 * 虚拟路径协议：模型侧只看到 worktree:// / upload:// / skill:// 三种 URI 或纯相对路径，
 * 绝不接触宿主机绝对路径。本模块负责「虚拟 → 物理」解析与「物理 → 虚拟」展示，
 * 所有 fs 工具入口都必须经过这里，错误信息也统一在这里去掉宿主机路径。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

/** 只读根的逻辑身份；label 在 URI 中作为第二段（upload 为附件 ID，skill 为目录别名）。 */
export interface ReadRoot {
  scheme: "worktree" | "upload" | "skill";
  label: string;
  /** 宿主机绝对路径，仅服务端内部使用，绝不进入模型上下文。 */
  path: string;
}

/** 兼容旧调用：纯字符串数组按「第一个 worktree，其余 skill」解释。 */
export type ReadRootInput = string | ReadRoot;

/** 把字符串根规范化成带协议的 ReadRoot；字符串数组的历史语义保持不变。 */
export function normalizeRoots(input: readonly ReadRootInput[]): ReadRoot[] {
  return input.map((item, index) => {
    if (typeof item !== "string") return item;
    return {
      scheme: index === 0 ? "worktree" as const : "skill" as const,
      label: index === 0 ? "" : basenameLabel(item, index),
      path: resolve(item),
    };
  });
}

function basenameLabel(path: string, index: number): string {
  const parts = resolve(path).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || `skill-${index}`;
}

/**
 * 把模型或内部调用传入的路径统一收敛为 worktree 相对路径。
 * worktree:// 前缀会被剥掉；纯相对路径原样保留；绝对宿主路径与其它协议一律拒绝。
 * 读写工具与 git 工具共用，保证「读写同一个协议」。
 */
export function toWorktreeRelative(input: string): string {
  if (!input.trim() || input.includes("\0")) throw new Error("invalid file path");
  if (isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
    throw new Error("absolute host paths are not accepted; use worktree:// or a worktree-relative path");
  }
  const marker = input.indexOf("://");
  if (marker < 0) return input;
  if (input.slice(0, marker) !== "worktree") {
    throw new Error(`unsupported path scheme "${input.slice(0, marker)}" for a worktree path`);
  }
  return input.slice(marker + 3);
}

/** 给 skill 根分配稳定且唯一的别名，避免不同目录同名时 URI 冲突。 */
export function assignSkillLabels(paths: readonly string[]): string[] {
  const used = new Map<string, number>();
  return paths.map((path, index) => {
    const base = basenameLabel(path, index + 1);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}

export interface ParsedVirtualPath {
  root: ReadRoot;
  /** 相对该根的路径；"." 表示根本身。 */
  relative: string;
}

/**
 * 解析模型传入的路径。绝对路径一律拒绝（这是防泄露的关键），
 * 纯相对路径仍按 worktree 解析，兼容已有调用习惯。
 */
export function parseVirtualPath(input: string, roots: readonly ReadRoot[]): ParsedVirtualPath | { error: string } {
  if (!input.trim() || input.includes("\0")) return { error: "invalid file path" };
  if (isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
    return { error: "absolute host paths are not accepted; use worktree://, upload://, skill:// or a worktree-relative path" };
  }
  const marker = input.indexOf("://");
  if (marker < 0) {
    const root = roots[0];
    if (!root) return { error: "no file read roots are configured" };
    return { root, relative: input };
  }
  const scheme = input.slice(0, marker);
  const rest = input.slice(marker + 3);
  if (scheme === "worktree") {
    const root = roots[0];
    if (!root) return { error: "no file read roots are configured" };
    return { root, relative: rest };
  }
  if (scheme !== "upload" && scheme !== "skill") {
    return { error: `unsupported path scheme "${scheme}"` };
  }
  const slash = rest.indexOf("/");
  const label = slash < 0 ? rest : rest.slice(0, slash);
  const tail = slash < 0 ? "" : rest.slice(slash + 1);
  const root = roots.find((candidate) => candidate.scheme === scheme && candidate.label === label);
  if (!root) return { error: `unknown ${scheme} root "${label}"` };
  return { root, relative: tail || "." };
}

/** 把「根 + 相对路径」渲染成模型可见的虚拟 URI；worktree 根可选省略前缀。 */
export function virtualizePath(root: ReadRoot, relativePath: string): string {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\.?\//, "");
  // 空相对路径表示根本身，不追加 "."，避免替换错误文本时产生 worktree://./src。
  if (!clean) return root.scheme === "worktree" ? "worktree://" : `${root.scheme}://${root.label}`;
  if (root.scheme === "worktree") return `worktree://${clean}`;
  return `${root.scheme}://${root.label}/${clean}`;
}

/** 判断物理路径是否落在某个允许根内；用 relative 判定，避免相邻目录前缀误判。 */
export function isWithinRoot(rootPath: string, candidate: string): boolean {
  const rel = relative(rootPath, resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 物理路径 → 虚拟 URI：找不到匹配根时退化为 <path>，绝不返回宿主机路径。 */
export function virtualizePhysicalPath(path: string, roots: readonly ReadRoot[]): string {
  const resolved = resolve(path);
  const root = roots.find((candidate) => isWithinRoot(candidate.path, resolved));
  return root ? virtualizePath(root, relative(root.path, resolved) || ".") : "<path>";
}

/** 清理工具错误文本：替换已知根前缀，并把残留的绝对路径片段收敛为 <path>。 */
export function virtualizeError(error: unknown, roots: readonly ReadRoot[]): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("outside the configured read-only roots")) return message;
  let safe = message;
  // 先按长度倒序替换，避免父目录先被替换掉导致子目录残留。
  for (const root of [...roots].sort((a, b) => b.path.length - a.path.length)) {
    // worktree 根的虚拟 URI 以 // 结尾，替换后原文还带一个 /，去掉末尾一个避免 ///。
    const prefix = virtualizePath(root, "").replace(/\/$/, "");
    safe = safe.split(root.path).join(prefix);
  }
  // 兜底：任何未被识别的绝对路径（Windows 盘符或 POSIX 多级路径）都不可见。
  // /windows 盘符需排除 worktree:// 这类 URI 中的 "e://" 片段。
  safe = safe.replace(/[a-zA-Z]:[\\/](?![\\/])[^\s"'`]+/g, "<path>");
  // 前面是 : 或 / 时属于虚拟 URI（worktree://x/y），不能误伤。
  safe = safe.replace(/(?<![:\\/])(?:\/[\w.~-]+){2,}/g, "<path>");
  return safe;
}
