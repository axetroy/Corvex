import nesting from "postcss-nesting";

/**
 * 控制台样式统一走 PostCSS：允许用标准 CSS 嵌套（`&`）按组件组织规则，
 * 编译后仍是普通的扁平选择器，保持原有优先级与 Ant Design 覆盖能力。
 */
export default {
  plugins: [nesting()],
};
