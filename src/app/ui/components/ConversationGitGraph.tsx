import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Spin, Typography } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { GitGraphNode } from "../../../git/types.js";
import { buildGitGraphLayout, graphLaneX, graphPadding, graphRowHeight } from "../gitGraph.js";
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
/** 详情展开但还未测量高度时的估值，测量后会被真实高度替换。 */
const estimatedDetailHeight = 220;

/** 提交图谱：点击提交行就地展开详情；泳道节点与连线按各行实际高度重新定位。 */
export function ConversationGitGraph({ conversationId, copy }: Props) {
  const [data, setData] = useState<GraphResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [detail, setDetail] = useState<CommitDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailHeights, setDetailHeights] = useState<Record<string, number>>({});

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
    setExpanded("");
    setDetail(undefined);
    setDetailHeights({});
    void load(0);
  }, [load]);

  const toggleRow = useCallback(async (sha: string) => {
    if (expanded === sha) {
      setExpanded("");
      setDetail(undefined);
      return;
    }
    setExpanded(sha);
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
  }, [expanded, conversationId, copy]);

  const layout = useMemo(() => buildGitGraphLayout(data?.nodes ?? [], data?.pinnedSha), [data]);

  // 每行顶部位置随上方可展开的详情高度变化；节点与连线都按这个偏移重算。
  const rowTops = useMemo(() => {
    const tops: number[] = [];
    // 行列表没有内边距，节点圆心须与行中心重合，故从 0 开始累加。
    let top = 0;
    for (const node of layout.nodes) {
      tops.push(top);
      top += expanded === node.sha ? (detailHeights[node.sha] ?? estimatedDetailHeight + graphRowHeight) : graphRowHeight;
    }
    return tops;
  }, [layout.nodes, expanded, detailHeights]);
  const svgHeight = (rowTops.at(-1) ?? graphPadding) + graphRowHeight + graphPadding;
  const nodeY = (row: number) => (rowTops[row] ?? 0) + graphRowHeight / 2;

  const expandedNode = layout.nodes.find((node) => node.sha === expanded);

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
            <svg className="conversation-git-lanes" width={layout.width} height={svgHeight} role="img" aria-label={copy.gitGraph}>
              {layout.edges.map((edge) => {
                const target = layout.nodes.find((node) => node.sha === edge.to);
                if (!target) return null;
                const x1 = graphLaneX(edge.lane);
                const y1 = nodeY(edge.row);
                const x2 = graphLaneX(edge.targetLane);
                const y2 = nodeY(target.row);
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
                const color = node.isPinned ? "var(--primary)" : node.hasLocalRef ? "var(--success)" : "var(--text-secondary)";
                return (
                  <circle
                    key={node.sha}
                    cx={graphLaneX(node.lane)}
                    cy={nodeY(node.row)}
                    r={node.isPinned ? 6 : 4.5}
                    fill={expanded === node.sha ? "var(--primary)" : color}
                    stroke="var(--bg-panel)"
                    strokeWidth={1.5}
                  />
                );
              })}
            </svg>
            <div className="conversation-git-rows">
              {layout.nodes.map((node) => (
                <div key={node.sha} className="conversation-git-item">
                  <button
                    type="button"
                    className={`conversation-git-row${expanded === node.sha ? " is-selected" : ""}${node.isPinned ? " is-pinned" : ""}`}
                    onClick={() => void toggleRow(node.sha)}
                    aria-expanded={expanded === node.sha}
                  >
                    <span className="conversation-git-row-subject">{node.subject || node.sha.slice(0, 12)}</span>
                    <span className="conversation-git-row-meta">
                      {`${node.author} · ${node.authoredAt.slice(0, 10)} · ${node.sha.slice(0, 8)}`}
                    </span>
                    {node.refs.length ? <span className="conversation-git-row-refs">{node.refs.join(" · ")}</span> : null}
                  </button>
                  {expanded === node.sha ? (
                    <div
                      className="conversation-git-detail"
                      ref={(element) => {
                        if (!element) return;
                        const observer = new ResizeObserver(() => {
                          // 测量整个条目（含行、详情与间距），使下一行的偏移与页面完全一致。
                          const item = element.parentElement;
                          const height = (item ?? element).getBoundingClientRect().height;
                          setDetailHeights((current) => current[node.sha] === height ? current : { ...current, [node.sha]: height });
                        });
                        observer.observe(element);
                        return () => observer.disconnect();
                      }}
                    >
                      <div className="conversation-git-detail-head">
                        <Typography.Text strong>{expandedNode?.subject || node.sha}</Typography.Text>
                        <span>{copy.gitGraphAuthor}: {node.author}</span>
                        <span>{copy.gitGraphDate}: {node.authoredAt}</span>
                        <code>{node.sha}</code>
                      </div>
                      {detailLoading ? <Spin size="small" /> : detail && expandedNode?.sha === node.sha ? (
                        <>
                          <div className="conversation-git-detail-parents">
                            {copy.gitGraphParents}: {node.parents.map((sha) => sha.slice(0, 8)).join(" · ") || copy.none}
                            {node.refs.length ? ` · ${copy.gitGraphRefs}: ${node.refs.join(" · ")}` : ""}
                          </div>
                          <pre className="conversation-git-patch" dangerouslySetInnerHTML={{ __html: highlightCode(detail.output, "diff") }} />
                          {detail.truncated ? <Typography.Text type="secondary">{copy.gitGraphTruncated}</Typography.Text> : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
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
