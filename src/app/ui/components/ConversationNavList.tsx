import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Modal, Typography } from "antd";
import { Conversations } from "@ant-design/x";
import type { ConversationItemType } from "@ant-design/x";
import { fetchJson, handleUnauthorized } from "../api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy, Locale } from "../i18n.js";
import type { ConversationPage, ConversationSummary } from "../types.js";
import { Empty, ErrorBanner } from "./common.js";

/** 列表每页条数与分组收起状态的存储键。 */
const conversationPageSize = 50;
const collapsedGroupsKey = "corvex-ops-conversation-collapsed-groups";
const conversationGroupColors = ["#4f8ef7", "#27a37a", "#b977e0", "#e0923a", "#e46a6a", "#38a8b8"];

function readCollapsedGroups(): Set<string> {
  try {
    const saved = window.localStorage.getItem(collapsedGroupsKey);
    if (saved) return new Set(JSON.parse(saved) as string[]);
  } catch (error) {
    window.console.warn("read conversation group preference failed", error);
  }
  return new Set();
}

function saveCollapsedGroups(collapsed: Set<string>): void {
  try {
    window.localStorage.setItem(collapsedGroupsKey, JSON.stringify([...collapsed]));
  } catch (error) {
    window.console.warn("save conversation group preference failed", error);
  }
}

/** 按仓库 ID 取稳定分组色，让相邻仓库在视觉上立刻能区分。 */
function conversationGroupColor(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return conversationGroupColors[hash % conversationGroupColors.length]!;
}

interface Props {
  conversationId: string;
  copy: Copy;
  locale: Locale;
  refreshToken: number;
  onConversationChange: (conversationId: string) => void;
  onRefresh: () => void;
}

/**
 * 左侧导航里的会话列表：会话是侧栏的主对象，选中即切换路由。
 * 列表数据、归档与删除都在这里自持，右侧工作区只负责当前会话的内容。
 */
