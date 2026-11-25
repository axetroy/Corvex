import { Button, Tabs } from "antd";
import type { Copy } from "../lib/i18n.js";
import { ConversationFileExplorer } from "./ConversationFileExplorer.js";

interface Props {
  conversationId: string;
  copy: Copy;
  onClose: () => void;
}

/**
 * 会话侧栏容器：用 Tabs 组织可插拔的能力。
 * 当前只有文件浏览，后续新增面板只需往 tabItems 里追加一项。
 */
export function ConversationFilePanel({ conversationId, copy, onClose }: Props) {
  const tabItems = [
    {
      key: "files",
      label: copy.filePanelTitle,
      children: <ConversationFileExplorer conversationId={conversationId} copy={copy} />,
    },
  ];

  return (
    <div className="conversation-file-panel">
      <Tabs
        className="conversation-file-panel-tabs"
        size="small"
        activeKey="files"
        items={tabItems}
        tabBarExtraContent={{
          right: (
            <Button
              className="conversation-file-panel-close"
              type="text"
              size="small"
              aria-label={copy.filePanelClose}
              title={copy.filePanelClose}
              onClick={onClose}
            >
              ×
            </Button>
          ),
        }}
      />
    </div>
  );
}
