import { useEffect, useState } from "react";
import { Alert, Button, Table, Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import { formatStorageBytes } from "../storage.js";
import type { ModelCallMetric, OverviewResponse } from "../types.js";
import { ErrorBanner, Loading, PageHeading, Panel, StatCard } from "./common.js";
import "./AdminDashboard.css";

/** 管理后台首页：会话轮次健康度、模型调用与 worktree 容量的只读快照。 */
export function AdminDashboard({ copy }: { copy: Copy }) {
  const [data, setData] = useState<OverviewResponse>();
  const [error, setError] = useState("");
  const [token, setToken] = useState(0);

  useEffect(() => {
    let active = true;
    setError("");
    fetchJson<OverviewResponse>("/api/ops/overview", copy)
      .then((value) => { if (active) setData(value); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [copy, token]);

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Loading>{copy.loading}</Loading>;

  const { counts } = data;
  const queuedNote = data.oldestQueueAgeSeconds === null
    ? undefined
    : copy.adminDashboardOldestQueued.replace("{seconds}", String(data.oldestQueueAgeSeconds));
  const workspaceNote = copy.adminDashboardWorkspaceNote
    .replace("{limit}", formatStorageBytes(data.workspaceSizeLimitBytes));

  const modelColumns = [
    { title: copy.adminDashboardColumnTaskType, dataIndex: "taskType", key: "taskType" },
    {
      title: copy.adminDashboardColumnOutcome,
      dataIndex: "outcome",
      key: "outcome",
      render: (value: ModelCallMetric["outcome"]) => (
        <Typography.Text type={value === "failure" ? "danger" : undefined}>{value}</Typography.Text>
      ),
    },
    { title: copy.adminDashboardColumnCalls, dataIndex: "calls", key: "calls", align: "right" as const },
    {
      title: copy.adminDashboardColumnDuration,
      dataIndex: "durationMs",
      key: "durationMs",
      align: "right" as const,
      render: (value: number) => `${Math.round(value / 1000)}s`,
    },
    { title: copy.adminDashboardColumnInputTokens, dataIndex: "inputTokens", key: "inputTokens", align: "right" as const },
    { title: copy.adminDashboardColumnOutputTokens, dataIndex: "outputTokens", key: "outputTokens", align: "right" as const },
  ];

  const contextRows = Object.entries(copy.contextMetricLabels).map(([key, label]) => ({
    key,
    label,
    value: data.contextMetrics.find((metric) => metric.key === key)?.value ?? 0,
  }));
  const contextColumns = [
    { title: copy.contextMetricColumn, dataIndex: "label", key: "label" },
    { title: copy.contextMetricValueColumn, dataIndex: "value", key: "value", align: "right" as const },
  ];

  return (
    <div className="admin-dashboard">
      <PageHeading
        title={copy.adminDashboardTitle}
        description={copy.adminDashboardHint}
        actions={<Button onClick={() => setToken((value) => value + 1)}>{copy.refresh}</Button>}
      />
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError("")} /> : null}
      {data.workspaceOverLimitCount > 0 ? (
        <Alert type="warning" showIcon message={copy.adminStorageWorkspaceOverLimit} />
      ) : null}

      <div className="admin-dashboard-stats">
        <StatCard label={copy.adminDashboardConversations} value={data.conversationCount} />
        <StatCard label={copy.adminDashboardTurnsQueued} value={counts.queued} note={queuedNote} />
        <StatCard label={copy.adminDashboardTurnsRunning} value={counts.running} />
        <StatCard label={copy.adminDashboardTurnsCompleted} value={counts.completed} />
        <StatCard label={copy.adminDashboardTurnsFailed} value={counts.failed} />
        <StatCard label={copy.adminDashboardWorkspaceSize} value={formatStorageBytes(data.workspaceTotalBytes)} note={workspaceNote} />
      </div>

      <Panel title={copy.adminDashboardModelCalls}>
        <Table
          className="admin-dashboard-table"
          rowKey={(row) => `${row.taskType}-${row.outcome}`}
          size="small"
          pagination={false}
          dataSource={data.modelCalls}
          columns={modelColumns}
          locale={{ emptyText: copy.adminDashboardNoModelCalls }}
        />
      </Panel>

      <Panel title={copy.adminDashboardContextMetrics}>
        <Table
          className="admin-dashboard-table"
          rowKey="key"
          size="small"
          pagination={false}
          dataSource={contextRows}
          columns={contextColumns}
          locale={{ emptyText: copy.adminDashboardNoContextMetrics }}
        />
      </Panel>
    </div>
  );
}
