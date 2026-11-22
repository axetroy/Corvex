import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "antd";
import type { Copy, Locale } from "../i18n.js";
import { formatDate } from "../format.js";

export interface TurnNavItem {
  id: string;
  index: number;
  summary: string;
  createdAt: string;
}

interface Props {
  items: readonly TurnNavItem[];
  activeId: string;
  copy: Copy;
  locale: Locale;
  onSelect: (id: string) => void;
}

/** 一次最多显示多少轮，其余通过滚轮翻页。 */
const visibleTurnLimit = 10;

/** 聊天区右侧的轮次快捷导航：悬停看摘要，点击跳到用户该轮提问，滚轮翻看更早/更新的轮次。 */
export function ConversationTurnNav({ items, activeId, copy, locale, onSelect }: Props) {
  const navRef = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState(0);

  // 新对话或轮次数量变化时回到最新一页。
  useEffect(() => {
    setOffset(0);
  }, [items.length === 0 ? "empty" : items[0]?.id]);

  // 以 Bubble.List 的滚动内容元素为基准：往右偏 20px，垂直居中于可见聊天区。
  useLayoutEffect(() => {
    const nav = navRef.current;
    const chat = nav?.parentElement;
    if (!nav || !chat) return;
    const place = () => {
      const content = chat.querySelector<HTMLElement>(".ant-bubble-list .ant-bubble-list-scroll-content");
      if (!content) return;
      const chatRect = chat.getBoundingClientRect();
      const contentRect = content.getBoundingClientRect();
      const maxLeft = Math.max(0, chatRect.width - nav.offsetWidth - 4);
      nav.style.left = `${Math.min(contentRect.right - chatRect.left + 20, maxLeft)}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(chat);
    chat.querySelectorAll(".ant-bubble-list, .ant-bubble-list .ant-bubble-list-scroll-content").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [items.length]);

  // 原生非 passive 监听，滚轮才能阻止页面滚动并切换轮次窗口。
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || items.length <= visibleTurnLimit) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const maxOffset = items.length - visibleTurnLimit;
      setOffset((current) => Math.max(0, Math.min(maxOffset, current + Math.sign(event.deltaY))));
    };
    nav.addEventListener("wheel", onWheel, { passive: false });
    return () => nav.removeEventListener("wheel", onWheel);
  }, [items.length]);

  if (items.length === 0) return null;
  const end = items.length - offset;
  const start = Math.max(0, end - visibleTurnLimit);
  const visibleItems = items.slice(start, end);
  const olderHidden = start;
  const newerHidden = items.length - end;

  return (
    <nav ref={navRef} className="conversation-turn-nav" aria-label={copy.conversationTurnNavLabel}>
      <div className="conversation-turn-nav-label">{copy.conversationTurnNavLabel}</div>
      <div className="conversation-turn-nav-list">
        {olderHidden > 0 ? (
          <Tooltip placement="left" title={copy.conversationTurnNavMore.replace("{count}", String(olderHidden))}>
            <span className="conversation-turn-nav-more" aria-label={copy.conversationTurnNavMore.replace("{count}", String(olderHidden))}>⋯</span>
          </Tooltip>
        ) : null}
        {visibleItems.map((item) => (
          <Tooltip
            key={item.id}
            placement="left"
            title={
              <div className="conversation-turn-nav-tooltip">
                <strong>{copy.conversationTurnNavSummaryTemplate
                  .replace("{index}", String(item.index))
                  .replace("{summary}", item.summary)}</strong>
                <span>{formatDate(item.createdAt, copy, locale)}</span>
              </div>
            }
          >
            <button
              type="button"
              className={`conversation-turn-nav-bar${activeId === item.id ? " is-active" : ""}`}
              aria-label={copy.conversationTurnNavSummaryTemplate
                .replace("{index}", String(item.index))
                .replace("{summary}", item.summary)}
              aria-current={activeId === item.id ? "step" : undefined}
              onClick={() => onSelect(item.id)}
            />
          </Tooltip>
        ))}
        {newerHidden > 0 ? (
          <Tooltip placement="left" title={copy.conversationTurnNavNewer.replace("{count}", String(newerHidden))}>
            <span className="conversation-turn-nav-more" aria-label={copy.conversationTurnNavNewer.replace("{count}", String(newerHidden))}>⋯</span>
          </Tooltip>
        ) : null}
      </div>
    </nav>
  );
}
