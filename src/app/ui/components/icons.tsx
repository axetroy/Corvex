import type { SVGProps } from "react";

/** 选择器前置图标的公共属性：尺寸与描边色交给 CSS 控制。 */
function iconProps(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
}

/** 仓库图标：书脊 + 封面，用于仓库选择器。 */
export function RepositoryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H12a1 1 0 0 1 1 1v9" />
      <path d="M3 3.5V12A2 2 0 0 0 5 14h8" />
      <path d="M5.5 2v12" />
    </svg>
  );
}

/** 分支图标：git 分支图形，用于分支选择器。 */
export function BranchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="6" r="1.6" />
      <path d="M4.5 5.1v5.8" />
      <path d="M11.5 7.6c0 2.4-1.9 3.6-4 3.9" />
    </svg>
  );
}
