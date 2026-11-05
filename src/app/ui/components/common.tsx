import { Children, isValidElement } from "react";
import type { ReactNode } from "react";
import { Alert, Card, Empty as AntEmpty, Spin, Statistic, Table, Tag, Typography } from "antd";
import type { TableColumnsType } from "antd";

interface TableRow {
  key: string | number;
  cells: ReactNode[];
}

/** 运维台的通用面板容器，标题与内容使用既有样式类。 */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <Card className="panel" title={title} size="small">{children}</Card>;
}

/** 页面标题区，可附带说明文字与右侧操作。 */
export function PageHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="page-heading">
      <div>
        <Typography.Title level={1}>{title}</Typography.Title>
        {description ? <Typography.Paragraph type="secondary">{description}</Typography.Paragraph> : null}
      </div>
      {actions}
    </div>
  );
}

/** 概览页的统计卡片。 */
export function StatCard({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <Card className="card" size="small">
      <Statistic title={label} value={value as string | number} />
      {note ? <Typography.Text type="secondary" className="card-note">{note}</Typography.Text> : null}
    </Card>
  );
}

/** 带横向滚动的数据表格，表头由调用方提供。 */
export function DataTable({ headers, children }: { headers: readonly string[]; children: ReactNode }) {
  const rows = Children.toArray(children).flatMap((child, index): TableRow[] => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    return [{ key: child.key ?? index, cells: Children.toArray(child.props.children) }];
  });
  const columns: TableColumnsType<TableRow> = headers.map((header, index) => ({
    key: String(index),
    title: header,
    render: (_value, row) => row.cells[index] ?? null,
  }));

  return <Table<TableRow> className="data-table" columns={columns} dataSource={rows} pagination={false} rowKey="key" scroll={{ x: "max-content" }} size="small" />;
}

/** 任务状态徽标，颜色由状态名对应的样式类决定。 */
export function StatusBadge({ status, label }: { status: string; label: string }) {
  const color = status === "completed" ? "success"
    : status === "failed" ? "error"
      : status === "queued" || status === "stale" || status === "cancelled" ? "default" : "processing";
  return <Tag color={color}>{label}</Tag>;
}

/** 列表为空时的占位内容。 */
export function Empty({ children }: { children: ReactNode }) {
  return <AntEmpty image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description={children} />;
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
  return <div className="loading-state"><Spin /><Typography.Text type="secondary">{children}</Typography.Text></div>;
}

/** 请求失败时的错误提示；用 alert 角色播报，页面其余内容保持安静。 */
export function ErrorBanner({ message }: { message: string }) {
  return <Alert className="error" type="error" showIcon title={message} />;
}
