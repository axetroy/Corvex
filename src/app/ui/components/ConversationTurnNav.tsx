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

/** 聊天区右侧的轮次快捷导航：悬停看摘要，点击跳到用户该轮提问。 */
export function ConversationTurnNav({ items, activeId, copy, locale, onSelect }: Props) {
  if (items.length === 0) return null;
  return (
    <nav className="conversation-turn-nav" aria-label={copy.conversationTurnNavLabel}>
      <div className="conversation-turn-nav-label">{copy.conversationTurnNavLabel}</div>
      <div className="conversation-turn-nav-list">
        {items.map((item) => (
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
              className={`conversation-turn-nav-dot${activeId === item.id ? " is-active" : ""}`}
              aria-label={copy.conversationTurnNavSummaryTemplate
                .replace("{index}", String(item.index))
                .replace("{summary}", item.summary)}
              aria-current={activeId === item.id ? "step" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span>{item.index}</span>
            </button>
          </Tooltip>
        ))}
      </div>
    </nav>
  );
}
