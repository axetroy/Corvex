import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    files: ["src/app/ui/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        fetch: "readonly",
        location: "readonly",
        URLSearchParams: "readonly",
        window: "readonly",
      },
    },
  },
  {
    ignores: ["dist/", "node_modules/", "docs/.vitepress/cache/", "docs/.vitepress/dist/"],
  },
);
