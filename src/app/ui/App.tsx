import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { ConfigProvider, Dropdown, Menu } from "antd";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import enUSLocale from "antd/locale/en_US";
import zhCNLocale from "antd/locale/zh_CN";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Loading } from "./components/common.js";
import { LandingPage } from "./components/LandingPage.js";
import { AdminConsole } from "./components/AdminConsole.js";
import { SetupPage } from "./components/SetupPage.js";
import { UserAvatar } from "./components/UserAvatar.js";
import {
  ConversationsIcon,
  EventsIcon,
  LanguageIcon,
  LogoutIcon,
  SidebarCollapseIcon,
  SettingsIcon,
  SidebarExpandIcon,
} from "./components/icons.js";
import { fetchJson } from "./api.js";
import { formatDate } from "./format.js";
import { en, resolveLocale, zhCN } from "./i18n.js";
import type { Locale } from "./i18n.js";
import { eventQueueFromParams, eventsBackPath, eventsPath, conversationsPath } from "./routing.js";
import type { EventQueue } from "./types.js";

// 各路由页面按需加载，让首屏只包含概览与外壳，其余页面在导航时再取用。
const EventsPage = lazy(() => import("./components/EventsPage.js").then((module) => ({ default: module.EventsPage })));
const EventDetailPage = lazy(() => import("./components/EventDetailPage.js").then((module) => ({ default: module.EventDetailPage })));
const ConversationsPage = lazy(() => import("./components/ConversationsPage.js").then((module) => ({ default: module.ConversationsPage })));
const UserSettingsPage = lazy(() => import("./components/UserSettingsPage.js").then((module) => ({ default: module.UserSettingsPage })));

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

/** 页面种类，供侧栏选中态与主区域布局使用。 */
type PageKind = "conversations" | "events" | "event" | "settings" | "unknown";

function pageKindOf(pathname: string): PageKind {
  const path = pathname.replace(/^\/+/, "");
  if (path === "" || path === "conversations" || path.startsWith("conversations/")) return "conversations";
  if (path === "events") return "events";
  if (path.startsWith("events/")) return "event";
  if (path === "settings") return "settings";
  return "unknown";
}

/** 把 react-router 的路径参数交给仍以 props 接收 ID 的页面。 */
function EventRoute(props: Omit<ComponentProps<typeof EventDetailPage>, "eventId">) {
  const { id } = useParams();
  return <EventDetailPage {...props} eventId={id ?? ""} />;
}

function ConversationRoute(props: Omit<ComponentProps<typeof ConversationsPage>, "conversationId">) {
  const { id } = useParams();
  return <ConversationsPage {...props} conversationId={id ?? ""} />;
}

