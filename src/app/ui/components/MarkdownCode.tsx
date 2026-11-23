import { isValidElement, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { ComponentProps } from "@ant-design/x-markdown";
import type { Copy } from "../i18n.js";
import { highlightCode } from "../codeHighlight.js";
import { CheckIcon, CopyIcon } from "./icons.js";

/** 图表渲染器按需加载，普通代码块不会引入 Mermaid 的体积。 */
const MarkdownDiagram = lazy(() => import("./MarkdownDiagram.js"));

/** 从 XMarkdown 传入的已解析 React 子节点里取回纯文本源码。 */
function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

interface CodeProps extends ComponentProps {
  /** 由 componentsProps 注入，保持组件引用稳定。 */
  copy?: Copy;
  copiedLabel?: string;
  failedLabel?: string;
  diagramLoadingLabel?: string;
  diagramFailedLabel?: string;
}

type CopyState = "idle" | "copied" | "failed";

/** 复制按钮用局部状态反馈，不调用全局 message（控制台的 CSP 不允许无 nonce 的静态提示）。 */
function CopyButton({ source, copy, copiedLabel, failedLabel }: {
  source: string;
  copy: Copy;
  copiedLabel: string;
  failedLabel: string;
}) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  const title = state === "copied" ? copiedLabel : state === "failed" ? failedLabel : copy.copyMessage;
  return (
    <button
      type="button"
      className={`conversation-code-copy${state === "copied" ? " is-copied" : ""}${state === "failed" ? " is-failed" : ""}`}
      onClick={() => void copyCode()}
      aria-label={title}
      title={title}
    >
      {state === "copied" ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** 替换 XMarkdown 的 code 节点：块级代码高亮并提供复制，行内代码保持原样。 */
function MarkdownCode({ children, block, lang, streamStatus, copy, copiedLabel, failedLabel, diagramLoadingLabel, diagramFailedLabel }: CodeProps) {
  if (!block) return <code>{children}</code>;
  const source = nodeText(children);
  const language = (lang ?? "").split(/\s+/)[0]?.toLowerCase();
  if (language === "mermaid" || language === "flowchart") {
    // 流式生成中的围栏可能不完整，等文本落定再渲染，避免反复报错。
    if (streamStatus === "loading") return <span className="conversation-diagram pending" />;
    return (
      <Suspense fallback={<span className="conversation-diagram pending" />}>
        <MarkdownDiagram
          source={source}
          loadingLabel={diagramLoadingLabel ?? "Rendering diagram…"}
          failedLabel={diagramFailedLabel ?? "Diagram failed to render"}
        />
      </Suspense>
    );
  }
  return (
    <span className="conversation-code-block">
      {/* 流式生成中的代码块不完整，不提供复制。 */}
      {copy && streamStatus !== "loading" ? (
        <CopyButton
          source={source}
          copy={copy}
          copiedLabel={copiedLabel ?? copy.copyMessage}
          failedLabel={failedLabel ?? copy.copyMessage}
        />
      ) : null}
      <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightCode(source, lang) }} />
    </span>
  );
}

/** 稳定的 components 引用，避免流式渲染时因为内联对象导致代码块反复挂载。 */
export const markdownCodeComponents = { code: MarkdownCode };
