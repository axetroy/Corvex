import { useEffect, useRef } from "react";
import { darkTheme, lightTheme, monaco } from "../lib/monaco.js";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/** SKILL.md 编辑器：Monaco 负责 YAML/Markdown 高亮，主题跟随控制台。 */
export function SkillEditor({ value, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const changeRef = useRef(onChange);

  useEffect(() => { changeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const model = monaco.editor.createModel(value, "markdown");
    const theme = document.documentElement.dataset.theme === "dark" ? darkTheme : lightTheme;
    const editor = monaco.editor.create(container, {
      model,
      theme,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      lineHeight: 18,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollBeyondLastLine: false,
      wordWrap: "on",
      overviewRulerBorder: false,
      tabSize: 2,
    });
    const subscription = model.onDidChangeContent(() => changeRef.current(model.getValue()));
    editor.layout();
    editorRef.current = editor;
    modelRef.current = model;
    // Modal 展开动画期间容器可能还是 0 尺寸，等两帧再强制布局一次。
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => editor.layout()));
    const resizeObserver = new ResizeObserver(() => editor.layout());
    resizeObserver.observe(container);
    const observer = new MutationObserver(() => {
      const next = document.documentElement.dataset.theme === "dark" ? darkTheme : lightTheme;
      monaco.editor.setTheme(next);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      observer.disconnect();
      subscription.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // 编辑器只挂载一次；value 的后续变化由内部 model 持有。
  }, []);

  return <div ref={containerRef} className="skill-manager-editor" />;
}
