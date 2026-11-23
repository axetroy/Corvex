import { useEffect, useState } from "react";
import { Table, Typography } from "antd";
import { fetchJson } from "../api.js";
import type { Copy } from "../i18n.js";
import type { ContextMetric, OverviewResponse } from "../types.js";
import { Loading, PageHeading } from "./common.js";

interface Props {
  copy: Copy;
  refreshToken: number;
}

/** 上下文治理指标：压缩次数、微压缩节省与真实 token 计数可用性。 */
export function ContextMetricsPanel({ copy, refreshToken }: Props) {
  const [metrics, setMetrics] = useState<ContextMetric[]>();

  useEffect(() => {
    let active = true;
    fetchJson<OverviewResponse>("/api/ops/overview", copy)
      .then((overview) => { if (active) setMetrics(overview.contextMetrics); })
      .catch(() => { if (active) setMetrics([]); });
    return () => { active = false; };
  }, [copy, refreshToken]);

  if (!metrics) return <Loading>{copy.loading}</Loading>;
  const byKey = new Map(metrics.map((metric) => [metric.key, metric.value]));
  const rows = Object.entries(copy.contextMetricLabels).map(([key, label]) => ({
    key,
    label,
    value: byKey.get(key as ContextMetric["key"]) ?? 0,
  }));

  return (
    <>
      <PageHeading title={copy.adminContextMetricsTitle} description={copy.adminContextMetricsHint} />
      <Table
        className="context-metrics-table"
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={rows}
        columns={[
          { title: copy.contextMetricColumn, dataIndex: "label", key: "label" },
          {
            title: copy.contextMetricValueColumn,
            dataIndex: "value",
            key: "value",
            align: "right",
            render: (value: number) => <Typography.Text strong>{value.toLocaleString()}</Typography.Text>,
          },
        ]}
      />
    </>
  );
}
