import { useEffect, useRef, useState } from "react";

interface Props {
  source: string;
  loadingLabel: string;
  failedLabel: string;
}

let renderSequence = 0;

function currentTheme(): "dark" | "default" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

/**
 * Mermaid 图表按需加载：只有回复里出现 ```mermaid 围栏时才会下载这个 chunk。
 * 使用 strict 安全级别，节点文本走 DOMPurify，且只把生成的 SVG 写入隔离容器。
 */
export default function MarkdownDiagram({ source, loadingLabel, failedLabel }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState(currentTheme);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    const element = container.current;
    if (!element) return;
    setState("loading");

    const render = async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme,
          flowchart: { useMaxWidth: true, htmlLabels: true },
          suppressErrorRendering: true,
        });
        const { svg } = await mermaid.render(`corvex-diagram-${++renderSequence}`, source);
        if (active && element) {
          // Mermaid 把主题 CSS 作为 SVG 内的 <style> 输出；nonce 制 CSP 必须在解析时
          // 就带上 nonce，插入后再补属性不会让样式生效。
          const nonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;
          element.innerHTML = nonce ? svg.replace(/<style\b/g, `<style nonce="${nonce}"`) : svg;
          setState("ready");
        }
      } catch {
        if (active) setState("failed");
      }
    };
    void render();
    return () => {
      active = false;
      if (element) element.innerHTML = "";
    };
  }, [source, theme]);

  if (state === "failed") return <div className="conversation-diagram is-failed">{failedLabel}</div>;
  return (
    <div className="conversation-diagram">
      <div ref={container} className="conversation-diagram-svg" aria-label="mermaid diagram" />
      {state === "loading" ? <span className="conversation-diagram-loading">{loadingLabel}</span> : null}
    </div>
  );
}
