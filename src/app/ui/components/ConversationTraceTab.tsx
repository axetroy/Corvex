import { useEffect, useMemo, useState } from "react";
import { Select, Space, Tag, Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import { formatDate, formatTraceDuration } from "../format.js";
import { translate } from "../i18n.js";
import type { Copy, Locale } from "../i18n.js";
import type { ConversationMessage, ConversationTurn, ConversationTurns } from "../types.js";
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

/** 可查看轨迹的轮次：助手回复且已关联轮次（含尚未产出轨迹的进行中轮次）。 */
interface TurnOption {
  messageId: string;
  turnId: string;
  label: string;
  status: ConversationMessage["status"];
  createdAt: string;
}

/**
 * 对话「轨迹」标签：默认把该对话全部轮次合并成一条时间线轨迹，也可以只聚焦某一轮，
 * 连同该轮的生命周期与执行步骤一起查看。
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
  // 空字符串表示「全部轮次」，即把整段对话合并成一条轨迹。
  const [selectedTurnId, setSelectedTurnId] = useState("");
  const [all, setAll] = useState<ConversationTurns>();
  const [single, setSingle] = useState<ConversationTurn>();
  const [error, setError] = useState<string>();

  // 切换对话时回到「全部轮次」的默认视图。
  useEffect(() => {
    setSelectedTurnId("");
    setAll(undefined);
    setSingle(undefined);
  }, [conversationId]);

  // 选中轮次在刷新后可能消失（例如被取消），回退到全部轮次。
  useEffect(() => {
    setSelectedTurnId((current) => (current && !turns.some((option) => option.turnId === current) ? "" : current));
  }, [turns]);

  useEffect(() => {
    if (!conversationId) {
      setAll(undefined);
      setSingle(undefined);
      setError(undefined);
      return;
    }
    let active = true;
    setError(undefined);
    const path = selectedTurnId
      ? `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(selectedTurnId)}`
      : `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns`;
    fetchJson<ConversationTurns | ConversationTurn>(path, copy)
      .then((value) => {
        if (!active) return;
        // 整段返回带 `turns`，单轮返回带 `timeline`；据此区分两份视图数据。
        if ("turns" in value) {
          setAll(value);
          setSingle(undefined);
        } else {
          setSingle(value);
          setAll(undefined);
        }
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

  const loading = selectedTurnId ? !single : !all;

  return (
    <div className="conversation-trace">
      <div className="conversation-trace-picker">
        <Space size={10} wrap align="center">
          <Typography.Text type="secondary">{copy.conversationTurnPicker}</Typography.Text>
          <Select
            className="conversation-turn-select"
            aria-label={copy.conversationTurnPicker}
            value={selectedTurnId}
            options={[
              { value: "", label: copy.conversationTraceAllTurns },
              ...turns.map((option) => ({ value: option.turnId, label: option.label })),
            ]}
            onChange={(value) => setSelectedTurnId(value)}
          />
          {single ? <StatusBadge status={single.status} label={translate(copy.statuses, single.status)} /> : null}
        </Space>
        <Typography.Text type="secondary" className="conversation-trace-hint">{copy.conversationTraceSelectHint}</Typography.Text>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {loading && !error ? <Loading>{copy.loading}</Loading> : null}
      {single ? (
        <>
          <div className="conversation-turn-meta">
            <Space size={10} wrap>
              <Tag>{copy.traceDuration}: {formatTraceDuration(turnDurationMs(single), copy)}</Tag>
              <Tag>{copy.attempts}: {single.attemptCount}</Tag>
              <Tag>{copy.headSha}: {single.headSha.slice(0, 12)}</Tag>
            </Space>
            {single.lastError ? <p className="conversation-turn-error">{single.lastError}</p> : null}
          </div>
          <TraceExperience entries={single.trajectory} copy={copy} locale={locale} />
          <Panel title={copy.traceRecords}>
            <ExecutionSteps events={single.events} copy={copy} locale={locale} />
          </Panel>
        </>
      ) : null}
      {all ? (
        <>
          <div className="conversation-turn-meta">
            <Space size={10} wrap>
              <Tag>{copy.conversationTraceTurnCountTemplate.replace("{count}", String(all.turns.length))}</Tag>
              <Tag>{copy.traceDuration}: {formatTraceDuration(mergedDurationMs(all), copy)}</Tag>
              <Tag>{copy.traceRecords}: {all.trajectory.length}</Tag>
            </Space>
          </div>
          <TraceExperience entries={all.trajectory} turns={all.turns} copy={copy} locale={locale} />
          <Panel title={copy.traceRecords}>
            <ExecutionSteps events={all.events} copy={copy} locale={locale} />
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

/** 全部轮次的累计耗时：按各轮创建到更新的时长求和，缺失的轮次跳过。 */
function mergedDurationMs(all: ConversationTurns): number | null {
  let total = 0;
  let measured = 0;
  for (const turn of all.turns) {
    const start = Date.parse(turn.createdAt);
    const end = Date.parse(turn.updatedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    total += end - start;
    measured++;
  }
  return measured > 0 ? total : null;
}
