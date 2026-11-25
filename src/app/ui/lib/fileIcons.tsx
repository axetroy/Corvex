import type { ReactNode } from "react";
import {
  SiGnubash,
  SiC,
  SiCplusplus,
  SiCss,
  SiDocker,
  SiGit,
  SiGo,
  SiHtml5,
  SiOpenjdk,
  SiJavascript,
  SiJson,
  SiKotlin,
  SiLua,
  SiMarkdown,
  SiNodedotjs,
  SiPerl,
  SiPhp,
  SiPython,
  SiReact,
  SiRuby,
  SiRust,
  SiSass,
  SiShell,
  SiSwift,
  SiToml,
  SiTypescript,
  SiVuedotjs,
  SiXml,
  SiYaml,
  SiDotnet,
} from "react-icons/si";
import type { IconType } from "react-icons";
import type { FileEntry } from "../../files/source.js";
import { FileIcon, FolderIcon, FolderOpenIcon } from "../components/icons.js";

interface IconChoice {
  Icon: IconType;
  color: string;
}

/** 常见扩展名到开源图标（Simple Icons，随 react-icons 打包，无需联网）。 */
const iconByExtension: Record<string, IconChoice> = {
  ts: { Icon: SiTypescript, color: "#3178c6" },
  tsx: { Icon: SiReact, color: "#61dafb" },
  js: { Icon: SiJavascript, color: "#f7df1e" },
  jsx: { Icon: SiReact, color: "#61dafb" },
  mjs: { Icon: SiJavascript, color: "#f7df1e" },
  cjs: { Icon: SiNodedotjs, color: "#339933" },
  json: { Icon: SiJson, color: "#8a8a8a" },
  py: { Icon: SiPython, color: "#3776ab" },
  md: { Icon: SiMarkdown, color: "#6b7a90" },
  css: { Icon: SiCss, color: "#663399" },
  scss: { Icon: SiSass, color: "#cd6799" },
  sass: { Icon: SiSass, color: "#cd6799" },
  html: { Icon: SiHtml5, color: "#e34f26" },
  htm: { Icon: SiHtml5, color: "#e34f26" },
  vue: { Icon: SiVuedotjs, color: "#42b883" },
  rs: { Icon: SiRust, color: "#dea584" },
  go: { Icon: SiGo, color: "#00add8" },
  java: { Icon: SiOpenjdk, color: "#e76f00" },
  sh: { Icon: SiGnubash, color: "#89e051" },
  bash: { Icon: SiGnubash, color: "#89e051" },
  zsh: { Icon: SiShell, color: "#89e051" },
  yml: { Icon: SiYaml, color: "#cb171e" },
  yaml: { Icon: SiYaml, color: "#cb171e" },
  toml: { Icon: SiToml, color: "#9c4221" },
  php: { Icon: SiPhp, color: "#777bb4" },
  rb: { Icon: SiRuby, color: "#cc342d" },
  c: { Icon: SiC, color: "#a8b9cc" },
  h: { Icon: SiC, color: "#a8b9cc" },
  cpp: { Icon: SiCplusplus, color: "#00599c" },
  cc: { Icon: SiCplusplus, color: "#00599c" },
  cs: { Icon: SiDotnet, color: "#68217a" },
  swift: { Icon: SiSwift, color: "#f05138" },
  kt: { Icon: SiKotlin, color: "#a97bff" },
  lua: { Icon: SiLua, color: "#000080" },
  pl: { Icon: SiPerl, color: "#0298c3" },
  xml: { Icon: SiXml, color: "#e44d26" },
  svg: { Icon: SiXml, color: "#e44d26" },
};

const iconByFileName: Record<string, IconChoice> = {
  dockerfile: { Icon: SiDocker, color: "#2496ed" },
  ".gitignore": { Icon: SiGit, color: "#f05033" },
  ".gitattributes": { Icon: SiGit, color: "#f05033" },
  ".dockerignore": { Icon: SiDocker, color: "#2496ed" },
};

/** 按条目类型与文件名返回图标；未知类型使用通用文件/目录图标。 */
export function renderFileIcon(name: string, type: FileEntry["type"], open = false): ReactNode {
  if (type === "directory") {
    return open ? <FolderOpenIcon className="file-tree-icon folder" /> : <FolderIcon className="file-tree-icon folder" />;
  }
  const choice = iconByFileName[name.toLowerCase()] ?? iconByExtension[name.split(".").pop()?.toLowerCase() ?? ""];
  if (choice) {
    const { Icon, color } = choice;
    return <Icon className="file-tree-icon" style={{ color }} aria-hidden="true" />;
  }
  return <FileIcon className="file-tree-icon" />;
}
