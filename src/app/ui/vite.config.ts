import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 运维台构建配置：源码在本目录，产物写入 dist/app/ui，
 * 由 Server 以 `/ops/` 前缀提供；`base` 必须与静态路由一致。
 */
export default defineConfig({
  root: "src/app/ui",
  base: "/ops/",
  plugins: [react()],
  build: {
    outDir: "../../../dist/app/ui",
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    sourcemap: false,
  },
  server: {
    proxy: {
      // `vite` 开发服务器只用于界面调试；接口仍由本地 Server 提供。
      "/api": process.env.CORVEX_OPS_API ?? "http://127.0.0.1:8080",
    },
  },
});
