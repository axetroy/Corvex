/**
 * Git ref 名称校验：允许 Unicode（含中文）分支名，同时挡住 Git 不允许或易被利用的形式。
 * 工具参数 schema 与运行时校验共用同一规则，避免「工具放行了但执行层拒绝」。
 */

/** 首字符不能是 - / . / 控制字符 / Git 禁用字符；其余字符允许字母、数字、Unicode 与 . _ / - */
export const branchNamePatternSource = "^[A-Za-z0-9\\u0080-\\uFFFF][A-Za-z0-9\\u0080-\\uFFFF._/-]{0,199}$";

const branchNamePattern = new RegExp(branchNamePatternSource);

/** 校验本地/远端分支名；maxLength 默认 200，与 Git Manager 的历史上限一致。 */
export function isValidBranchName(name: string, maxLength = 200): boolean {
  if (name.length > maxLength || !branchNamePattern.test(name)) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return name !== "@";
}
