import { useEffect, useRef } from "react";
import { darkTheme, languageForPath, lightTheme, monaco } from "../monaco.js";
import { parseUnifiedDiff } from "../diff.js";

interface Props {
  path: string;
  patch: string;
  height?: number;
}

/** 只读 diff 查看器：用 Monaco 的并排差异视图展示有界补丁。 */
export function DiffViewer({ path, patch, height = 320 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<monaco.editor.ITextModel[]>([]);
  const initialRef = useRef({ path, patch });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const parsed = parseUnifiedDiff(initialRef.current.patch);
    const language = languageForPath(initialRef.current.path);
    const original = monaco.editor.createModel(parsed.original, language);
    const modified = monaco.editor.createModel(parsed.modified, language);
    const editor = monaco.editor.createDiffEditor(container, {
      automaticLayout: false,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      minimap: { enabled: false },
      fontSize: 12,
      lineHeight: 18,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollBeyondLastLine: false,
      contextmenu: false,
      inlayHints: { enabled: "off" },
      padding: { top: 6, bottom: 6 },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;
    modelsRef.current = [original, modified];
    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(container);
    return () => {
      observer.disconnect();
      editor.dispose();
      original.dispose();
      modified.dispose();
      editorRef.current = null;
      modelsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const [original, modified] = modelsRef.current;
    const parsed = parseUnifiedDiff(patch);
    if (!original || !modified) return;
    if (original.getValue() !== parsed.original) original.setValue(parsed.original);
    if (modified.getValue() !== parsed.modified) modified.setValue(parsed.modified);
    const language = languageForPath(path);
    monaco.editor.setModelLanguage(original, language);
    monaco.editor.setModelLanguage(modified, language);
  }, [path, patch]);

  useEffect(() => {
    const apply = () => monaco.editor.setTheme(document.documentElement.dataset.theme === "dark" ? darkTheme : lightTheme);
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return <div className="conversation-diff-viewer" style={{ height }} ref={containerRef} />;
}
