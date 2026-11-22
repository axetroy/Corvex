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

/** 通知图标：铃铛，用于侧边栏桌面通知开关。 */
export function BellIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 10.5V7a4 4 0 0 1 8 0v3.5l1.2 1.8H2.8L4 10.5Z" />
      <path d="M6.5 13.2a1.6 1.6 0 0 0 3 0" />
    </svg>
  );
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
/** 退出图标：门与箭头，用于侧栏底部登出按钮。 */
export function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M9.5 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h5.5" />
      <path d="M8 8h5.5" />
      <path d="m11.5 5.5 3 2.5-3 2.5" />
    </svg>
  );
}

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

/** 文件面板图标：两页叠放的文档，作为侧栏文件浏览入口。 */
export function FilesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M5.5 2.5h3.6l2.4 2.5v7.5H5.5z" />
      <path d="M9.1 2.5v2.5h2.4" />
      <path d="M7.5 5.5h4.8l2.2 2.3v5.7H7.5z" />
    </svg>
  );
}

/** 目录图标：文件夹轮廓。 */
export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.2 4.6h4l1.3 1.6h6.3v7.2H2.2z" />
    </svg>
  );
}

/** 打开的目录图标，用于树中展开的节点。 */
export function FolderOpenIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.2 4.6h4l1.3 1.6h6.3v7.2H2.2z" />
      <path d="M4.6 8.4h9.2l-1.4 4.9H3.2z" />
    </svg>
  );
}

/** 文件图标：单页文档。 */
export function FileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

/** 中止图标：方块，用于停止正在执行的对话轮次。 */
export function StopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 插话图标：向右的箭头加一条短横线，表示把补充信息送进正在执行的轮次。 */
export function InterjectIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M2.5 8h8.5" />
      <path d="M8 5.5 10.8 8 8 10.5" />
      <path d="M13 3.5v9" />
    </svg>
  );
}

/** 滚动到底部图标：向下的箭头，用于聊天记录的「回到最新」按钮。 */
export function ScrollBottomIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M8 3.2v9.3" />
      <path d="m4.6 9.1 3.4 3.4 3.4-3.4" />
      <path d="M3.2 2.6h9.6" />
    </svg>
  );
}

/** 复制图标：两页叠放的纸张，用于代码块复制按钮。 */
export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.4" />
      <path d="M10.5 3.5H4.2A1.2 1.2 0 0 0 3 4.7v6.3" />
    </svg>
  );
}

/** 完成图标：对勾，用于复制成功反馈。 */
export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="m3 8.4 3.1 3.1L13 4.6" />
    </svg>
  );
}

/** 语言图标：翻译字形，用于侧栏与首页的语言切换入口。 */
export function LanguageIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps({ viewBox: "0 0 24 24", fill: "currentColor", stroke: "none", ...props })}>
      <path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z" />
    </svg>
  );
}

/** 浅色主题图标：太阳。 */
export function ThemeLightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" />
    </svg>
  );
}

/** 深色主题图标：月亮。 */
export function ThemeDarkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M13.2 9.8A5.7 5.7 0 0 1 6.2 2.8a5.7 5.7 0 1 0 7 7Z" />
    </svg>
  );
}

/** 跟随系统主题图标：半明半暗的圆。 */
export function ThemeSystemIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 理解仓库分组图标：打开的书本。 */
export function BookIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M8 3.5C6.5 2.6 4.6 2.2 2.5 2.4v9.2c2.1-.2 4 .2 5.5 1.1" />
      <path d="M8 3.5c1.5-.9 3.4-1.3 5.5-1.1v9.2c-2.1-.2-4 .2-5.5 1.1" />
      <path d="M8 3.5v9.2" />
    </svg>
  );
}

/** 定位代码分组图标：放大镜。 */
export function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.1 3.1" />
    </svg>
  );
}

/** 质量改进分组图标：扳手。 */
export function WrenchIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12.8 3.1a3.6 3.6 0 0 0-4.6 4.6L3.4 12.5a1.5 1.5 0 0 0 2.1 2.1l4.8-4.8a3.6 3.6 0 0 0 4.6-4.6l-2.2 2.2-2.1-.5-.5-2.1 2.7-1.7Z" />
    </svg>
  );
}

/** 快速上手分组图标：纸飞机。 */
export function RocketIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M13.4 2.6 7.2 5.1l3.7 3.7 2.5-6.2Z" />
      <path d="m10.9 8.8-4.4 4.4-1.7-1.7 4.4-4.4" />
      <path d="M4.8 11.5 2.6 13.4l.4 2 2-.4 1.9-2.2" />
    </svg>
  );
}
