import type { TreeDataNode } from "antd";
import type { FileEntry } from "../../files/source.js";

/** 文件树节点：key 用仓库相对路径，既唯一又能直接作为接口参数。 */
export interface FileTreeNode extends TreeDataNode {
  key: string;
  title: string;
  path: string;
  type: FileEntry["type"];
  isLeaf: boolean;
}

/** 把一层目录条目转换成 antd Tree 节点；目录标记为可继续加载。 */
export function entriesToTreeNodes(entries: readonly FileEntry[], parentPath: string): FileTreeNode[] {
  return entries.map((entry) => {
    const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    const directory = entry.type === "directory";
    return {
      key: path,
      path,
      title: entry.name,
      type: entry.type,
      isLeaf: !directory,
      ...(directory ? {} : { selectable: true }),
    };
  });
}

/** 用新加载的子节点替换某个目录节点的内容，保留其它分支。 */
export function mergeTreeChildren(
  nodes: readonly FileTreeNode[],
  parentPath: string,
  children: FileTreeNode[],
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === parentPath) return { ...node, children };
    if (node.children) {
      return { ...node, children: mergeTreeChildren(node.children as FileTreeNode[], parentPath, children) };
    }
    return node;
  });
}

/** 面包屑：把 `src/app/ui/a.ts` 拆成可展示的层级路径。 */
export function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}
