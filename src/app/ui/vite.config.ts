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
    // antd 作为单一 vendor chunk 必然超过默认 500 kB 阈值，其余业务代码已按路由拆分。
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // 把体积稳定的第三方库拆成独立 chunk，页面按需加载时只增量下载业务代码。
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/\/(?:react|react-dom|scheduler)\//.test(id)) return "react";
          if (/\/(?:antd|@ant-design|rc-[^/]+|@rc-component)\//.test(id)) return "antd";
          return undefined;
        },
      },
    },
  },
  server: {
    proxy: {
      // `vite` 开发服务器只用于界面调试；接口仍由本地 Server 提供。
      "/api": process.env.CORVEX_OPS_API ?? "http://127.0.0.1:8080",
    },
  },
});
