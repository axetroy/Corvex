import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider, Dropdown, Menu } from "antd";
import enUSLocale from "antd/locale/en_US";
import zhCNLocale from "antd/locale/zh_CN";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Loading } from "./components/common.js";
import { SetupPage } from "./components/SetupPage.js";
import {
  ConversationsIcon,
  EventsIcon,
  LanguageIcon,
  LogoutIcon,
  OverviewIcon,
  SettingsIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
} from "./components/icons.js";
import { fetchJson } from "./api.js";
import { formatDate } from "./format.js";
import { en, resolveLocale, zhCN } from "./i18n.js";
import type { Locale } from "./i18n.js";
import { eventQueueFromParams, eventsBackHash, eventsHash, parseHash, conversationsHash } from "./routing.js";
import type { EventQueue } from "./types.js";

// 各路由页面按需加载，让首屏只包含概览与外壳，其余页面在导航时再取用。
const OverviewPage = lazy(() => import("./components/OverviewPage.js").then((module) => ({ default: module.OverviewPage })));
const EventsPage = lazy(() => import("./components/EventsPage.js").then((module) => ({ default: module.EventsPage })));
const EventDetailPage = lazy(() => import("./components/EventDetailPage.js").then((module) => ({ default: module.EventDetailPage })));
const ConversationsPage = lazy(() => import("./components/ConversationsPage.js").then((module) => ({ default: module.ConversationsPage })));
const SettingsPage = lazy(() => import("./components/SettingsPage.js").then((module) => ({ default: module.SettingsPage })));

/** localStorage 中保存 Agent 控制台手动选择语言的键名。 */
const localePreferenceKey = "corvex-ops-locale";
/** localStorage 中保存侧边栏展开状态的键名。 */
const navigationPreferenceKey = "corvex-ops-navigation-collapsed";
/** 浏览器按偏好顺序提供的语言候选，用于首次访问时选择界面语言。 */
const browserLanguages = [...(window.navigator.languages ?? []), window.navigator.language ?? ""];
/** Agent 控制台自动刷新间隔（毫秒）。 */
const refreshIntervalMs = 15_000;
/** 非事件列表页使用的空查询参数，保持 `useMemo` 依赖稳定。 */
const emptyParams = new URLSearchParams();
/** Server 为当前 HTML 响应生成的 CSP nonce，供 Ant Design 样式标签使用。 */
const cspNonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;

/** 读取已保存的语言偏好；localStorage 不可用时回退为空。 */
function readSavedLocale(): string {
  try {
    return window.localStorage.getItem(localePreferenceKey) ?? "";
  } catch (error) {
    window.console.warn("read agent console language preference failed", error);
    return "";
  }
}

/** 保存语言偏好；隐私模式等场景下写入失败只记录告警。 */
function saveLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(localePreferenceKey, locale);
  } catch (error) {
    window.console.warn("save agent console language preference failed", error);
  }
}

/** 读取已保存的侧边栏收起状态；未保存时在窄视口下默认收起。 */
function readNavigationCollapsed(): boolean {
  try {
    const saved = window.localStorage.getItem(navigationPreferenceKey);
    if (saved !== null) return saved === "true";
  } catch (error) {
    window.console.warn("read agent console navigation preference failed", error);
  }
  return window.innerWidth < 700;
}

/** 保存侧边栏收起状态；写入失败只记录告警。 */
function saveNavigationCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(navigationPreferenceKey, String(collapsed));
  } catch (error) {
    window.console.warn("save agent console navigation preference failed", error);
  }
}

