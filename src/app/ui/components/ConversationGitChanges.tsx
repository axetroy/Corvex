import { useCallback, useEffect, useState } from "react";
import { Button, Select, Spin, Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import { highlightCode } from "../codeHighlight.js";

interface FileChange {
  path: string;
  status: string;
  patch: string;
  truncated: boolean;
}

interface ChangesResponse {
  sha: string;
  files: FileChange[];
  truncated: boolean;
}

interface TurnSummary {
  turnId: string;
  request: string;
  status: string;
  createdAt: string;
}

interface TurnsResponse {
  turns: TurnSummary[];
}

interface Props {
  conversationId: string;
  copy: Copy;
}

/** 会话 ref 相对固定快照的文件变更：直接来自 Git，不依赖工具调用记录。 */
export function ConversationGitChanges({ conversationId, copy }: Props) {
  const [changes, setChanges] = useState<ChangesResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [turns, setTurns] = useState<TurnSummary[]>([]);
  const [selectedTurn, setSelectedTurn] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const path = selectedTurn
        ? `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(selectedTurn)}/changes`
        : `/api/ops/conversations/${encodeURIComponent(conversationId)}/git/changes`;
      const result = await fetchJson<ChangesResponse>(path, copy);
      setChanges(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [conversationId, copy, selectedTurn]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    fetchJson<TurnsResponse>(
      `/api/ops/conversations/${encodeURIComponent(conversationId)}/turns`, copy,
    ).then((result) => {
      if (active) setTurns(result.turns ?? []);
    }).catch(() => {
      if (active) setTurns([]);
    });
    return () => { active = false; };
  }, [conversationId, copy]);

  return (
    <div className="conversation-git-changes">
      <div className="conversation-git-changes-toolbar">
        <Typography.Text type="secondary">
          {selectedTurn ? copy.gitChangesTurnHint : copy.gitChangesHint}
        </Typography.Text>
        <div className="conversation-git-changes-actions">
          <Select
            size="small"
            allowClear
            showSearch
            value={selectedTurn || undefined}
            placeholder={copy.gitChangesSelectTurn}
            aria-label={copy.gitChangesSelectTurn}
            onChange={(value) => setSelectedTurn(value ?? "")}
            className="conversation-git-changes-turn-filter"
            options={[
              { value: "", label: copy.gitChangesAllTurns },
              ...turns.map((turn, index) => ({
                value: turn.turnId,
                label: `${copy.gitChangesTurnLabel} ${index + 1}: ${turn.request.trim().replace(/\s+/g, " ").slice(0, 40)}`,
              })),
            ]}
          />
          <Button size="small" loading={loading} onClick={() => void load()}>{copy.refresh}</Button>
        </div>
      </div>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {loading && !changes ? <Spin size="small" /> : null}
      {changes && !changes.files.length ? <Typography.Text type="secondary">{copy.gitChangesEmpty}</Typography.Text> : null}
      {changes?.files.length ? (
        <div className="conversation-git-files">
          <div className="conversation-git-files-summary">
            {copy.gitChangesCount.replace("{count}", String(changes.files.length))}
            {changes.sha ? <code>{changes.sha.slice(0, 8)}</code> : null}
            {changes.truncated ? <span className="conversation-git-truncated">{copy.gitGraphTruncated}</span> : null}
          </div>
          {changes.files.map((file) => (
            <details
              className="conversation-git-file"
              key={file.path}
              open={expanded === file.path}
              onToggle={(event) => setExpanded(event.currentTarget.open ? file.path : "")}
            >
              <summary>
                <span className={`conversation-git-file-status is-${file.status.trim().slice(0, 1)}`}>{file.status.trim()}</span>
                <code>{file.path}</code>
              </summary>
              <div className="conversation-git-file-body">
                {file.patch ? (
                  <pre dangerouslySetInnerHTML={{ __html: highlightCode(file.patch, "diff") }} />
                ) : (
                  <Typography.Text type="secondary">{copy.gitChangesNoPatch}</Typography.Text>
                )}
                {file.truncated ? <Typography.Text type="secondary">{copy.gitGraphTruncated}</Typography.Text> : null}
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </div>
  );
}
