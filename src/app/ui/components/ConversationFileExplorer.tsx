import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Input, Spin, Tree, Typography } from "antd";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import type { TreeDataNode } from "antd";
import { fetchJson } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../i18n.js";
import type { FileContentResult, FileListResult, FileSourceKind } from "../../files/source.js";
import { isImagePath } from "../../files/image.js";
import { entriesToTreeNodes, mergeTreeChildren, pathSegments } from "../fileTree.js";
import type { FileTreeNode } from "../fileTree.js";
import { FileIcon } from "./icons.js";
import { ImagePreview } from "./ImagePreview.js";
import { renderFileIcon } from "../fileIcons.js";

// Monaco 体积较大，只有真正打开文本文件时才加载。
const CodeViewer = lazy(() => import("./CodeViewer.js").then((module) => ({ default: module.CodeViewer })));

interface Props {
  conversationId: string;
  copy: Copy;
}

interface CachedContent extends FileContentResult {
  loading: boolean;
  error: string;
  startLine: number;
}

const fileSplitLayoutKey = "corvex-ops-conversation-file-split-layout";

function readFileSplitLayout(): Layout | undefined {
  try {
    const raw = window.localStorage.getItem(fileSplitLayoutKey);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Layout;
    if (parsed && typeof parsed === "object" && Object.values(parsed).every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100,
    )) return parsed;
  } catch (error) {
    window.console.warn("read file split layout failed", error);
  }
  return undefined;
}

function saveFileSplitLayout(layout: Layout): void {
  try {
    window.localStorage.setItem(fileSplitLayoutKey, JSON.stringify(layout));
  } catch (error) {
    window.console.warn("save file split layout failed", error);
  }
}

/** 类 VSCode 文件浏览：左侧可展开目录树，右侧多标签文本与图片预览。 */
export function ConversationFileExplorer({ conversationId, copy }: Props) {
  const [savedSplit] = useState(readFileSplitLayout);
  const [treeData, setTreeData] = useState<FileTreeNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [treeError, setTreeError] = useState("");
  const [sourceKind, setSourceKind] = useState<FileSourceKind | "">("");
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
      setSourceKind((current) => response.source ?? current);
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
    setSourceKind("");
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

  const loadContent = useCallback(async (path: string, startLine?: number, full = false) => {
    setContents((current) => ({
      ...current,
      [path]: { path, content: "", truncated: false, loading: true, error: "", startLine: startLine ?? 1 },
    }));
    const params = new URLSearchParams({ path });
    if (full) params.set("full", "1");
    else if (startLine && startLine > 1) params.set("startLine", String(startLine));
    try {
      const response = await fetchJson<FileContentResult>(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/files/content?${params}`,
        copy,
      );
      setContents((current) => ({
        ...current,
        [path]: { ...response, loading: false, error: "", startLine: startLine ?? 1 },
      }));
      setSourceKind((current) => response.source ?? current);
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
    if (!isImagePath(path) && !contents[path]) void loadContent(path, 1, true);
  }, [contents, loadContent]);

  const closeFile = useCallback((path: string) => {
    setOpenFiles((current) => {
      const next = current.filter((item) => item !== path);
      setActiveFile((active) => (active === path ? next.at(-1) ?? "" : active));
      return next;
    });
  }, []);

  function handleSplitChanged(layout: Layout, meta: { requestedLayout?: Layout }) {
    saveFileSplitLayout(meta.requestedLayout ?? layout);
  }

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

  const withIcons = (nodes: readonly FileTreeNode[]): TreeDataNode[] => nodes.map((node) => ({
    ...node,
    title: (
      <span className="conversation-file-title">
        {renderFileIcon(node.title, node.type, expandedKeys.includes(node.path))}
        <span>{node.title}</span>
      </span>
    ),
    ...(node.children ? { children: withIcons(node.children as FileTreeNode[]) } : {}),
  }));
  const renderedTree: TreeDataNode[] = withIcons(filteredTree);

  const active = activeFile ? contents[activeFile] : undefined;
  const imageSrc = useMemo(() => activeFile && isImagePath(activeFile)
    ? `/api/ops/conversations/${encodeURIComponent(conversationId)}/files/image?${new URLSearchParams({ path: activeFile })}`
    : "", [activeFile, conversationId]);

  return (
    <div className="conversation-file-explorer">
      <Group
        id="conversation-file-split"
        className="conversation-file-group"
        orientation="vertical"
        defaultLayout={savedSplit ?? { tree: 42, editor: 58 }}
        onLayoutChanged={handleSplitChanged}
      >
        <Panel id="tree" className="conversation-file-tree-panel" minSize={100} maxSize="65%" defaultSize={200}>
          <div className="conversation-file-tree-wrap">
            <div className="conversation-file-toolbar">
              <Input
                size="small"
                allowClear
                value={search}
                placeholder={copy.filePanelSearch}
                onChange={(event) => setSearch(event.target.value)}
              />
              {sourceKind ? (
                <div className="conversation-file-source">
                  <span className={`conversation-file-source-dot is-${sourceKind}`} aria-hidden="true" />
                  {copy.filePanelSourceTemplate.replace(
                    "{value}",
                    sourceKind === "local" ? copy.filePanelSourceLocal : copy.filePanelSourceGitlab,
                  )}
                </div>
              ) : null}
            </div>
            {treeError ? <Typography.Text type="danger" className="conversation-file-error">{treeError}</Typography.Text> : null}
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
          </div>
        </Panel>
        <Separator id="separator-file-tree-editor" className="conversation-file-separator" />
        <Panel id="editor" className="conversation-file-editor-panel" minSize={120} defaultSize={260}>
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
              <div className={`conversation-file-content${active && !imageSrc && !active.loading && !active.error ? " is-code" : ""}`}>
                {active?.loading ? <Spin size="small" /> : active?.error ? (
                  <Typography.Text type="danger">{active.error}</Typography.Text>
                ) : imageSrc ? (
                  <ImagePreview src={imageSrc} alt={activeFile} copy={copy} />
                ) : active ? (
                  <Suspense fallback={<Spin size="small" />}>
                    <CodeViewer
                      path={activeFile}
                      value={active.content}
                      readOnlyMessage={copy.filePanelReadOnlyMessage}
                    />
                  </Suspense>
                ) : null}
              </div>
            </>
          ) : (
            <Typography.Text type="secondary" className="conversation-file-empty">{copy.filePanelEmpty}</Typography.Text>
          )}
          </div>
        </Panel>
      </Group>
    </div>
  );
}