/** 当前地址栏 hash 对应的原始路由文本，默认回到对话页。 */
function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || "conversations");
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || "conversations");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** Agent 控制台根组件：可折叠侧边栏、语言切换、自动刷新与路由分发。 */
export function App() {
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(readSavedLocale(), browserLanguages));
  const copy = locale === "zh-CN" ? zhCN : en;
  const [navigationCollapsed, setNavigationCollapsed] = useState<boolean>(() => readNavigationCollapsed());
  const route = useHashRoute();
  // 页面与筛选条件都来自 hash，刷新或分享链接后视图保持不变。
  const { page, params } = useMemo(() => parseHash(route), [route]);
  const queue = useMemo(
    () => eventQueueFromParams(page.kind === "events" || page.kind === "event" ? params : emptyParams),
    [page.kind, params],
  );
  const [updated, setUpdated] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [account, setAccount] = useState<{ username: string; name: string; avatarUrl: string }>();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    fetchJson<{ username: string; name: string; avatarUrl: string }>("/api/auth/me", copy)
      .then((user) => active && setAccount(user))
      .catch(() => active && setAccount(undefined));
    return () => {
      active = false;
    };
  }, [copy]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = copy.documentTitle;
  }, [locale, copy]);

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshToken((value) => value + 1), refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, []);

  // 未知路由与非法事件 ID 统一回到对话页，避免停留在空白页。
  useEffect(() => {
    if (page.kind === "unknown") window.location.hash = "conversations";
  }, [page.kind]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const logout = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/ops";
  }, []);
  const handleUpdated = useCallback((value: string) => setUpdated(value), []);
  const updateQueue = useCallback((next: EventQueue) => {
    const target = eventsHash(next);
    // 条件未变化时 hash 不会触发 hashchange，改为直接刷新一次。
    if (window.location.hash === target) {
      setRefreshToken((value) => value + 1);
      return;
    }
    window.location.hash = target;
  }, []);
  const updateConversationRoute = useCallback((conversationId: string) => {
    const target = conversationsHash(conversationId);
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  const toggleNavigation = useCallback(() => {
    setNavigationCollapsed((value) => {
      saveNavigationCollapsed(!value);
      return !value;
    });
  }, []);

  const changeLocale = useCallback((value: string) => {
    const next = resolveLocale(value, browserLanguages);
    saveLocale(next);
    setLocale(next);
  }, []);

  const languageOptions = [{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }];
  const languageMenuItems = languageOptions.map((option) => ({ key: option.value, label: option.label }));
  const updatedText = updated ? copy.updatedTemplate.replace("{value}", formatDate(updated, copy, locale)) : "";

  const onEvents = page.kind === "events" || page.kind === "event";
  const theme = {
    token: { colorPrimary: "#1769aa", borderRadius: 6, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    components: { Menu: { collapsedWidth: 60, itemHeight: 40 } },
  };

  // 首次安装：把 OAuth 配置写进本地数据库，不需要任何环境变量。
  if (window.location.pathname === "/setup") {
    return (
      <ConfigProvider locale={locale === "zh-CN" ? zhCNLocale : enUSLocale} csp={cspNonce ? { nonce: cspNonce } : undefined} theme={theme}>
        <SetupPage copy={copy} />
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider
      locale={locale === "zh-CN" ? zhCNLocale : enUSLocale}
      csp={cspNonce ? { nonce: cspNonce } : undefined}
      theme={theme}
    >
      <div className="app-shell">
        <a
          className="skip-link"
          href="#app"
          onClick={(event) => {
            event.preventDefault();
            mainRef.current?.focus();
          }}
        >
          {copy.skipToContent}
        </a>
        <aside className={`sidebar${navigationCollapsed ? " sidebar-collapsed" : ""}`} aria-label={copy.navLabel}>
          <div className="sidebar-head">
            <a className="brand" href="#conversations" aria-label={copy.brandLabel}>
              <span className="brand-mark">C</span>
              <span className="brand-name">
                Corvex <small>GITLAB AGENT</small>
              </span>
            </a>
            <Dropdown
              placement="bottomRight"
              trigger={["click"]}
              menu={{
                selectedKeys: [locale],
                items: languageMenuItems,
                onClick: ({ key }) => changeLocale(key),
              }}
            >
              <button type="button" className="sidebar-language" aria-label={copy.languageLabel} title={copy.languageLabel}>
                <LanguageIcon />
              </button>
            </Dropdown>
            <button
              type="button"
              className="sidebar-toggle"
              onClick={toggleNavigation}
              aria-label={copy.toggleNavigation}
              aria-expanded={!navigationCollapsed}
              title={copy.toggleNavigation}
            >
              {navigationCollapsed ? <SidebarExpandIcon /> : <SidebarCollapseIcon />}
            </button>
          </div>
          <Menu
            className="sidebar-nav"
            mode="inline"
            inlineCollapsed={navigationCollapsed}
            selectedKeys={[page.kind === "overview" ? "overview" : onEvents ? "events" : page.kind === "settings" ? "settings" : "conversations"]}
            onClick={({ key }) => {
              window.location.hash = key === "events"
                ? eventsHash(queue)
                : key === "conversations" && page.kind === "conversations"
                  ? conversationsHash(page.id)
                  : key;
            }}
            items={[
              { key: "conversations", icon: <ConversationsIcon />, label: copy.navConversations },
              { key: "events", icon: <EventsIcon />, label: copy.navEvents },
              { key: "overview", icon: <OverviewIcon />, label: copy.navOverview },
              { key: "settings", icon: <SettingsIcon />, label: copy.navSettings },
            ]}
          />
          {account ? (
            <div className="sidebar-account-panel">
              {account.avatarUrl ? (
                <img className="sidebar-account-avatar" src={account.avatarUrl} alt="" />
              ) : (
                <span className="sidebar-account-avatar sidebar-account-avatar-fallback" aria-hidden="true">
                  {[...account.username][0]?.toUpperCase() ?? "?"}
                </span>
              )}
              <span className="sidebar-account-text">
                <span className="sidebar-account-name">{account.name || account.username}</span>
                <span className="sidebar-account-username">@{account.username}</span>
              </span>
              <button
                type="button"
                className="sidebar-logout"
                onClick={() => void logout()}
                aria-label={copy.logout}
                title={copy.logout}
              >
                <LogoutIcon />
              </button>
            </div>
          ) : null}
        </aside>
        {updatedText ? <span id="updated" className="updated">{updatedText}</span> : null}
        <main id="app" className={`content${page.kind === "conversations" ? " content-full" : ""}`} ref={mainRef} tabIndex={-1}>
          <ErrorBoundary key={page.kind === "conversations" ? "conversations" : route} copy={copy}>
            <Suspense fallback={<Loading>{copy.loading}</Loading>}>
            {page.kind === "overview" ? (
              <OverviewPage
                copy={copy}
                locale={locale}
                refreshToken={refreshToken}
                onUpdated={handleUpdated}
                onRefresh={refresh}
              />
            ) : null}
            {page.kind === "events" ? (
              <EventsPage
                copy={copy}
                locale={locale}
                queue={queue}
                refreshToken={refreshToken}
                onQueueChange={updateQueue}
                onUpdated={handleUpdated}
                onRefresh={refresh}
              />
            ) : null}
            {page.kind === "event" ? (
              <EventDetailPage
                eventId={page.id}
                backHash={eventsBackHash(params)}
                copy={copy}
                locale={locale}
                refreshToken={refreshToken}
                onUpdated={handleUpdated}
                onRefresh={refresh}
              />
            ) : null}
            {page.kind === "conversations" ? (
              <ConversationsPage
                conversationId={page.id ?? ""}
                copy={copy}
                locale={locale}
                refreshToken={refreshToken}
                onUpdated={handleUpdated}
                onRefresh={refresh}
                onConversationChange={updateConversationRoute}
              />
            ) : null}
            {page.kind === "settings" ? (
              <SettingsPage
                copy={copy}
                locale={locale}
                onUpdated={handleUpdated}
                onRefresh={refresh}
              />
            ) : null}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </ConfigProvider>
  );
}
