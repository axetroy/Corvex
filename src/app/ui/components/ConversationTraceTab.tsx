import { useEffect, useMemo, useState } from "react";
import { Select, Space, Tag, Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import type { ConversationMessage, ConversationTurn } from "../types.js";
import { Empty, ErrorBanner, Loading, Panel, StatusBadge } from "./common.js";
import { ExecutionSteps } from "./ExecutionSteps.js";
import { TraceExperience } from "./TraceExperience.js";

interface Props {
  conversationId: string;
  /** 该对话的消息列表，用于列出可查看轨迹的轮次。 */
  messages: readonly ConversationMessage[];
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onUpdated: (value: string) => void;
}

/** 可查看轨迹的轮次：助手回复且已关联事件（含尚未产出轨迹的进行中轮次）。 */
interface TurnOption {
  messageId: string;
  turnId: string;
  label: string;
  status: ConversationMessage["status"];
  createdAt: string;
}

/**
 * 对话「轨迹」标签：从该对话的轮次里选择一轮，展示该轮的模型与工具轨迹，
 * 以及事件生命周期与执行步骤。数据按需从单轮记录端点拉取。
 */
export function ConversationTraceTab({ conversationId, messages, copy, locale, refreshToken, onUpdated }: Props) {
  const turns = useMemo<TurnOption[]>(
    () => messages
      .filter((message) => message.role === "assistant" && Boolean(message.turnId))
      .map((message) => ({
        messageId: message.id,
        turnId: message.turnId ?? "",
        label: formatDate(message.createdAt, copy, locale),
        status: message.status,
        createdAt: message.createdAt,
      }))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.messageId < right.messageId ? 1 : -1))
      .map((turn, index, all) => ({ ...turn, label: `#${all.length - index} · ${turn.label}` })),
    [messages, copy, locale],
  );
  const [selectedTurnId, setSelectedTurnId] = useState("");
  const [turn, setTurn] = useState<ConversationTurn>();
  const [error, setError] = useState<string>();

  // 选中轮次在刷新后可能消失（例如被取消），回退到最新一轮。
  useEffect(() => {
    setSelectedTurnId((current) => (turns.some((option) => option.turnId === current) ? current : turns[0]?.turnId ?? ""));
  }, [turns]);

  useEffect(() => {
    if (!conversationId || !selectedTurnId) {
      setTurn(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setError(undefined);
    fetchJson<ConversationTurn>(
      `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(selectedTurnId)}`,
      copy,
    )
      .then((value) => {
        if (!active) return;
        setTurn(value);
        onUpdated(new Date().toISOString());
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => {
      active = false;
    };
  }, [conversationId, selectedTurnId, copy, refreshToken, onUpdated]);

  if (turns.length === 0) {
    return (
      <div className="conversation-tab-heading">
        <Empty>{copy.conversationTraceEmpty}</Empty>
      </div>
    );
  }

  return (
    <div className="conversation-trace">
      <div className="conversation-trace-picker">
        <Space size={10} wrap align="center">
          <Typography.Text type="secondary">{copy.conversationTurnPicker}</Typography.Text>
          <Select
            className="conversation-turn-select"
            aria-label={copy.conversationTurnPicker}
            value={selectedTurnId || undefined}
            options={turns.map((option) => ({ value: option.turnId, label: option.label }))}
            onChange={(value) => setSelectedTurnId(value)}
          />
          {turn ? <StatusBadge status={turn.status} label={translate(copy.statuses, turn.status)} /> : null}
        </Space>
        <Typography.Text type="secondary" className="conversation-trace-hint">{copy.conversationTraceSelectHint}</Typography.Text>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {!turn && !error ? <Loading>{copy.loading}</Loading> : null}
      {turn ? (
        <>
          <div className="conversation-turn-meta">
            <Space size={10} wrap>
              <Tag>{copy.traceDuration}: {formatTraceDuration(turnDurationMs(turn), copy)}</Tag>
              <Tag>{copy.attempts}: {turn.attemptCount}</Tag>
              <Tag>{copy.headSha}: {turn.headSha.slice(0, 12)}</Tag>
            </Space>
            {turn.lastError ? <p className="conversation-turn-error">{turn.lastError}</p> : null}
          </div>
          <TraceExperience entries={turn.trajectory} userRequest={turn.request} copy={copy} locale={locale} />
          <Panel title={copy.traceRecords}>
            <ExecutionSteps events={turn.events} copy={copy} locale={locale} />
          </Panel>
        </>
      ) : null}
    </div>
  );
}

/** 轮次从创建到最近更新的耗时；缺失或非法时间返回 null。 */
function turnDurationMs(turn: ConversationTurn): number | null {
  const start = Date.parse(turn.createdAt);
  const end = Date.parse(turn.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}
