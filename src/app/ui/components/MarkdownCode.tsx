import { isValidElement, type ReactNode } from "react";
import type { ComponentProps } from "@ant-design/x-markdown";
import { highlightCode } from "../codeHighlight.js";

/** 从 XMarkdown 传入的已解析 React 子节点里取回纯文本源码。 */
function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

/** 替换 XMarkdown 的 code 节点：块级代码走 highlight.js，行内代码保持原样。 */
function MarkdownCode({ children, block, lang }: ComponentProps) {
  if (!block) return <code>{children}</code>;
  return (
    <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(nodeText(children), lang) }} />
  );
}

/** 稳定的 components 引用，避免流式渲染时因为内联对象导致代码块反复挂载。 */
export const markdownCodeComponents = { code: MarkdownCode };
