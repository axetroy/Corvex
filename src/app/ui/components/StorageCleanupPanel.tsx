import { useEffect, useState } from "react";
import { Alert, Button, InputNumber, Pagination, Space, Typography } from "antd";
import { fetchJson, sendJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { StorageCleanupRecord } from "../types.js";
import { formatDate } from "../format.js";
import type { Locale } from "../i18n.js";
import { Panel } from "./common.js";

interface CleanupResult {
  workspaces: number;
  mirrors: number;
  applied: boolean;
}

/**
 * Git 存储清理面板：可预览或执行清理，并列出 CLI、Server 保留任务与
 * 控制台触发的历史记录。删除前由服务端保护运行中的轮次。
 */
export function StorageCleanupPanel({
  copy,
  locale,
  retentionDays,
}: {
  copy: Copy;
  locale: Locale;
  retentionDays: number;
}) {
  const [days, setDays] = useState(retentionDays);
  const [records, setRecords] = useState<StorageCleanupRecord[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const normalized = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30;
    setDays((current) => (current > 0 ? current : normalized));
  }, [retentionDays]);

  async function refresh(targetPage = page) {
    try {
      const response = await fetchJson<{ items: StorageCleanupRecord[]; total: number }>(
        `/api/ops/storage/cleanups?limit=10&offset=${(targetPage - 1) * 10}`,
        copy,
      );
      setRecords(response.items);
      setTotal(response.total);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    void refresh();
  }, [copy]);

  async function run(apply: boolean) {
    setBusy(true);
    setError("");
    setResult("");
    try {
      const plan = await sendJson<CleanupResult>(
        "/api/ops/storage/cleanup",
        { olderThanDays: days, apply },
        copy,
        "POST",
      );
      setResult(copy.settingsCleanupResult
        .replace("{workspaces}", String(plan.workspaces))
        .replace("{mirrors}", String(plan.mirrors))
        .replace("{mode}", plan.applied ? "" : copy.settingsCleanupDryRun));
      setPage(1);
      await refresh(1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={copy.settingsCleanupTitle}>
      <Typography.Paragraph type="secondary" className="settings-group-hint">
        {copy.settingsCleanupDescription}
      </Typography.Paragraph>
      <Space wrap className="settings-cleanup-controls">
        <span>{copy.settingsCleanupDays}</span>
        <InputNumber min={1} max={36_500} value={days} onChange={(value) => setDays(Number(value) || 1)} />
        <Button loading={busy} onClick={() => void run(false)}>{copy.settingsCleanupPreview}</Button>
        <Button danger loading={busy} onClick={() => void run(true)}>{copy.settingsCleanupRun}</Button>
      </Space>
      {result ? <Alert className="settings-alert" type="info" showIcon message={result} /> : null}
      {error ? <Alert className="settings-alert" type="error" showIcon message={error} /> : null}
      {records.length === 0 ? (
        <Typography.Paragraph type="secondary">{copy.settingsCleanupEmpty}</Typography.Paragraph>
      ) : (
        <ul className="settings-cleanup-list">
          {records.map((record) => (
            <li key={record.id}>
              <span className="settings-cleanup-time">{formatDate(record.startedAt, copy, locale)}</span>
              <span className="settings-cleanup-source">{record.source}</span>
              <span>
                {record.error
                  ? copy.settingsCleanupError.replace("{error}", record.error.slice(0, 200))
                  : copy.settingsCleanupRemoved
                      .replace("{workspaces}", String(record.removedWorkspaces))
                      .replace("{mirrors}", String(record.removedMirrors))}
              </span>
              <span className="settings-cleanup-mode">
                {record.applied ? copy.settingsCleanupApplied : copy.settingsCleanupDryRun}
              </span>
            </li>
          ))}
        </ul>
      )}
      {total > 10 ? (
        <Pagination
          className="settings-cleanup-pagination"
          current={page}
          pageSize={10}
          total={total}
          showSizeChanger={false}
          onChange={(next) => {
            setPage(next);
            void refresh(next);
          }}
        />
      ) : null}
    </Panel>
  );
}
