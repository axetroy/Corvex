import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Dropdown, Input, Modal, Spin, Tree, Typography } from "antd";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { Layout } from "react-resizable-panels";
import type { TreeDataNode } from "antd";
import { fetchJson, handleUnauthorized } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import type { FileContentResult, FileListResult } from "../../files/source.js";
import { isImagePath } from "../../files/image.js";
import { entriesToTreeNodes, mergeTreeChildren, pathSegments } from "../lib/fileTree.js";
import type { FileTreeNode } from "../lib/fileTree.js";
import { FileIcon } from "./icons.js";
import { ImagePreview } from "./ImagePreview.js";
import { renderFileIcon } from "../lib/fileIcons.js";

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
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [contents, setContents] = useState<Record<string, CachedContent>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileTreeNode } | null>(null);
  // 确认弹窗要拿到 ConfigProvider 的主题与 CSP nonce，不能用静态 Modal.confirm。
  const [modal, modalContextHolder] = Modal.useModal();

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
      setTreeError(
        message.includes("worktree is not available") ? copy.filePanelNoWorktree :
          message.includes("no pinned commit") ? copy.filePanelNoPinnedCommit : message,
      );
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

  const copyText = useCallback(async (value: string, failure: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch (cause) {
      setTreeError(failure || errorMessage(cause));
    }
  }, []);

  const deleteNode = useCallback(async (node: FileTreeNode) => {
    const affected = (path: string) => path === node.path || path.startsWith(`${node.path}/`);
    try {
      const query = new URLSearchParams({ path: node.path });
      const response = await fetch(
        `/api/ops/conversations/${encodeURIComponent(conversationId)}/files?${query}`,
        { method: "DELETE", cache: "no-store" },
      );
      if (response.status === 401) {
        handleUnauthorized(response, await response.clone().text());
        throw new Error(copy.authRequired);
      }
      if (!response.ok) throw new Error((await response.text()).trim() || response.statusText);
      setOpenFiles((current) => current.filter((path) => !affected(path)));
      setActiveFile((current) => (affected(current) ? "" : current));
      setContents((current) => Object.fromEntries(Object.entries(current).filter(([path]) => !affected(path))));
      const parent = node.path.split("/").slice(0, -1).join("/");
      await loadDirectory(parent);
      setTreeError("");
    } catch (cause) {
      setTreeError(errorMessage(cause));
    }
  }, [conversationId, loadDirectory]);

  const confirmDelete = useCallback((node: FileTreeNode) => {
    modal.confirm({
      title: copy.fileMenuDelete,
      content: copy.fileDeleteConfirmTemplate.replace("{path}", node.path),
      okText: copy.fileMenuDelete,
      okButtonProps: { danger: true },
      cancelText: copy.fileMenuCancel,
      onOk: () => deleteNode(node),
    });
  }, [modal, copy, deleteNode]);

  // 受控 Dropdown 没有 trigger，点外部不会自动关闭，这里显式补上。
  useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest(".conversation-file-context-menu") || target.closest(".conversation-file-context-anchor")) return;
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

  const fileMenuItems = (node: FileTreeNode) => [
    {
      key: "open",
      label: node.isLeaf ? copy.fileMenuOpen : copy.fileMenuExpand,
      onClick: () => {
        if (node.isLeaf) openFile(node.path);
        else setExpandedKeys((keys) => keys.includes(node.path) ? keys.filter((key) => key !== node.path) : [...keys, node.path]);
      },
    },
    { key: "copyPath", label: copy.fileMenuCopyPath, onClick: () => void copyText(node.path, copy.fileCopyFailed) },
    { key: "copyName", label: copy.fileMenuCopyName, onClick: () => void copyText(node.title, copy.fileCopyFailed) },
    { type: "divider" as const },
    { key: "delete", label: copy.fileMenuDelete, danger: true, onClick: () => confirmDelete(node) },
  ];

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

  const findNode = (nodes: readonly FileTreeNode[], path: string): FileTreeNode | undefined => {
    for (const node of nodes) {
      if (node.path === path) return node;
      const child = node.children ? findNode(node.children as FileTreeNode[], path) : undefined;
      if (child) return child;
    }
    return undefined;
  };

  const withIcons = (nodes: readonly FileTreeNode[]): TreeDataNode[] => nodes.map((node) => ({
    ...node,
    title: (
      <span
        className={`conversation-file-title${contextMenu?.node.path === node.path ? " is-context-target" : ""}`}
        data-node-path={node.path}
      >
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
      {modalContextHolder}
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
            </div>
            {treeError ? <Typography.Text type="danger" className="conversation-file-error">{treeError}</Typography.Text> : null}
            <div
              className="conversation-file-tree"
              onContextMenu={(event) => {
                // rc-tree 只给内容区绑了右键事件；这里在容器上代理整行（含展开箭头与空白）。
                const row = (event.target as HTMLElement).closest(".ant-tree-treenode");
                const path = row?.querySelector<HTMLElement>("[data-node-path]")?.dataset.nodePath;
                if (!path) return;
                event.preventDefault();
                const node = findNode(filteredTree, path);
                if (node) setContextMenu({ x: event.clientX, y: event.clientY, node });
              }}
            >
              {loadingRoot ? <Spin size="small" /> : renderedTree.length ? (
                <Tree
                  blockNode
                  treeData={renderedTree}
                  expandedKeys={expandedKeys}
                  onExpand={(keys) => setExpandedKeys(keys.map(String))}
                  onRightClick={({ event, node }) => {
                    setContextMenu({ x: event.clientX, y: event.clientY, node: node as unknown as FileTreeNode });
                  }}
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
      {contextMenu ? (
        <Dropdown
          open
          trigger={[]}
          placement="bottomLeft"
          menu={{ items: fileMenuItems(contextMenu.node), onClick: () => setContextMenu(null) }}
          onOpenChange={(open) => { if (!open) setContextMenu(null); }}
          classNames={{ root: "conversation-file-context-menu" }}
        >
          <span
            className="conversation-file-context-anchor"
            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, width: 1, height: 1 }}
          />
        </Dropdown>
      ) : null}
    </div>
  );
}
