import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Card, Col, Progress, Row, Table, Typography } from "antd";
import { FiActivity, FiAlertCircle, FiBarChart2, FiClock, FiDatabase, FiMessageSquare, FiRefreshCw } from "react-icons/fi";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import { formatStorageBytes } from "../storage.js";
import type { ConversationTurnStatus, ModelCallMetric } from "../../../model.js";
import type { OverviewResponse } from "../types.js";
import { ErrorBanner, Loading, PageHeading, Panel } from "./common.js";
import "./AdminDashboard.css";

/** 指标卡：左侧彩色图标、右侧标签与大数字，底部可带一行辅助说明。 */
function MetricCard({
  icon,
  label,
  value,
  tone,
  note,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  tone: "primary" | "blue" | "warning" | "danger";
  note?: string;
}) {
  return (
    <Card
      className="admin-dashboard-metric"
      size="small"
      styles={{
        root: { border: "1px solid var(--border-soft)", borderRadius: 10, background: "var(--bg-panel)" },
        body: { padding: 18 },
      }}
    >
      <div className="admin-dashboard-metric-top">
        <span className={`admin-dashboard-metric-icon admin-dashboard-metric-${tone}`}>{icon}</span>
        <Typography.Text type="secondary" className="admin-dashboard-metric-label">{label}</Typography.Text>
      </div>
      <div className="admin-dashboard-metric-value">{value.toLocaleString("en-US")}</div>
      {note ? <div className="admin-dashboard-metric-note">{note}</div> : null}
    </Card>
  );
}

const statusTones: Record<ConversationTurnStatus, string> = {
  queued: "var(--warning)",
  running: "var(--blue)",
  completed: "var(--success)",
  failed: "var(--danger)",
  stale: "var(--purple)",
  cancelled: "var(--text-faint)",
};
const statusOrder: ConversationTurnStatus[] = [
  "running", "queued", "completed", "failed", "stale", "cancelled",
];

/** 管理后台首页：Ant Design Pro 风格的只读指标概览。 */
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
  const turnTotal = statusOrder.reduce((sum, status) => sum + counts[status], 0);
  const capacityPercent = data.workspaceSizeLimitBytes > 0
    ? Math.min(100, Math.round((data.workspaceTotalBytes / data.workspaceSizeLimitBytes) * 100))
    : 0;
  const queuedNote = data.oldestQueueAgeSeconds === null
    ? undefined
    : copy.adminDashboardOldestQueued.replace("{seconds}", String(data.oldestQueueAgeSeconds));

  const modelColumns = [
    { title: copy.adminDashboardColumnTaskType, dataIndex: "taskType", key: "taskType" },
    {
      title: copy.adminDashboardColumnOutcome,
      dataIndex: "outcome",
      key: "outcome",
      render: (value: ModelCallMetric["outcome"]) => (
        <Typography.Text type={value === "failure" ? "danger" : "success"}>{value}</Typography.Text>
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
        actions={(
          <Button icon={<FiRefreshCw />} onClick={() => setToken((value) => value + 1)}>
            {copy.refresh}
          </Button>
        )}
      />
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError("")} /> : null}
      {data.workspaceOverLimitCount > 0 ? (
        <Alert type="warning" showIcon message={copy.adminStorageWorkspaceOverLimit} />
      ) : null}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<FiMessageSquare />} label={copy.adminDashboardConversations} value={data.conversationCount} tone="primary" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<FiActivity />} label={copy.adminDashboardTurnsRunning} value={counts.running} tone="blue" />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<FiClock />} label={copy.adminDashboardTurnsQueued} value={counts.queued} tone="warning" note={queuedNote} />
        </Col>
        <Col xs={24} sm={12} xl={6}>
          <MetricCard icon={<FiAlertCircle />} label={copy.adminDashboardTurnsFailed} value={counts.failed} tone="danger" />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            className="admin-dashboard-card"
            size="small"
            title={copy.adminDashboardTurnStatus}
            extra={<FiBarChart2 className="admin-dashboard-card-icon" />}
            styles={{
              root: { border: "1px solid var(--border-soft)", borderRadius: 10, background: "var(--bg-panel)" },
              body: { padding: 16 },
            }}
          >
            {turnTotal === 0 ? (
              <div className="admin-dashboard-empty">{copy.adminDashboardNoTurns}</div>
            ) : (
              <div className="admin-dashboard-statuses">
                {statusOrder.map((status) => {
                  const count = counts[status];
                  const percent = Math.round((count / turnTotal) * 100);
                  return (
                    <div className="admin-dashboard-status" key={status}>
                      <span className="admin-dashboard-status-label">{copy.statuses[status]}</span>
                      <span className="admin-dashboard-status-track">
                        <span
                          className="admin-dashboard-status-fill"
                          style={{ width: `${percent}%`, background: statusTones[status] }}
                        />
                      </span>
                      <span className="admin-dashboard-status-value">{count}</span>
                      <span className="admin-dashboard-status-percent">{percent}%</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card
            className="admin-dashboard-card"
            size="small"
            title={copy.adminDashboardCapacity}
            extra={<FiDatabase className="admin-dashboard-card-icon" />}
            styles={{
              root: { border: "1px solid var(--border-soft)", borderRadius: 10, background: "var(--bg-panel)" },
              body: { padding: 16 },
            }}
          >
            <div className="admin-dashboard-capacity">
              <Progress
                type="dashboard"
                percent={capacityPercent}
                strokeColor="var(--primary)"
                trailColor="var(--bg-inset)"
                format={() => `${capacityPercent}%`}
              />
              <div className="admin-dashboard-capacity-info">
                <div className="admin-dashboard-capacity-value">{formatStorageBytes(data.workspaceTotalBytes)}</div>
                <div className="admin-dashboard-capacity-limit">
                  {copy.adminDashboardWorkspaceNote.replace("{limit}", formatStorageBytes(data.workspaceSizeLimitBytes))}
                </div>
                {data.workspaceOverLimitCount > 0 ? (
                  <div className="admin-dashboard-capacity-over">
                    {copy.adminDashboardOverLimit.replace("{count}", String(data.workspaceOverLimitCount))}
                  </div>
                ) : null}
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
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
        </Col>
        <Col xs={24} xl={12}>
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
        </Col>
      </Row>
    </div>
  );
}
