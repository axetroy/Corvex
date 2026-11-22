import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import * as monaco from "monaco-editor";
import { languageIdForPath } from "./language.js";

export const lightTheme = "corvex-light";
export const darkTheme = "corvex-dark";

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

export function defineThemes(): void {
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
      "diffEditor.insertedTextBackground": "#d8f3e4",
      "diffEditor.removedTextBackground": "#ffe0e0",
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
      "diffEditor.insertedTextBackground": "#173d2b",
      "diffEditor.removedTextBackground": "#4a2024",
    },
  });
}

defineThemes();

/** 先用显式映射，再回退到 Monaco 自己的扩展名表。 */
export function languageForPath(path: string): string {
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

export { monaco };
