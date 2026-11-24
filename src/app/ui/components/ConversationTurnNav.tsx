import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Tooltip } from "antd";
import type { Copy, Locale } from "../i18n.js";
import { formatDate } from "../format.js";
import { createTurnWheelState, shouldStepTurnWheel, turnWheelStep } from "../turnWheel.js";

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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 聊天区右侧的轮次快捷导航：悬停看摘要，点击跳到用户该轮提问，滚轮逐轮跳转。 */
export function ConversationTurnNav({ items, activeId, copy, locale, onSelect }: Props) {
  const navRef = useRef<HTMLElement>(null);
  const cursorRef = useRef(0);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [cursor, setCursor] = useState(0);

  // 切换对话或轮次数量变化时定位到最新一轮。
  useEffect(() => {
    const last = Math.max(0, items.length - 1);
    cursorRef.current = last;
    setCursor(last);
  }, [items.length === 0 ? "empty" : items[0]?.id]);

  // 聊天区滚动带来的高亮变化同步到导航光标（不再触发跳转，避免循环）。
  useEffect(() => {
    const index = items.findIndex((item) => item.id === activeId);
    if (index >= 0 && index !== cursorRef.current) {
      cursorRef.current = index;
      setCursor(index);
    }
  }, [activeId, items]);

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

  // 原生非 passive 监听：滚轮逐轮跳转并把聊天区滚到对应提问。
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || items.length === 0) return;
    const wheelState = createTurnWheelState();
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const step = turnWheelStep(event.deltaY);
      if (step === 0) return;
      const next = clamp(cursorRef.current + step, 0, items.length - 1);
      // 已到两端时不消费节流状态，反向滚动可以立即响应。
      if (next === cursorRef.current) return;
      // 触控板连续手势只跳一步，鼠标滚轮刻度仍可快速逐轮跳转。
      if (!shouldStepTurnWheel(wheelState, event.timeStamp, event.deltaY)) return;
      cursorRef.current = next;
      setCursor(next);
      const target = items[next];
      if (target) onSelectRef.current(target.id);
    };
    nav.addEventListener("wheel", onWheel, { passive: false });
    return () => nav.removeEventListener("wheel", onWheel);
  }, [items]);

  if (items.length === 0) return null;
  const visibleItems = items;

  return (
    <nav ref={navRef} className="conversation-turn-nav" aria-label={copy.conversationTurnNavLabel}>
      <div className="conversation-turn-nav-label">{copy.conversationTurnNavLabel}</div>
      <div className="conversation-turn-nav-list">
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
              className={`conversation-turn-nav-bar${items[cursor]?.id === item.id ? " is-active" : ""}`}
              aria-label={copy.conversationTurnNavSummaryTemplate
                .replace("{index}", String(item.index))
                .replace("{summary}", item.summary)}
              aria-current={items[cursor]?.id === item.id ? "step" : undefined}
              onClick={() => {
                const index = items.findIndex((entry) => entry.id === item.id);
                if (index >= 0) {
                  cursorRef.current = index;
                  setCursor(index);
                }
                onSelect(item.id);
              }}
            />
          </Tooltip>
        ))}
      </div>
    </nav>
  );
}
