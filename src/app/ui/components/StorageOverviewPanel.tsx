import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Card, Col, Progress, Row, Table, Typography } from "antd";
import { fetchJson } from "../api.js";
import type { Copy, Locale } from "../i18n.js";
import { formatDate } from "../format.js";
import { formatStorageBytes, sortStorageRows, totalStorageBytes, type StorageRow } from "../storage.js";
import { ErrorBanner, Loading } from "./common.js";
import "./StorageOverviewPanel.css";

interface StorageResponse {
  mirrors: StorageRow[];
  workspaces: StorageRow[];
  truncated: boolean;
  /** 单会话 worktree 大小上限（字节）；超限只警告记录，不自动删除。 */
  workspaceSizeLimitBytes: number;
}

interface Props {
  copy: Copy;
  locale: Locale;
}

interface Slice {
  label: string;
  value: number;
  color: string;
}

/** 轻量环形图：不引图表库，用 SVG stroke-dasharray 画占比，颜色取自主题变量。 */
function DonutChart({ slices, centerValue, centerLabel }: { slices: Slice[]; centerValue: string; centerLabel: string }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="storage-chart-donut">
      <svg viewBox="0 0 140 140" role="img" aria-label={centerLabel}>
        <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--bg-inset)" strokeWidth="14" />
        {total > 0 ? slices.map((slice) => {
          const length = (slice.value / total) * circumference;
          const dash = <circle
            key={slice.label}
            cx="70" cy="70" r={radius}
            fill="none" stroke={slice.color} strokeWidth="14"
            strokeDasharray={`${length} ${circumference - length}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 70 70)"
          />;
          offset += length;
          return dash;
        }) : null}
        <text className="storage-chart-donut-value" x="70" y="68" textAnchor="middle">{centerValue}</text>
        <text className="storage-chart-donut-label" x="70" y="86" textAnchor="middle">{centerLabel}</text>
      </svg>
      <div className="storage-chart-legend">
        {slices.map((slice) => (
          <div key={slice.label}>
            <span className="storage-chart-dot" style={{ background: slice.color }} />
            <span>{slice.label}</span>
            <b>{formatStorageBytes(slice.value)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 空间占用排行：按大小降序的横条，最多显示前 5 项，长文件名用 title 保留全文。 */
function BarList({ rows, emptyText }: { rows: StorageRow[]; emptyText: string }) {
  if (rows.length === 0) return <div className="storage-bar-empty">{emptyText}</div>;
  const top = rows.slice(0, 5);
  const max = top[0]?.sizeBytes ?? 1;
  return (
    <div className="storage-bar-list">
      {top.map((row) => (
        <div className="storage-bar-row" key={row.relativePath}>
          <span className="storage-bar-name" title={row.name}>{row.name}</span>
          <span className="storage-bar-track">
            <span className="storage-bar-fill" style={{ width: `${Math.max(2, (row.sizeBytes / max) * 100)}%` }} />
          </span>
          <b className="storage-bar-value">{formatStorageBytes(row.sizeBytes)}</b>
        </div>
      ))}
    </div>
  );
}

function CardShell({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <Card
      className="storage-chart-card"
      size="small"
      title={title}
      extra={extra}
      styles={{
        root: { border: "1px solid var(--border-soft)", borderRadius: 10, background: "var(--bg-panel)" },
        body: { padding: 16 },
      }}
    >
      {children}
    </Card>
  );
}

/**
 * 设置页「存储」分组内的磁盘明细：可视化构成/占用排行 + 只读表格。
 * 顶部统计摘要已移到管理后台仪表盘，这里不再重复。
 */
export function StorageOverviewContent({ copy, locale }: Props) {
  const [data, setData] = useState<StorageResponse>();
  const [error, setError] = useState("");
  const [token, setToken] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    fetchJson<StorageResponse>("/api/ops/admin/storage", copy)
      .then((value) => { if (active) setData(value); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { active = false; };
  }, [copy, token]);

  const toolbar = (
    <div className="storage-overview-toolbar">
      <Button onClick={() => setToken((value) => value + 1)}>{copy.adminStorageRefresh}</Button>
    </div>
  );

  if (error && !data) {
    return <div className="storage-overview-panel">{toolbar}<ErrorBanner message={error} /></div>;
  }
  if (!data) {
    return <div className="storage-overview-panel">{toolbar}<Loading>{copy.loading}</Loading></div>;
  }

  const mirrorRows = sortStorageRows(data.mirrors);
  const workspaceRows = sortStorageRows(data.workspaces);
  const sizeLimit = data.workspaceSizeLimitBytes ?? Number.POSITIVE_INFINITY;
  const overLimitCount = data.workspaces.filter((row) => row.sizeBytes > sizeLimit).length;
  const mirrorBytes = totalStorageBytes(data.mirrors);
  const workspaceBytes = totalStorageBytes(data.workspaces);
  const usedPercent = sizeLimit > 0 ? Math.min(100, Math.round((workspaceBytes / sizeLimit) * 100)) : 0;

  const columns = [
    {
      title: copy.adminStorageColumnName,
      dataIndex: "name",
      key: "name",
      render: (_value: unknown, row: StorageRow) => (
        <Typography.Text code title={row.relativePath}>{row.name}</Typography.Text>
      ),
    },
    { title: copy.adminStorageColumnProject, dataIndex: "projectId", key: "projectId", width: 100 },
    {
      title: copy.adminStorageColumnSize,
      dataIndex: "sizeBytes",
      key: "sizeBytes",
      align: "right" as const,
      width: 120,
      render: (value: number) => <Typography.Text strong>{formatStorageBytes(value)}</Typography.Text>,
    },
    {
      title: copy.adminStorageColumnModified,
      dataIndex: "modifiedAt",
      key: "modifiedAt",
      width: 200,
      render: (value: string) => formatDate(value, copy, locale),
    },
  ];

  const workspaceColumns = [
    columns[0],
    columns[1],
    {
      ...columns[2],
      render: (value: number, row: StorageRow) => (
        <Typography.Text strong type={row.sizeBytes > sizeLimit ? "warning" : undefined}>
          {formatStorageBytes(value)}
        </Typography.Text>
      ),
    },
    columns[3],
    {
      title: copy.adminStorageColumnConversation,
      key: "conversationId",
      render: (_value: unknown, row: StorageRow) => row.conversationId
        ? <Typography.Text code>{row.conversationId}</Typography.Text>
        : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  return (
    <div className="storage-overview-panel">
      {toolbar}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError("")} /> : null}
      {data.truncated ? <Alert type="warning" showIcon message={copy.adminStorageTruncated} /> : null}
      {overLimitCount > 0 ? (
        <Alert type="warning" showIcon message={copy.adminStorageWorkspaceOverLimit} />
      ) : null}

      <Row gutter={[16, 16]} className="storage-chart-grid">
        <Col xs={24} lg={12}>
          <CardShell title={copy.adminStorageComposition}>
            <DonutChart
              slices={[
                { label: copy.adminStorageMirrorsTitle, value: mirrorBytes, color: "var(--primary)" },
                { label: copy.adminStorageWorkspacesTitle, value: workspaceBytes, color: "var(--orange)" },
              ]}
              centerValue={formatStorageBytes(mirrorBytes + workspaceBytes)}
              centerLabel={copy.adminStorageTotal}
            />
          </CardShell>
        </Col>
        <Col xs={24} lg={12}>
          <CardShell title={copy.adminStorageUsage}>
            <div className="storage-usage">
              <Progress
                type="dashboard"
                percent={usedPercent}
                strokeColor="var(--primary)"
                trailColor="var(--bg-inset)"
                format={() => `${usedPercent}%`}
              />
              <div className="storage-usage-info">
                <span className="storage-usage-label">{copy.adminStorageWorkspaceSize}</span>
                <strong className="storage-usage-value">{formatStorageBytes(workspaceBytes)}</strong>
                <span className="storage-usage-limit">
                  {copy.adminDashboardWorkspaceNote.replace("{limit}", formatStorageBytes(sizeLimit))}
                </span>
              </div>
            </div>
          </CardShell>
        </Col>
      </Row>

      <Row gutter={[16, 16]} className="storage-chart-grid">
        <Col xs={24} lg={12}>
          <CardShell title={copy.adminStorageTopMirrors}>
            <BarList rows={mirrorRows} emptyText={copy.adminStorageEmpty} />
          </CardShell>
        </Col>
        <Col xs={24} lg={12}>
          <CardShell title={copy.adminStorageTopWorkspaces}>
            <BarList rows={workspaceRows} emptyText={copy.adminStorageEmpty} />
          </CardShell>
        </Col>
      </Row>

      <div className="storage-detail-tables">
        <div className="storage-detail-table">
          <Typography.Title level={5}>{copy.adminStorageMirrorsTitle}</Typography.Title>
          <Table
            className="storage-overview-table"
            rowKey="relativePath"
            size="small"
            pagination={false}
            dataSource={mirrorRows}
            columns={columns}
            locale={{ emptyText: copy.adminStorageEmpty }}
          />
        </div>
        <div className="storage-detail-table">
          <Typography.Title level={5}>{copy.adminStorageWorkspacesTitle}</Typography.Title>
          <Table
            className="storage-overview-table"
            rowKey="relativePath"
            size="small"
            pagination={false}
            dataSource={workspaceRows}
            columns={workspaceColumns}
            locale={{ emptyText: copy.adminStorageEmpty }}
          />
        </div>
      </div>
    </div>
  );
}
