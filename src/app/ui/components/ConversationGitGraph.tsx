import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Button, Dropdown, Select, Spin, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { GitGraphNode } from "../../../git/types.js";
import { buildGitGraphLayout, graphLaneX, type GraphLaneNode } from "../gitGraph.js";
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

/** 提交图谱：左侧 SVG 泳道 + 右侧 Table 列对齐，点击行就地展开提交详情。 */
export function ConversationGitGraph({ conversationId, copy }: Props) {
  const [data, setData] = useState<GraphResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [detail, setDetail] = useState<CommitDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [authors, setAuthors] = useState<string[]>([]);
  const [author, setAuthor] = useState("");
  const tableRef = useRef<HTMLDivElement>(null);
  const [rowMetrics, setRowMetrics] = useState<Array<{ top: number; height: number }>>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: GraphLaneNode } | null>(null);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
      if (author) query.set("author", author);
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
  }, [conversationId, copy, author]);

  useEffect(() => {
    setData(undefined);
    setExpanded("");
    setDetail(undefined);
    void load(0);
  }, [load]);

  useEffect(() => {
    let active = true;
    fetchJson<{ authors: string[] }>(
      `/api/ops/conversations/${encodeURIComponent(conversationId)}/git/authors`, copy,
    ).then((result) => {
      if (active) setAuthors(result.authors ?? []);
    }).catch(() => {
      if (active) setAuthors([]);
    });
    return () => { active = false; };
  }, [conversationId, copy]);

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

  const copyValue = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (cause) {
      setError(copy.gitMenuCopyFailed || errorMessage(cause));
    }
  }, [copy]);

  const copyPatch = useCallback(async (sha: string) => {
    try {
      const result = await fetchJson<CommitDetail>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/git/commit/${encodeURIComponent(sha)}`, copy,
      );
      await copyValue(result.output);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [conversationId, copy, copyValue]);

  // 受控 Dropdown 无 trigger，外部点击与 Escape 需自行关闭。
  useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".conversation-git-context-menu") || target.closest(".conversation-git-context-anchor")) return;
      setContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const contextMenuItems = (node: GraphLaneNode) => [
    { key: "hash", label: copy.gitMenuCopyHash, onClick: () => void copyValue(node.sha) },
    { key: "shortHash", label: copy.gitMenuCopyShortHash, onClick: () => void copyValue(node.sha.slice(0, 8)) },
    { key: "subject", label: copy.gitMenuCopySubject, onClick: () => void copyValue(node.subject) },
    { key: "author", label: copy.gitMenuCopyAuthor, onClick: () => void copyValue(node.author) },
    { type: "divider" as const },
    { key: "patch", label: copy.gitMenuCopyPatch, onClick: () => void copyPatch(node.sha) },
    { key: "detail", label: copy.gitMenuViewDetail, onClick: () => void toggleRow(node.sha) },
  ];

  // Table 的行高/展开由 antd 控制；读取真实 DOM 位置让泳道节点与连线严格对齐。
  useEffect(() => {
    const measure = () => {
      const container = tableRef.current;
      if (!container) return;
      const top = container.getBoundingClientRect().top;
      const metrics = [...container.querySelectorAll<HTMLElement>("tr.ant-table-row")].map((row) => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top - top, height: rect.height };
      });
      setRowMetrics((current) => current.length === metrics.length && current.every((item, index) =>
        item.top === metrics[index]?.top && item.height === metrics[index]?.height) ? current : metrics);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (tableRef.current) observer.observe(tableRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [data, expanded, detail]);

  const layout = useMemo(() => buildGitGraphLayout(data?.nodes ?? [], data?.pinnedSha), [data]);
  const nodeY = (row: number) => {
    const metric = rowMetrics[row];
    return metric ? metric.top + metric.height / 2 : row * 34 + 17;
  };
  const svgHeight = rowMetrics.length
    ? rowMetrics.at(-1)!.top + rowMetrics.at(-1)!.height + 12
    : layout.nodes.length * 34 + 24;

  const columns: ColumnsType<GraphLaneNode> = [
    {
      title: copy.gitGraphCommit,
      dataIndex: "subject",
      key: "subject",
      ellipsis: true,
      render: (_value, node) => (
        <span className="conversation-git-cell-title">
          <span>{node.subject || node.sha.slice(0, 12)}</span>
          {node.refs.length ? <span className="conversation-git-row-refs">{node.refs.join(" · ")}</span> : null}
        </span>
      ),
    },
    {
      title: copy.gitGraphDate,
      dataIndex: "authoredAt",
      key: "authoredAt",
      width: 150,
      sorter: (a, b) => a.authoredAt.localeCompare(b.authoredAt),
      render: (value: string) => <span className="conversation-git-cell-muted">{value.slice(0, 16).replace("T", " ")}</span>,
    },
    {
      title: copy.gitGraphAuthor,
      dataIndex: "author",
      key: "author",
      width: 150,
      ellipsis: true,
      sorter: (a, b) => a.author.localeCompare(b.author),
      render: (value: string) => <span className="conversation-git-cell-muted">{value}</span>,
    },
    {
      title: copy.gitGraphHash,
      dataIndex: "sha",
      key: "sha",
      width: 100,
      render: (value: string) => <code className="conversation-git-cell-hash">{value.slice(0, 8)}</code>,
    },
  ];

  return (
    <div className="conversation-git-graph">
      <div className="conversation-git-toolbar">
        <div className="conversation-git-legend">
          <span><i className="dot is-pinned" />{copy.gitGraphPinned}</span>
          <span><i className="dot is-local" />{copy.gitGraphLocalRef}</span>
          <span><i className="dot is-branch" />{copy.gitGraphBranch}</span>
        </div>
        <Select
          className="conversation-git-author-filter"
          allowClear
          showSearch
          size="small"
          value={author || undefined}
          placeholder={copy.gitGraphFilterAuthor}
          aria-label={copy.gitGraphFilterAuthor}
          onChange={(value) => setAuthor(value ?? "")}
          options={authors.map((name) => ({ value: name, label: name }))}
        />
      </div>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {loading && !data ? <Spin size="small" /> : null}
      {data && data.nodes.length ? (
        <>
          <div className="conversation-git-board conversation-git-table-board">
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
                    stroke={edge.implicit ? "var(--text-faint)" : edge.lane === edge.targetLane ? "var(--text-faint)" : "var(--purple)"}
                    strokeWidth={1.4}
                    strokeDasharray={edge.implicit ? "3 3" : undefined}
                  />
                );
              })}
              {layout.nodes.map((node, row) => {
                const color = node.isPinned ? "var(--primary)" : node.hasLocalRef ? "var(--success)" : "var(--text-secondary)";
                return (
                  <circle
                    key={node.sha}
                    cx={graphLaneX(node.lane)}
                    cy={nodeY(row)}
                    r={node.isPinned ? 6 : 4.5}
                    fill={expanded === node.sha ? "var(--primary)" : color}
                    stroke="var(--bg-panel)"
                    strokeWidth={1.5}
                  />
                );
              })}
            </svg>
            <div className="conversation-git-table" ref={tableRef}>
              <Table<GraphLaneNode>
                size="small"
                rowKey="sha"
                columns={columns}
                dataSource={layout.nodes}
                pagination={false}
                tableLayout="fixed"
                scroll={{ x: "max-content" }}
                rowClassName={(node) =>
                  `conversation-git-table-row${node.isPinned ? " is-pinned" : ""}${expanded === node.sha ? " is-selected" : ""}${contextMenu?.node.sha === node.sha ? " is-context-target" : ""}`
                }
                onRow={(node) => ({
                  onClick: () => void toggleRow(node.sha),
                  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, node });
                  },
                })}
                expandable={{
                  columnWidth: 0,
                  expandedRowKeys: expanded ? [expanded] : [],
                  onExpandedRowsChange: () => undefined,
                  expandIcon: () => null,
                  expandedRowRender: (node) => (
                    <div className="conversation-git-detail">
                      <div className="conversation-git-detail-head">
                        <Typography.Text strong>{node.subject || node.sha.slice(0, 12)}</Typography.Text>
                        <span>{copy.gitGraphAuthor}: {node.author}</span>
                        <span>{copy.gitGraphDate}: {node.authoredAt}</span>
                        <code>{node.sha}</code>
                      </div>
                      {detailLoading ? <Spin size="small" /> : detail?.sha === node.sha ? (
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
                  ),
                }}
              />
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
      {contextMenu ? (
        <Dropdown
          open
          trigger={[]}
          placement="bottomLeft"
          menu={{ items: contextMenuItems(contextMenu.node), onClick: () => setContextMenu(null) }}
          onOpenChange={(open) => { if (!open) setContextMenu(null); }}
          classNames={{ root: "conversation-git-context-menu" }}
        >
          <span
            className="conversation-git-context-anchor"
            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, width: 1, height: 1 }}
          />
        </Dropdown>
      ) : null}
    </div>
  );
}
