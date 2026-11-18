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

/** 对话图标：对话气泡，用于侧边栏导航。 */
export function ConversationsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M13.5 8.2c0 2.9-2.5 5.2-5.5 5.2-.7 0-1.4-.1-2-.3L3 14l1-2.6A5 5 0 0 1 2.5 8.2C2.5 5.3 5 3 8 3s5.5 2.3 5.5 5.2Z" />
    </svg>
  );
}

/** 事件图标：带状态点的列表，用于侧边栏导航。 */
export function EventsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
      <circle cx="2.8" cy="4" r="0.9" />
      <circle cx="2.8" cy="8" r="0.9" />
      <circle cx="2.8" cy="12" r="0.9" />
    </svg>
  );
}

/** 概览图标：仪表盘网格，用于侧边栏导航。 */
export function OverviewIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.1" />
      <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.1" />
      <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.1" />
      <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1.1" />
    </svg>
  );
}

/** 设置图标：齿轮，用于侧边栏导航。 */
export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.7M8 12.5v1.7M2.6 4.9l1.5.9M11.9 10.2l1.5.9M2.6 11.1l1.5-.9M11.9 5.8l1.5-.9" />
    </svg>
  );
}

/** 收起侧边栏图标：竖线加左向箭头。 */
export function SidebarCollapseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.8" />
      <path d="M6 2.8v10.4" />
      <path d="M11.2 6.3 9.5 8l1.7 1.7" />
    </svg>
  );
}

/** 展开侧边栏图标：竖线加右向箭头。 */
export function SidebarExpandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.8" />
      <path d="M6 2.8v10.4" />
      <path d="M9.5 6.3 11.2 8l-1.7 1.7" />
    </svg>
  );
}

/** 语言图标：地球，用于侧边栏收起时的语言切换入口。 */
export function LanguageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.6 8h10.8" />
      <path d="M8 2.4c1.7 1.7 2.6 3.6 2.6 5.6S9.7 12 8 13.6C6.3 11.9 5.4 10 5.4 8S6.3 4.1 8 2.4Z" />
    </svg>
  );
}
