import { useEffect, useState } from "react";
import { Alert, Button, Table, Typography } from "antd";
import { fetchJson } from "../api.js";
import type { Copy, Locale } from "../i18n.js";
import { formatDate } from "../format.js";
import { formatStorageBytes, sortStorageRows, totalStorageBytes, type StorageRow } from "../storage.js";
import { ErrorBanner, Loading, PageHeading, Panel, StatCard } from "./common.js";
import { StorageCleanupPanel } from "./StorageCleanupPanel.js";
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

/** 运维台「存储管理」：只读展示 Git 镜像与会话工作树的大小/修改时间，并可运行清理。 */
export function StorageOverviewPanel({ copy, locale }: Props) {
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

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Loading>{copy.loading}</Loading>;

  const mirrorRows = sortStorageRows(data.mirrors);
  const workspaceRows = sortStorageRows(data.workspaces);
  const sizeLimit = data.workspaceSizeLimitBytes ?? Number.POSITIVE_INFINITY;
  const overLimitCount = data.workspaces.filter((row) => row.sizeBytes > sizeLimit).length;

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
      render: (value: number) => (
        <Typography.Text strong>{formatStorageBytes(value)}</Typography.Text>
      ),
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
      title: copy.adminStorageColumnSize,
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
      <PageHeading
        title={copy.adminStorageTitle}
        description={copy.adminStorageHint}
        actions={<Button onClick={() => setToken((value) => value + 1)}>{copy.adminStorageRefresh}</Button>}
      />
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError("")} /> : null}
      {data.truncated ? <Alert type="warning" showIcon message={copy.adminStorageTruncated} /> : null}
      {overLimitCount > 0 ? (
        <Alert type="warning" showIcon message={copy.adminStorageWorkspaceOverLimit} />
      ) : null}

      <div className="storage-overview-stats">
        <StatCard label={copy.adminStorageMirrorCount} value={data.mirrors.length} />
        <StatCard label={copy.adminStorageMirrorSize} value={formatStorageBytes(totalStorageBytes(data.mirrors))} />
        <StatCard label={copy.adminStorageWorkspaceCount} value={data.workspaces.length} />
        <StatCard label={copy.adminStorageWorkspaceSize} value={formatStorageBytes(totalStorageBytes(data.workspaces))} />
      </div>

      <Panel title={copy.adminStorageMirrorsTitle}>
        <Table
          className="storage-overview-table"
          rowKey="relativePath"
          size="small"
          pagination={false}
          dataSource={mirrorRows}
          columns={columns}
          locale={{ emptyText: copy.adminStorageEmpty }}
        />
      </Panel>

      <Panel title={copy.adminStorageWorkspacesTitle}>
        <Table
          className="storage-overview-table"
          rowKey="relativePath"
          size="small"
          pagination={false}
          dataSource={workspaceRows}
          columns={workspaceColumns}
          locale={{ emptyText: copy.adminStorageEmpty }}
        />
      </Panel>

      <Panel title={copy.settingsCleanupTitle}>
        <StorageCleanupPanel copy={copy} locale={locale} retentionDays={30} />
      </Panel>
    </div>
  );
}
