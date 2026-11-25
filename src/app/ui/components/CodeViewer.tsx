import { useEffect, useRef } from "react";
import { darkTheme, languageForPath, lightTheme, monaco } from "../lib/monaco.js";

interface Props {
  path: string;
  value: string;
  /** 当前界面语言下的只读提示，覆盖 Monaco 内置的英文 NLS 文案。 */
  readOnlyMessage: string;
}

/**
 * 只读代码查看器：用 Monaco 的 tokenizer 覆盖绝大多数语言，
 * 主题跟随控制台的 data-theme，容器尺寸变化时重新布局。
 */
export function CodeViewer({ path, value, readOnlyMessage }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  const initialRef = useRef({ path, value, readOnlyMessage });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const model = monaco.editor.createModel(initialRef.current.value, languageForPath(initialRef.current.path));
    const editor = monaco.editor.create(container, {
      model,
      readOnly: true,
      domReadOnly: true,
      readOnlyMessage: { value: initialRef.current.readOnlyMessage },
      automaticLayout: false,
      minimap: { enabled: false },
      fontSize: 12,
      lineHeight: 18,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      contextmenu: false,
      inlayHints: { enabled: "off" },
      lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.Off },
      glyphMargin: false,
      folding: true,
      padding: { top: 6, bottom: 6 },
      wordWrap: "off",
      tabSize: 2,
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });
    modelRef.current = model;
    editorRef.current = editor;
    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(container);
    return () => {
      observer.disconnect();
      editor.dispose();
      model.dispose();
      modelRef.current = null;
      editorRef.current = null;
    };
    // 编辑器只创建一次，内容/语言由下面的 effect 增量更新。
  }, []);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    model.setValue(value);
    editorRef.current?.setPosition({ lineNumber: 1, column: 1 });
  }, [value]);

  useEffect(() => {
    const model = modelRef.current;
    if (model) monaco.editor.setModelLanguage(model, languageForPath(path));
  }, [path]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnlyMessage: { value: readOnlyMessage } });
  }, [readOnlyMessage]);

  useEffect(() => {
    const apply = () => monaco.editor.setTheme(document.documentElement.dataset.theme === "dark" ? darkTheme : lightTheme);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return <div className="conversation-code-viewer" ref={containerRef} />;
}
