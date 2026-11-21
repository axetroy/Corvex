import hljs from "highlight.js/lib/common";

/**
 * 聊天输出中的代码块高亮：把 Markdown 围栏的语言标记映射到 highlight.js 语言名，
 * 未识别或未支持的语言自动识别，最终失败时退回转义后的纯文本。
 * 模型输出不可信，返回值只作为已转义的 HTML 注入。
 */
const hljsLanguageByAlias: Record<string, string> = {
  ts: "typescript", typescript: "typescript", tsx: "typescript",
  js: "javascript", javascript: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  py: "python", python: "python",
  md: "markdown", markdown: "markdown",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  rs: "rust", rust: "rust", go: "go", golang: "go", java: "java",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash", shellsession: "bash",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  php: "php", rb: "ruby", ruby: "ruby",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", "c++": "cpp", cs: "csharp", csharp: "csharp",
  swift: "swift", kt: "kotlin", kotlin: "kotlin", lua: "lua", pl: "perl", perl: "perl",
  sql: "sql", dockerfile: "dockerfile", docker: "dockerfile",
};

/** 转义 HTML 特殊字符，作为高亮失败时的安全回退。 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

/** 返回可安全注入的 HTML；highlight.js 自身会转义源码中的标签。 */
export function highlightCode(code: string, language?: string): string {
  const alias = language?.trim().toLowerCase().split(/\s+/)[0] ?? "";
  const requested = hljsLanguageByAlias[alias] ?? alias;
  try {
    if (requested && hljs.getLanguage(requested)) {
      return hljs.highlight(code, { language: requested, ignoreIllegals: true }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}
