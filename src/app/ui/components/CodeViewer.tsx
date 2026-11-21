import { useEffect, useRef } from "react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import * as monaco from "monaco-editor";
import { languageIdForPath } from "../language.js";

// 内置语言特性（TS/JSON/CSS/HTML）会请求各自的 worker，不能统一用 editor worker。
type MonacoEnvironmentHost = {
  MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
};
(self as unknown as MonacoEnvironmentHost).MonacoEnvironment = {
  getWorker: (_workerId, label) => {
    if (label === "typescript" || label === "javascript") return new TsWorker();
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    return new EditorWorker();
  },
};

const lightTheme = "corvex-light";
const darkTheme = "corvex-dark";

function defineThemes(): void {
  monaco.editor.defineTheme(lightTheme, {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "71808E" },
      { token: "keyword", foreground: "A626A4" },
      { token: "string", foreground: "0A7B55" },
      { token: "number", foreground: "986801" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#17212b",
      "editorLineNumber.foreground": "#9aa6b2",
      "editorLineNumber.activeForeground": "#536271",
      "editor.lineHighlightBackground": "#f7f9fb",
      "editor.selectionBackground": "#e3eefb",
      "editorCursor.foreground": "#1769aa",
      "editorIndentGuide.background1": "#e6eaed",
      "editorGutter.background": "#ffffff",
    },
  });
  monaco.editor.defineTheme(darkTheme, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8B949E" },
      { token: "keyword", foreground: "D2A8FF" },
      { token: "string", foreground: "A5D6FF" },
      { token: "number", foreground: "F0A860" },
    ],
    colors: {
      "editor.background": "#161f2a",
      "editor.foreground": "#e7edf3",
      "editorLineNumber.foreground": "#6f8091",
      "editorLineNumber.activeForeground": "#a9b8c6",
      "editor.lineHighlightBackground": "#131b24",
      "editor.selectionBackground": "#1b344a",
      "editorCursor.foreground": "#4a9fe0",
      "editorIndentGuide.background1": "#2b3a48",
      "editorGutter.background": "#161f2a",
    },
  });
}

defineThemes();

/** 先用显式映射（含 Monaco 未注册的 .mjs/.zsh/Dockerfile 等），再回退到 Monaco 自己的扩展名表。 */
function languageForPath(path: string): string {
  const explicit = languageIdForPath(path);
  if (explicit) return explicit;
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const extension = path.slice(dot).toLowerCase();
  for (const language of monaco.languages.getLanguages()) {
    if (language.extensions?.some((candidate: string) => candidate.toLowerCase() === extension)) return language.id;
  }
  return "plaintext";
}

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
