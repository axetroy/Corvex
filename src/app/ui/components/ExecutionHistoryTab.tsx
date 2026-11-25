import { useEffect, useState } from "react";
import { Tag } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate } from "../format.js";
import type { Copy, Locale } from "../i18n.js";
import { DataTable, Empty, ErrorBanner, Loading } from "./common.js";

/** 单条命令执行记录（对应后端 listExecutionHistory）。 */
interface ExecutionItem {
  turnId: string;
  command: string;
  backend: "local" | "sandbox";
  exitCode: number | null;
  createdAt: string;
}

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
}

/** 会话「执行」标签：列出本会话跑过的命令、后端与退出码，来自审计事件。 */
export function ExecutionHistoryTab({ conversationId, copy, locale, refreshToken }: Props) {
  const [items, setItems] = useState<ExecutionItem[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!conversationId) {
      setItems(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setItems(undefined);
    setError(undefined);
    fetchJson<{ items: ExecutionItem[] }>(`/api/ops/conversations/${encodeURIComponent(conversationId)}/executions`, copy)
      .then((value) => { if (active) setItems(value.items ?? []); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [conversationId, copy, refreshToken]);

  if (error && !items) return <ErrorBanner message={error} />;
  if (!items) return <Loading>{copy.loading}</Loading>;
  if (items.length === 0) return <Empty>{copy.executionHistoryEmpty}</Empty>;

  return (
    <div className="conversation-execution-history">
      <DataTable headers={[
        copy.executionHistoryTime,
        copy.executionHistoryCommand,
        copy.executionHistoryBackend,
        copy.executionHistoryExit,
      ]}>
        {items.map((item, index) => (
          <tr key={`${item.turnId}-${index}`}>
            <td>{formatDate(item.createdAt, copy, locale)}</td>
            <td><code className="conversation-execution-command" title={item.command}>{item.command}</code></td>
            <td><Tag color={item.backend === "sandbox" ? "blue" : "orange"}>{item.backend}</Tag></td>
            <td>
              {item.exitCode === null ? (
                <Tag color="error">{copy.executionHistoryAborted}</Tag>
              ) : (
                <span className={item.exitCode === 0 ? "conversation-execution-ok" : "conversation-execution-fail"}>
                  {item.exitCode}
                </span>
              )}
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
