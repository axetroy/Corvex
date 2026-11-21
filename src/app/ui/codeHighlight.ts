import hljs from "highlight.js/lib/common";

/** 扩展名到 highlight.js 语言名；未列出的走自动识别。 */
const languageByExtension: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  md: "markdown",
  css: "css",
  scss: "scss",
  sass: "scss",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  rs: "rust",
  go: "go",
  java: "java",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  php: "php",
  rb: "ruby",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
  pl: "perl",
  sql: "sql",
  Dockerfile: "dockerfile",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

/** 返回可安全注入的 HTML；highlight.js 自身会转义源码中的标签。 */
export function highlightCode(code: string, filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const language = languageByExtension[extension] ?? (filename.toLowerCase() === "dockerfile" ? "dockerfile" : "");
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}
