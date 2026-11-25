import type { ReactNode } from "react";
import { PageHeading } from "./common.js";
import "./AdminPage.css";

interface Props {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * 管理后台所有页面的统一外壳：标题、说明、右侧操作、内容宽度与纵向间距
 * 只在这里定义一次，各页面不要再写自己的页头或外层宽度。
 */
export function AdminPage({ title, description, actions, children }: Props) {
  return (
    <div className="admin-page">
      <PageHeading title={title} description={description} actions={actions} />
      {children}
    </div>
  );
}
