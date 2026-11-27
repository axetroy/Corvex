import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("sidebar CSS is loaded with the app shell", () => {
  it("keeps conversation-list styles in the eagerly imported component CSS", () => {
    const component = read("src/app/ui/components/ConversationNavList.tsx");
    const sidebarCss = read("src/app/ui/components/ConversationNavList.css");
    const pageCss = read("src/app/ui/pages/ConversationsPage.css");

    // 侧栏由 App 外壳渲染，而 ConversationsPage 是 lazy() 加载的；
    // 样式必须随组件进入首屏 chunk，否则首屏侧栏无样式。
    expect(component).toContain('import "./ConversationNavList.css"');
    expect(sidebarCss).toContain(".conversation-summary-label");
    expect(sidebarCss).toContain(".conversation-sidebar");
    expect(pageCss).not.toContain(".conversation-summary-label");
    expect(pageCss).not.toContain(".conversation-new-button");
  });
});
