/**
 * 从统一的 diff 文本还原出「修改前 / 修改后」两份内容，供 Monaco diff 编辑器展示。
 * 补丁只包含 hunk 范围内的上下文，因此还原的是有界片段而不是完整文件。
 */
export function parseUnifiedDiff(patch: string): { original: string; modified: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ") || line.startsWith("index ") ||
        line.startsWith("--- ") || line.startsWith("+++ ") ||
        line.startsWith("@@") || line.startsWith("\\ No newline")) {
      continue;
    }
    if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  return { original: before.join("\n"), modified: after.join("\n") };
}
