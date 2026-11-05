import type { ReactNode } from "react";

/** 运维台的通用面板容器，标题与内容使用既有样式类。 */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-title">{title}</div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** 页面标题区，可附带说明文字与右侧操作。 */
export function PageHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

/** 概览页的统计卡片。 */
export function StatCard({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <section className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {note ? <div className="card-note">{note}</div> : null}
    </section>
  );
}

/** 带横向滚动的数据表格，表头由调用方提供。 */
export function DataTable({ headers, children }: { headers: readonly string[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((header, index) => <th key={index}>{header}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 任务状态徽标，颜色由状态名对应的样式类决定。 */
export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <span className={`badge ${status}`}>{label}</span>;
}

/** 列表为空时的占位内容。 */
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** 长文本折叠展示：摘要显示首行，展开后显示完整内容。 */
export function ExpandableText({ label, value, className, defaultOpen = false }: {
  label: string;
  value: string;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={className} open={defaultOpen || undefined}>
      <summary>
        <span>{label}</span>
        <span className="details-preview">{value.split("\n", 1)[0]}</span>
      </summary>
      <pre className="details-content">{value}</pre>
    </details>
  );
}

/** 定义列表中的一项，值为普通文本。 */
export function DetailItem({ label, value, className }: { label: string; value?: ReactNode; className?: string }) {
  return (
    <div className="detail-item">
      <dt>{label}</dt>
      <dd className={className}>{value ?? null}</dd>
    </div>
  );
}

/** 定义列表中的一项，值为自定义节点。 */
export function DetailNode({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** 轨迹负载字段：有值时折叠展示，无值时给出占位文案。 */
export function TraceField({ label, value, emptyLabel, defaultOpen = false }: {
  label: string;
  value: string | null;
  emptyLabel: string;
  defaultOpen?: boolean;
}) {
  if (value) return <ExpandableText label={label} value={value} className="trace-payload" defaultOpen={defaultOpen} />;
  return (
    <div className="trace-payload trace-payload-empty">
      <span>{label}</span>
      <span>{emptyLabel}</span>
    </div>
  );
}

/** 加载中的占位文案。 */
export function Loading({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

/** 请求失败时的错误提示；用 alert 角色播报，页面其余内容保持安静。 */
export function ErrorBanner({ message }: { message: string }) {
  return <div className="error" role="alert">{message}</div>;
}
