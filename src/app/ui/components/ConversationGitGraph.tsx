import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Spin, Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { GitGraphNode } from "../../../git/types.js";
import { buildGitGraphLayout, graphLaneX, graphNodeY } from "../gitGraph.js";
import { highlightCode } from "../codeHighlight.js";

interface GraphResponse {
  nodes: GitGraphNode[];
  truncated: boolean;
  offset: number;
  pinnedSha: string;
}

interface CommitDetail {
  sha: string;
  output: string;
  truncated: boolean;
}

interface Props {
  conversationId: string;
  copy: Copy;
}

const pageSize = 100;

/** 提交图谱：泳道由纯函数布局，点击节点展开提交详情与补丁。 */
export function ConversationGitGraph({ conversationId, copy }: Props) {
  const [data, setData] = useState<GraphResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<CommitDetail>();
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
      const result = await fetchJson<GraphResponse>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/git/graph?${query}`, copy,
      );
      setData((current) => offset === 0 ? result : {
        ...result,
        nodes: [...(current?.nodes ?? []), ...result.nodes],
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [conversationId, copy]);

  useEffect(() => {
    setData(undefined);
    setSelected("");
    setDetail(undefined);
    void load(0);
  }, [load]);

  const selectNode = useCallback(async (sha: string) => {
    if (selected === sha) {
      setSelected("");
      setDetail(undefined);
      return;
    }
    setSelected(sha);
    setDetail(undefined);
    setDetailLoading(true);
    try {
      const result = await fetchJson<CommitDetail>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/git/commit/${encodeURIComponent(sha)}`, copy,
      );
      setDetail(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setDetailLoading(false);
    }
  }, [selected, conversationId, copy]);

  const layout = useMemo(() => buildGitGraphLayout(data?.nodes ?? [], data?.pinnedSha), [data]);
  const selectedNode = data?.nodes.find((node) => node.sha === selected);

  return (
    <div className="conversation-git-graph">
      <div className="conversation-git-legend">
        <span><i className="dot is-pinned" />{copy.gitGraphPinned}</span>
        <span><i className="dot is-local" />{copy.gitGraphLocalRef}</span>
        <span><i className="dot is-branch" />{copy.gitGraphBranch}</span>
      </div>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {loading && !data ? <Spin size="small" /> : null}
      {data && data.nodes.length ? (
        <>
          <div className="conversation-git-board">
            <svg className="conversation-git-lanes" width={layout.width} height={layout.height} role="img" aria-label={copy.gitGraph}>
              {layout.edges.map((edge) => {
                const x1 = graphLaneX(edge.lane);
                const y1 = graphNodeY(edge.row);
                const target = layout.nodes.find((node) => node.sha === edge.to);
                if (!target) return null;
                const x2 = graphLaneX(edge.targetLane);
                const y2 = graphNodeY(target.row);
                const mid = (y1 + y2) / 2;
                return (
                  <path
                    key={`${edge.from}-${edge.to}`}
                    d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                    fill="none"
                    stroke={edge.lane === edge.targetLane ? "var(--text-faint)" : "var(--purple)"}
                    strokeWidth={1.4}
                  />
                );
              })}
              {layout.nodes.map((node) => {
                const x = graphLaneX(node.lane);
                const y = graphNodeY(node.row);
                const color = node.isPinned ? "var(--primary)" : node.hasLocalRef ? "var(--success)" : "var(--text-secondary)";
                return (
                  <circle
                    key={node.sha}
                    cx={x}
                    cy={y}
                    r={node.isPinned ? 6 : 4.5}
                    fill={selected === node.sha ? "var(--primary)" : color}
                    stroke="var(--bg-panel)"
                    strokeWidth={1.5}
                  />
                );
              })}
            </svg>
            <div className="conversation-git-rows" style={{ height: layout.height }}>
              {layout.nodes.map((node) => (
                <button
                  key={node.sha}
                  type="button"
                  className={`conversation-git-row${selected === node.sha ? " is-selected" : ""}${node.isPinned ? " is-pinned" : ""}`}
                  onClick={() => void selectNode(node.sha)}
                >
                  <span className="conversation-git-row-subject">{node.subject || node.sha.slice(0, 12)}</span>
                  <span className="conversation-git-row-meta">
                    {`${node.author} · ${node.authoredAt.slice(0, 10)} · ${node.sha.slice(0, 8)}`}
                  </span>
                  {node.refs.length ? <span className="conversation-git-row-refs">{node.refs.join(" · ")}</span> : null}
                </button>
              ))}
            </div>
          </div>
          {selectedNode ? (
            <div className="conversation-git-detail">
              <div className="conversation-git-detail-head">
                <Typography.Text strong>{selectedNode.subject || selectedNode.sha}</Typography.Text>
                <span>{copy.gitGraphAuthor}: {selectedNode.author}</span>
                <span>{copy.gitGraphDate}: {selectedNode.authoredAt}</span>
                <code>{selectedNode.sha}</code>
              </div>
              {detailLoading ? <Spin size="small" /> : detail ? (
                <>
                  <div className="conversation-git-detail-parents">
                    {copy.gitGraphParents}: {selectedNode.parents.map((sha) => sha.slice(0, 8)).join(" · ") || copy.none}
                    {selectedNode.refs.length ? ` · ${copy.gitGraphRefs}: ${selectedNode.refs.join(" · ")}` : ""}
                  </div>
                  <pre className="conversation-git-patch" dangerouslySetInnerHTML={{ __html: highlightCode(detail.output, "diff") }} />
                  {detail.truncated ? <Typography.Text type="secondary">{copy.gitGraphTruncated}</Typography.Text> : null}
                </>
              ) : null}
            </div>
          ) : null}
          {data.truncated ? (
            <Button size="small" type="link" loading={loading} onClick={() => void load(data.offset + data.nodes.length)}>
              {copy.gitGraphLoadMore}
            </Button>
          ) : null}
        </>
      ) : !loading ? (
        <Typography.Text type="secondary">{copy.gitGraphEmpty}</Typography.Text>
      ) : null}
    </div>
  );
}
