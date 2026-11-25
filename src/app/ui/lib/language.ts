/**
 * 文件扩展名到 Monaco language id 的显式映射。
 * 这个模块不依赖 Monaco，浏览器与单测共用；未命中时由调用方回退到 Monaco 自己注册的扩展名。
 */
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
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  php: "php",
  rb: "ruby",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
  pl: "perl",
  sql: "sql",
};

/** 按文件名或扩展名返回 Monaco language id；未知类型返回 undefined。 */
export function languageIdForPath(path: string): string | undefined {
  const filename = path.replace(/\\/g, "/").split("/").at(-1)?.toLowerCase() ?? "";
  // Dockerfile 没有扩展名，按完整文件名匹配。
  if (filename === "dockerfile") return "dockerfile";
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return undefined;
  return languageByExtension[filename.slice(dot + 1)];
}
