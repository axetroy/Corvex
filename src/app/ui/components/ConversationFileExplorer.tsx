import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Spin, Tree, Typography } from "antd";
import type { TreeDataNode } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { FileContentResult, FileListResult } from "../../files/source.js";
import { entriesToTreeNodes, mergeTreeChildren, pathSegments } from "../fileTree.js";
import type { FileTreeNode } from "../fileTree.js";
import { FileIcon, FolderIcon } from "./icons.js";

interface Props {
  conversationId: string;
  copy: Copy;
}

interface CachedContent extends FileContentResult {
  loading: boolean;
  error: string;
  startLine: number;
}

/** 类 VSCode 文件浏览：左侧可展开目录树，右侧多标签文本预览。 */
export function ConversationFileExplorer({ conversationId, copy }: Props) {
  const [treeData, setTreeData] = useState<FileTreeNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [treeError, setTreeError] = useState("");
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [contents, setContents] = useState<Record<string, CachedContent>>({});

  const loadDirectory = useCallback(async (path: string): Promise<FileListResult> => {
    const query = new URLSearchParams({ path });
    try {
      const response = await fetchJson<FileListResult>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/files/tree?${query}`,
        copy,
      );
      const nodes = entriesToTreeNodes(response.entries, path);
      setTreeData((current) => (path ? mergeTreeChildren(current, path, nodes) : nodes));
      setTreeError("");
      return response;
    } catch (cause) {
      const message = errorMessage(cause);
      setTreeError(message.includes("no pinned commit") ? copy.filePanelNoPinnedCommit : message);
      return { entries: [], truncated: false };
    }
  }, [conversationId, copy]);

  useEffect(() => {
    let active = true;
    setTreeData([]);
    setExpandedKeys([]);
    setOpenFiles([]);
    setActiveFile("");
    setContents({});
    setTreeError("");
    if (!conversationId) {
      setLoadingRoot(false);
      return () => {
        active = false;
      };
    }
    setLoadingRoot(true);
    void loadDirectory("")
      .finally(() => {
        if (active) setLoadingRoot(false);
      });
    return () => {
      active = false;
    };
  }, [loadDirectory, conversationId]);

  const loadContent = useCallback(async (path: string, startLine?: number) => {
    setContents((current) => ({
      ...current,
      [path]: { path, content: "", truncated: false, loading: true, error: "", startLine: startLine ?? 1 },
    }));
    const params = new URLSearchParams({ path });
    if (startLine && startLine > 1) params.set("startLine", String(startLine));
    try {
      const response = await fetchJson<FileContentResult>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/files/content?${params}`,
        copy,
      );
      setContents((current) => ({
        ...current,
        [path]: { ...response, loading: false, error: "", startLine: startLine ?? 1 },
      }));
    } catch (cause) {
      setContents((current) => ({
        ...current,
        [path]: { path, content: "", truncated: false, loading: false, error: errorMessage(cause), startLine: startLine ?? 1 },
      }));
    }
  }, [conversationId, copy]);

  const openFile = useCallback((path: string) => {
    setOpenFiles((current) => (current.includes(path) ? current : [...current, path]));
    setActiveFile(path);
    if (!contents[path]) void loadContent(path);
  }, [contents, loadContent]);

  const closeFile = useCallback((path: string) => {
    setOpenFiles((current) => {
      const next = current.filter((item) => item !== path);
      setActiveFile((active) => (active === path ? next.at(-1) ?? "" : active));
      return next;
    });
  }, []);

  const filteredTree = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return treeData;
    const filter = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.flatMap((node) => {
      const children = node.children ? filter(node.children as FileTreeNode[]) : [];
      if (node.title.toLowerCase().includes(keyword) || children.length) {
        return [{ ...node, children: children.length ? children : undefined }];
      }
      return [];
    });
    return filter(treeData);
  }, [treeData, search]);

  const renderedTree: TreeDataNode[] = filteredTree.map((node) => ({
    ...node,
    icon: node.type === "directory" ? <FolderIcon /> : <FileIcon />,
  }));

  const active = activeFile ? contents[activeFile] : undefined;
  const lineCount = active?.content ? active.content.split("\n").length : 0;

  return (
    <div className="conversation-file-explorer">
      <div className="conversation-file-toolbar">
        <Input
          size="small"
          allowClear
          value={search}
          placeholder={copy.filePanelSearch}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {treeError ? <Typography.Text type="danger" className="conversation-file-error">{treeError}</Typography.Text> : null}
      <div className="conversation-file-body">
        <div className="conversation-file-tree">
          {loadingRoot ? <Spin size="small" /> : renderedTree.length ? (
            <Tree
              blockNode
              treeData={renderedTree}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys.map(String))}
              loadData={(node) => loadDirectory((node as unknown as FileTreeNode).path)}
              onSelect={(_keys, info) => {
                const node = info.node as unknown as FileTreeNode;
                if (node.isLeaf) openFile(node.path);
                else setExpandedKeys((keys) => keys.includes(node.path) ? keys.filter((key) => key !== node.path) : [...keys, node.path]);
              }}
            />
          ) : (
            <Typography.Text type="secondary" className="conversation-file-empty">{copy.filePanelEmpty}</Typography.Text>
          )}
        </div>
        <div className="conversation-file-editor">
          {openFiles.length ? (
            <>
              <div className="conversation-file-tabs">
                {openFiles.map((path) => (
                  <button
                    key={path}
                    type="button"
                    className={`conversation-file-tab${path === activeFile ? " is-active" : ""}`}
                    title={path}
                    onClick={() => setActiveFile(path)}
                  >
                    <FileIcon />
                    <span>{pathSegments(path).at(-1) ?? path}</span>
                    <span
                      role="button"
                      tabIndex={0}
                      className="conversation-file-tab-close"
                      aria-label={copy.filePanelClose}
                      onClick={(event) => { event.stopPropagation(); closeFile(path); }}
                      onKeyDown={(event) => { if (event.key === "Enter") closeFile(path); }}
                    >
                      ×
                    </span>
                  </button>
                ))}
              </div>
              <div className="conversation-file-breadcrumb">{pathSegments(activeFile).join(" / ")}</div>
              <div className="conversation-file-content">
                {active?.loading ? <Spin size="small" /> : active?.error ? (
                  <Typography.Text type="danger">{active.error}</Typography.Text>
                ) : active ? (
                  <>
                    <pre>
                      {active.content.split("\n").map((line, index) => (
                        <div className="conversation-file-line" key={index}>
                          <span className="conversation-file-line-no">{(active.startLine ?? 1) + index}</span>
                          <span className="conversation-file-line-text">{line || " "}</span>
                        </div>
                      ))}
                    </pre>
                    {active.truncated ? (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => void loadContent(activeFile, (active.startLine ?? 1) + Math.max(1, lineCount - 1))}
                      >
                        {copy.filePanelLoadMore}
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <Typography.Text type="secondary" className="conversation-file-empty">{copy.filePanelEmpty}</Typography.Text>
          )}
        </div>
      </div>
    </div>
  );
}
