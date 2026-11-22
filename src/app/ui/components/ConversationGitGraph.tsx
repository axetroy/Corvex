import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Spin, Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { GitGraphNode } from "../../../git/types.js";
import { buildGitGraphLayout, graphLaneX, graphNodeY } from "../gitGraph.js";

interface GraphResponse {
  nodes: GitGraphNode[];
  truncated: boolean;
  offset: number;
  pinnedSha: string;
}

interface Props {
  conversationId: string;
  copy: Copy;
}

const pageSize = 100;

/** 提交图谱：泳道由纯函数布局，节点只读，点击后展示提交元信息。 */
export function ConversationGitGraph({ conversationId, copy }: Props) {
  const [data, setData] = useState<GraphResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");

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
    void load(0);
  }, [load]);

  const layout = useMemo(() => buildGitGraphLayout(data?.nodes ?? [], data?.pinnedSha), [data]);
  const selectedNode = data?.nodes.find((node) => node.sha === selected);
  const graphWidth = Math.max(layout.width, 220);
  const svgWidth = graphWidth + 620;

  return (
    <div className="conversation-git-graph">
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {loading && !data ? <Spin size="small" /> : null}
      {data && data.nodes.length ? (
        <>
          <div className="conversation-git-graph-canvas">
            <svg width={svgWidth} height={layout.height} role="img" aria-label={copy.gitGraph}>
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
                  <g
                    key={node.sha}
                    className={`conversation-git-node${selected === node.sha ? " is-selected" : ""}`}
                    onClick={() => setSelected(node.sha)}
                  >
                    <circle cx={x} cy={y} r={node.isPinned ? 6 : 4.5} fill={color} stroke="var(--bg-panel)" strokeWidth={1.5} />
                    <text x={graphWidth + 6} y={y - 3} className="conversation-git-subject">
                      {node.subject || node.sha.slice(0, 12)}
                    </text>
                    <text x={graphWidth + 6} y={y + 11} className="conversation-git-meta">
                      {`${node.author} · ${node.authoredAt.slice(0, 10)} · ${node.sha.slice(0, 8)}`}
                    </text>
                    {node.refs.length ? (
                      <text x={graphWidth + 6} y={y + 23} className="conversation-git-refs">
                        {node.refs.join(" · ")}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
          {selectedNode ? (
            <div className="conversation-git-detail">
              <Typography.Text strong>{selectedNode.subject || selectedNode.sha}</Typography.Text>
              <div><code>{selectedNode.sha}</code></div>
              <div>{copy.gitGraphAuthor}: {selectedNode.author}</div>
              <div>{copy.gitGraphDate}: {selectedNode.authoredAt}</div>
              <div>{copy.gitGraphParents}: {selectedNode.parents.map((sha) => sha.slice(0, 8)).join(" · ") || copy.none}</div>
              {selectedNode.refs.length ? <div>{copy.gitGraphRefs}: {selectedNode.refs.join(" · ")}</div> : null}
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
