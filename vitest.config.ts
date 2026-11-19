import { defineConfig } from "vitest/config";

/**
 * 只扫描仓库内的测试目录。
 *
 * `data/` 是本地运行时数据（会话库、镜像与对话工作树），其中的第三方仓库可能
 * 自带 `*.test.js`；默认 glob 会把这些文件当成测试执行，让测试结果依赖开发机
 * 状态并产生虚假失败。测试本身必须保持封闭，因此显式限定范围。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,js}"],
  },
});
