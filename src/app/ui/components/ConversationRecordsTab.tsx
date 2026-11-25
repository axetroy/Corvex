import { useEffect, useMemo, useState } from "react";
import { fetchJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy, Locale } from "../lib/i18n.js";
import type { ConversationTurns } from "../lib/types.js";
import { ErrorBanner, Loading } from "./common.js";
import { ExecutionSteps } from "./ExecutionSteps.js";

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
}

/**
 * 对话「调用记录」标签：把执行步骤（读取仓库、准备快照等）从轨迹中独立出来，
 * 汇总整段对话的步骤并标注所属轮次；输入输出仍按需展开查看。
 */
export function ConversationRecordsTab({ conversationId, copy, locale, refreshToken, onUpdated }: Props) {
  const [data, setData] = useState<ConversationTurns>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!conversationId) {
      setData(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setData(undefined);
    setError(undefined);
    fetchJson<ConversationTurns>(`/api/ops/conversations/${encodeURIComponent(conversationId)}/turns`, copy)
      .then((value) => {
        if (!active) return;
        setData(value);
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [conversationId, copy, refreshToken, onUpdated]);

  // 轮次按创建时间升序返回，用序号作为表格里的轮次标签。
  const turnLabels = useMemo(
    () => new Map(data?.turns.map((turn, index) => [turn.turnId, `#${index + 1}`]) ?? []),
    [data],
  );

  if (error && !data) return <ErrorBanner message={error} />;
  if (!data) return <Loading>{copy.loading}</Loading>;

  return (
    <div className="conversation-records">
      {error ? <ErrorBanner message={error} /> : null}
      <ExecutionSteps
        events={data.events}
        copy={copy}
        locale={locale}
        turnLabel={(event) => (event.turnId ? turnLabels.get(event.turnId) ?? null : null)}
      />
    </div>
  );
}
