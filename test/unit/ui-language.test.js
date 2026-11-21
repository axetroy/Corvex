import { describe, expect, it } from "vitest";
import { languageIdForPath } from "../../src/app/ui/language.ts";

describe("code viewer language mapping", () => {
  it("maps the configured extensions to Monaco language ids", () => {
    const cases = {
      "a.ts": "typescript",
      "a.tsx": "typescript",
      "a.js": "javascript",
      "a.jsx": "javascript",
      "a.mjs": "javascript",
      "a.cjs": "javascript",
      "a.json": "json",
      "a.py": "python",
      "a.md": "markdown",
      "a.css": "css",
      "a.scss": "scss",
      "a.sass": "scss",
      "a.html": "xml",
      "a.htm": "xml",
      "a.xml": "xml",
      "a.svg": "xml",
      "a.vue": "xml",
      "a.rs": "rust",
      "a.go": "go",
      "a.java": "java",
      "a.sh": "shell",
      "a.bash": "shell",
      "a.zsh": "shell",
      "a.yml": "yaml",
      "a.yaml": "yaml",
      "a.toml": "ini",
      "a.php": "php",
      "a.rb": "ruby",
      "a.c": "cpp",
      "a.h": "cpp",
      "a.cpp": "cpp",
      "a.cc": "cpp",
      "a.cs": "csharp",
      "a.swift": "swift",
      "a.kt": "kotlin",
      "a.lua": "lua",
      "a.pl": "perl",
      "a.sql": "sql",
      Dockerfile: "dockerfile",
    };
    for (const [path, expected] of Object.entries(cases)) {
      expect(languageIdForPath(path), path).toBe(expected);
    }
  });

  it("handles uppercase names and full paths, and leaves unknown types unmapped", () => {
    expect(languageIdForPath("src/Dockerfile")).toBe("dockerfile");
    expect(languageIdForPath("src/App.TSX")).toBe("typescript");
    expect(languageIdForPath("src\\main.go")).toBe("go");
    expect(languageIdForPath("README")).toBeUndefined();
    expect(languageIdForPath("a.unknown")).toBeUndefined();
  });
});