/** Agent 控制台根组件：可折叠侧边栏、语言切换、自动刷新与路由分发。 */
export function App() {
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(readSavedLocale(), browserLanguages));
  const copy = locale === "zh-CN" ? zhCN : en;
  const [navigationCollapsed, setNavigationCollapsed] = useState<boolean>(() => readNavigationCollapsed());
  const location = useLocation();
  const navigate = useNavigate();
  const route = location.pathname.replace(/^\/+/, "");
  const pageKind = pageKindOf(location.pathname);
  // 页面与筛选条件都来自地址栏，刷新或分享链接后视图保持不变。
  // 首次安装时把控制台重定向到 /setup；服务端只让 API 返回 setupRequired。
  useEffect(() => {
    if (!window.location.pathname.startsWith("/ops")) return;
    let active = true;
    fetch("/api/setup/status")
      .then((response) => response.json() as Promise<{ configured: boolean }>)
      .then((status) => {
        if (active && !status.configured && location.pathname !== "/setup") {
          navigate("/setup");
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [location.pathname, navigate]);

  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const queue = useMemo(
    () => eventQueueFromParams(pageKind === "events" || pageKind === "event" ? params : emptyParams),
    [pageKind, params],
  );
  const routeId = route.includes("/") ? decodeURIComponent(route.slice(route.indexOf("/") + 1)) : "";
  const [updated, setUpdated] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [account, setAccount] = useState<{ username: string; name: string; avatarUrl: string; isAdmin: boolean }>();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    fetchJson<{ username: string; name: string; avatarUrl: string; isAdmin: boolean }>("/api/auth/me", copy)
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

  // 未知路由与非法事件 ID 回到对话页，避免停留在空白页。
  useEffect(() => {
    if (pageKind === "unknown" && !route.startsWith("admin") && route !== "setup") navigate("/conversations", { replace: true });
  }, [pageKind, route, navigate]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const logout = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/";
  }, []);
  const handleUpdated = useCallback((value: string) => setUpdated(value), []);
  const updateQueue = useCallback((next: EventQueue) => {
    const target = eventsPath(next);
    // 条件未变化时地址不变，改为直接刷新一次。
    if (location.pathname + location.search === target) {
      setRefreshToken((value) => value + 1);
      return;
    }
    navigate(target);
  }, [location.pathname, location.search, navigate]);
  const updateConversationRoute = useCallback((conversationId: string) => {
    const target = conversationsPath(conversationId);
    if (location.pathname !== target) navigate(target);
  }, [location.pathname, navigate]);

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

  const onEvents = pageKind === "events" || pageKind === "event";
  const theme = {
    token: { colorPrimary: "#1769aa", borderRadius: 6, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    components: { Menu: { collapsedWidth: 60, itemHeight: 40 } },
  };

  // 公开首页是唯一的 pathname 路由；其余界面都在 /ops 下用 hash 路由。
  if (window.location.pathname === "/") {
    return (
      <ConfigProvider locale={locale === "zh-CN" ? zhCNLocale : enUSLocale} csp={cspNonce ? { nonce: cspNonce } : undefined} theme={theme}>
        <LandingPage copy={copy} locale={locale} onLocaleChange={changeLocale} />
      </ConfigProvider>
    );
  }

  // 管理页与安装向导都是 hash 路由，切换时不刷新页面。
  if (route.startsWith("admin")) {
    return (
      <ConfigProvider locale={locale === "zh-CN" ? zhCNLocale : enUSLocale} csp={cspNonce ? { nonce: cspNonce } : undefined} theme={theme}>
        <AdminConsole
          copy={copy}
          locale={locale}
          route={route}
          refreshToken={refreshToken}
          onUpdated={handleUpdated}
          onRefresh={refresh}
        />
      </ConfigProvider>
    );
  }

  if (route === "setup") {
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
            selectedKeys={[pageKind === "settings" ? "settings" : onEvents ? "events" : "conversations"]}
            onClick={({ key }) => {
              if (key === "events") navigate(eventsPath(queue));
              else if (key === "conversations" && pageKind === "conversations") navigate(conversationsPath(routeId));
              else navigate(key.startsWith("/") ? key : `/${key}`);
            }}
            items={[
              { key: "conversations", icon: <ConversationsIcon />, label: copy.navConversations },
              { key: "events", icon: <EventsIcon />, label: copy.navEvents },
              { key: "settings", icon: <SettingsIcon />, label: copy.navSettings },
            ]}
          />
          {account ? (
            <div className="sidebar-account-panel">
              <UserAvatar
                className="user-avatar"
                name={account.name}
                username={account.username}
                avatarUrl={account.avatarUrl}
              />
              <span className="sidebar-account-text">
                <span className="sidebar-account-name">{account.name || account.username}</span>
                <span className="sidebar-account-username">@{account.username}</span>
              </span>
              {account.isAdmin ? (
                <a className="sidebar-admin" href="/ops#/admin/users" target="_blank" rel="noopener" aria-label={copy.adminEntry} title={copy.adminEntry}>
                  {copy.adminTag}
                </a>
              ) : null}
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
        <main id="app" className={`content${pageKind === "conversations" ? " content-full" : ""}`} ref={mainRef} tabIndex={-1}>
          <ErrorBoundary key={pageKind === "conversations" ? "conversations" : route} copy={copy}>
            <Suspense fallback={<Loading>{copy.loading}</Loading>}>
              <Routes>
                <Route
                  path="/events"
                  element={
                    <EventsPage
                      copy={copy}
                      locale={locale}
                      queue={queue}
                      refreshToken={refreshToken}
                      onQueueChange={updateQueue}
                      onUpdated={handleUpdated}
                      onRefresh={refresh}
                    />
                  }
                />
                <Route
                  path="/events/:id"
                  element={
                    <EventRoute
                      copy={copy}
                      locale={locale}
                      refreshToken={refreshToken}
                      backHash={eventsBackPath(params)}
                      onUpdated={handleUpdated}
                      onRefresh={refresh}
                    />
                  }
                />
                <Route path="/settings" element={<UserSettingsPage copy={copy} onChanged={refresh} />} />
                <Route
                  path="/conversations"
                  element={
                    <ConversationsPage
                      conversationId=""
                      copy={copy}
                      locale={locale}
                      refreshToken={refreshToken}
                      onUpdated={handleUpdated}
                      onRefresh={refresh}
                      onConversationChange={updateConversationRoute}
                    />
                  }
                />
                <Route
                  path="/conversations/:id"
                  element={
                    <ConversationRoute
                      copy={copy}
                      locale={locale}
                      refreshToken={refreshToken}
                      onUpdated={handleUpdated}
                      onRefresh={refresh}
                      onConversationChange={updateConversationRoute}
                    />
                  }
                />
                <Route path="*" element={<Navigate to="/conversations" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </ConfigProvider>
  );
}