export function ConversationNavList({ conversationId, copy, refreshToken, onConversationChange, onRefresh }: Props) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(readCollapsedGroups);
  const [error, setError] = useState("");
  const [modal, modalContextHolder] = Modal.useModal();
  /** 加载更多时记住视口顶部的会话，新页到达后滚回同一条，避免列表跳动。 */
  const listRef = useRef<HTMLDivElement>(null);
  const scrollAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchJson<ConversationPage>(
      `/api/ops/conversations?limit=${conversationPageSize}&offset=${offset}&archived=${showArchived}`,
      copy,
    )
      .then((page) => {
        if (!active) return;
        setConversations((current) => {
          if (offset === 0) return page.items;
          const byId = new Map(current.map((item) => [item.id, item]));
          for (const item of page.items) byId.set(item.id, item);
          return [...byId.values()];
        });
        setTotal(page.total);
      })
      .catch((cause: unknown) => active && setError(errorMessage(cause)));
    return () => { active = false; };
  }, [copy, offset, refreshToken, showArchived]);

  // 新页合并后把锚点会话滚回顶部，让「加载更多」不改变用户正在看的位置。
  useEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    scrollAnchorRef.current = null;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current?.querySelector<HTMLElement>(".ant-conversations");
      const item = list?.querySelector<HTMLElement>(`[data-conversation-id="${CSS.escape(anchor)}"]`);
      if (list && item) list.scrollTop += item.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    return () => cancelAnimationFrame(frame);
  }, [conversations]);

  const sorted = useMemo(
    () => [...conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [conversations],
  );
  const projectNames = new Map<string, string>();
  const items: ConversationItemType[] = sorted.map((item) => {
    const group = `${item.projectId}`;
    projectNames.set(group, item.projectName);
    const running = item.lastTurnStatus === "queued" || item.lastTurnStatus === "running";
    return {
      key: item.id,
      group,
      label: (
        <Dropdown
          trigger={["contextMenu"]}
          menu={{
            items: [
              { key: "archive", label: item.archived ? copy.conversationMenuUnarchive : copy.conversationMenuArchive },
              { key: "delete", label: copy.conversationMenuDelete, danger: true },
            ],
            onClick: ({ key }) => {
              if (key === "archive") void changeArchived(item, !item.archived);
              else confirmDelete(item);
            },
          }}
        >
          <div
            className={`conversation-summary-label${item.archived ? " is-archived" : ""}`}
            data-conversation-id={item.id}
            title={item.title || item.projectName}
          >
            <Typography.Text ellipsis>{item.title || item.projectName}</Typography.Text>
            {running ? <span className="conversation-summary-active" aria-label={copy.statuses.running} /> : null}
          </div>
        </Dropdown>
      ),
    };
  });
  const groupKeys = [...new Set(items.map((item) => item.group!))];
  const expandedGroups = groupKeys.filter((group) => !collapsedGroups.has(group));

  async function changeArchived(item: ConversationSummary, archived: boolean) {
    setError("");
    try {
      const result = await fetch(`/api/ops/conversations/${encodeURIComponent(item.id)}/archive`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ archived }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (result.status === 401) {
        handleUnauthorized(result, await result.clone().text());
        throw new Error(copy.authRequired);
      }
      if (!result.ok) {
        throw new Error(copy.requestFailedTemplate
          .replace("{status}", String(result.status))
          .replace("{message}", (await result.text()).trim() || result.statusText));
      }
      setOffset(0);
      onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function confirmDelete(item: ConversationSummary) {
    modal.confirm({
      title: copy.conversationDeleteConfirm,
      content: copy.conversationDeleteConfirmDescription,
      okType: "danger",
      onOk: async () => {
        setError("");
        try {
          const result = await fetch(`/api/ops/conversations/${encodeURIComponent(item.id)}`, {
            method: "DELETE",
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(20_000),
          });
          if (result.status === 401) {
            handleUnauthorized(result, await result.clone().text());
            throw new Error(copy.authRequired);
          }
          if (!result.ok) {
            throw new Error(copy.requestFailedTemplate
              .replace("{status}", String(result.status))
              .replace("{message}", (await result.text()).trim() || result.statusText));
          }
          if (conversationId === item.id) onConversationChange("");
          onRefresh();
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  return (
    <aside className="conversation-sidebar" aria-label={copy.conversationList}>
      {modalContextHolder}
      {error ? <ErrorBanner message={error} /> : null}
      <div className="conversation-sidebar-heading">
        <Button className="conversation-new-button" type="primary" onClick={() => onConversationChange("")}>
          <span aria-hidden="true">+</span>
          {copy.newConversation}
        </Button>
        <Button
          className={`conversation-archived-toggle${showArchived ? " is-active" : ""}`}
          type="text"
          size="small"
          aria-pressed={showArchived}
          onClick={() => {
            setShowArchived((value) => !value);
            setOffset(0);
          }}
        >
          {showArchived ? copy.conversationShowActive : copy.conversationShowArchived}
        </Button>
      </div>
      <div className="conversation-sidebar-list" ref={listRef}>
        {items.length ? (
          <Conversations
            items={items}
            activeKey={conversationId || undefined}
            onActiveChange={(key) => { if (key) onConversationChange(key); }}
            groupable={{
              label: (group) => {
                const projectName = projectNames.get(String(group)) ?? String(group);
                return (
                  <span className="conversation-group-label" title={projectName}>
                    <span
                      className="conversation-group-dot"
                      style={{ backgroundColor: conversationGroupColor(String(group)) }}
                      aria-hidden="true"
                    />
                    <span className="conversation-group-name">{projectName}</span>
                  </span>
                );
              },
              collapsible: true,
              expandedKeys: expandedGroups,
              onExpand: (keys) => {
                const collapsed = new Set(groupKeys.filter((group) => !keys.includes(group)));
                setCollapsedGroups(collapsed);
                saveCollapsedGroups(collapsed);
              },
            }}
          />
        ) : <Empty>{copy.noConversations}</Empty>}
        {conversations.length < total ? (
          <Button
            className="conversation-load-more"
            type="text"
            onClick={() => {
              // 取当前视口顶部第一条会话作为锚点；加载完成后由 effect 滚回它。
              const list = listRef.current?.querySelector<HTMLElement>(".ant-conversations");
              const top = list?.getBoundingClientRect().top ?? 0;
              const first = [...(list?.querySelectorAll<HTMLElement>("[data-conversation-id]") ?? [])]
                .find((node) => node.getBoundingClientRect().top >= top - 2);
              scrollAnchorRef.current = first?.dataset.conversationId ?? null;
              setOffset((value) => value + conversationPageSize);
            }}
          >
            {copy.loadMore}
          </Button>
        ) : null}
      </div>
    </aside>
  );
}
