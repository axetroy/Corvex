import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { ConfigProvider, Dropdown, Menu, theme as antdThemeApi } from "antd";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import enUSLocale from "antd/locale/en_US";
import zhCNLocale from "antd/locale/zh_CN";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { Loading } from "./components/common.js";
import { LandingPage } from "./components/LandingPage.js";
import { AdminConsole } from "./components/AdminConsole.js";
import { SetupPage } from "./components/SetupPage.js";
import { UserAvatar } from "./components/UserAvatar.js";
import { ThemeToggle } from "./components/ThemeToggle.js";
import {
  ConversationsIcon,
  LanguageIcon,
  LogoutIcon,
  SidebarCollapseIcon,
  SettingsIcon,
  SidebarExpandIcon,
} from "./components/icons.js";
import { fetchJson } from "./api.js";
import { formatDate } from "./format.js";
import { en, resolveLocale, resolveLocaleMode, zhCN } from "./i18n.js";
import type { LocaleMode } from "./i18n.js";
import { conversationsPath } from "./routing.js";
import { prefersDark, readThemeMode, resolveTheme, saveThemeMode, type ThemeMode } from "./theme.js";

// 各路由页面按需加载，让首屏只包含外壳，其余页面在导航时再取用。
const ConversationsPage = lazy(() => import("./components/ConversationsPage.js").then((module) => ({ default: module.ConversationsPage })));
const UserSettingsPage = lazy(() => import("./components/UserSettingsPage.js").then((module) => ({ default: module.UserSettingsPage })));

/** localStorage 中保存语言偏好的键名。 */
const localePreferenceKey = "corvex-ops-locale-mode";
/** 旧版本保存具体语言的键名，仅用于迁移已手动选过语言的用户。 */
const legacyLocalePreferenceKey = "corvex-ops-locale";
/** localStorage 中保存侧边栏展开状态的键名。 */
const navigationPreferenceKey = "corvex-ops-navigation-collapsed";
/** 读取浏览器按偏好顺序提供的语言候选。 */
function currentBrowserLanguages(): string[] {
  return [...(window.navigator.languages ?? []), window.navigator.language ?? ""];
}
/** Agent 控制台自动刷新间隔（毫秒）。 */
const refreshIntervalMs = 15_000;
/** Server 为当前 HTML 响应生成的 CSP nonce，供 Ant Design 样式标签使用。 */
const cspNonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;

/** 读取语言偏好；没有偏好时跟随系统，旧版本的具体语言视为手动选择。 */
function readLocaleMode(): LocaleMode {
  try {
    return resolveLocaleMode(
      window.localStorage.getItem(localePreferenceKey) ?? "",
      window.localStorage.getItem(legacyLocalePreferenceKey) ?? "",
    );
  } catch (error) {
    window.console.warn("read agent console language preference failed", error);
    return "system";
  }
}

/** 保存语言偏好；隐私模式等场景下写入失败只记录告警。 */
function saveLocaleMode(mode: LocaleMode): void {
  try {
    window.localStorage.setItem(localePreferenceKey, mode);
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
type PageKind = "conversations" | "settings" | "unknown";

function pageKindOf(pathname: string): PageKind {
  const path = pathname.replace(/^\/+/, "");
  if (path === "" || path === "conversations" || path.startsWith("conversations/")) return "conversations";
  if (path === "settings") return "settings";
  return "unknown";
}

function ConversationRoute(props: Omit<ComponentProps<typeof ConversationsPage>, "conversationId">) {
  const { id } = useParams();
  return <ConversationsPage {...props} conversationId={id ?? ""} />;
}

interface AuthStatus {
  authenticated: boolean;
  oauthConfigured: boolean;
  setupRequired: boolean;
}

/** Agent 控制台根组件：可折叠侧边栏、语言切换、自动刷新与路由分发。 */
export function App() {
  const [localeMode, setLocaleMode] = useState<LocaleMode>(readLocaleMode);
  const [browserLanguages, setBrowserLanguages] = useState<string[]>(currentBrowserLanguages);
  const locale = localeMode === "system" ? resolveLocale(browserLanguages) : localeMode;
  const copy = locale === "zh-CN" ? zhCN : en;
  // 路由守卫：受保护页面在确认登录状态前不渲染，避免闪一下工作台再跳登录。
  const [authStatus, setAuthStatus] = useState<AuthStatus>();
  const [navigationCollapsed, setNavigationCollapsed] = useState<boolean>(() => readNavigationCollapsed());
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);
  const resolvedTheme = resolveTheme(themeMode, systemDark);
  const location = useLocation();
  const navigate = useNavigate();
  const route = location.pathname.replace(/^\/+/, "");
  const pageKind = pageKindOf(location.pathname);
  useEffect(() => {
    if (!window.location.pathname.startsWith("/ops")) return;
    let active = true;
    fetch("/api/auth/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<AuthStatus>)
      .then((status) => { if (active) setAuthStatus(status); })
      .catch(() => {
        // 检查失败按「需要登录」处理，让跳转登录兜底，而不是渲染受保护界面。
        if (active) setAuthStatus({ authenticated: false, oauthConfigured: true, setupRequired: false });
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (authStatus && !authStatus.authenticated && !authStatus.setupRequired) {
      window.location.assign("/auth/gitlab");
    }
  }, [authStatus]);

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

  // 把实际主题写到 html 上，CSS 变量据此切换；跟随系统时实时响应浏览器设置变化。
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // 跟随系统时实时响应浏览器语言顺序变化。
  useEffect(() => {
    const update = () => setBrowserLanguages(currentBrowserLanguages());
    window.addEventListener("languagechange", update);
    return () => window.removeEventListener("languagechange", update);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshToken((value) => value + 1), refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, []);

  // 未知路由回到对话页，避免停留在空白页。
  useEffect(() => {
    if (pageKind === "unknown" && !route.startsWith("admin") && route !== "setup") navigate("/conversations", { replace: true });
  }, [pageKind, route, navigate]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const logout = useCallback(async () => {
    await fetch("/auth/logout", { method: "POST" });
    window.location.href = "/";
  }, []);
  const handleUpdated = useCallback((value: string) => setUpdated(value), []);
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
    const next = resolveLocaleMode(value, "");
    saveLocaleMode(next);
    setLocaleMode(next);
  }, []);

  const changeTheme = useCallback((value: ThemeMode) => {
    saveThemeMode(value);
    setThemeMode(value);
  }, []);

  const languageOptions = [
    { value: "system", label: copy.languageSystem },
    { value: "en", label: "English" },
    { value: "zh-CN", label: "简体中文" },
  ];
  const languageMenuItems = languageOptions.map((option) => ({ key: option.value, label: option.label }));
  const updatedText = updated ? copy.updatedTemplate.replace("{value}", formatDate(updated, copy, locale)) : "";

  const theme = useMemo(
    () => ({
      algorithm: resolvedTheme === "dark" ? antdThemeApi.darkAlgorithm : antdThemeApi.defaultAlgorithm,
      token: {
        colorPrimary: resolvedTheme === "dark" ? "#4a9fe0" : "#1769aa",
        borderRadius: 6,
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      },
      components: { Menu: { collapsedWidth: 60, itemHeight: 40 } },
    }),
    [resolvedTheme],
  );

  // 公开首页是唯一的 pathname 路由；其余界面都在 /ops 下用 hash 路由。
  if (window.location.pathname === "/") {
    return (
      <ConfigProvider locale={locale === "zh-CN" ? zhCNLocale : enUSLocale} csp={cspNonce ? { nonce: cspNonce } : undefined} theme={theme}>
        <LandingPage copy={copy} locale={locale} onLocaleChange={changeLocale} />
      </ConfigProvider>
    );
  }

  // 受保护页面：状态未知、需要登录或尚未完成安装时都不渲染工作台。
  if (!authStatus || (!authStatus.authenticated && (!authStatus.setupRequired || route !== "setup"))) {
    return (
      <ConfigProvider locale={locale === "zh-CN" ? zhCNLocale : enUSLocale} csp={cspNonce ? { nonce: cspNonce } : undefined} theme={theme}>
        <div style={{ display: "grid", minHeight: "100vh", placeItems: "center" }}>
          <Loading>{copy.loading}</Loading>
        </div>
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
          themeMode={themeMode}
          resolvedTheme={resolvedTheme}
          onThemeChange={changeTheme}
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
                selectedKeys: [localeMode],
                items: languageMenuItems,
                onClick: ({ key }) => changeLocale(key),
              }}
            >
              <button type="button" className="sidebar-language" aria-label={copy.languageLabel} title={copy.languageLabel}>
                <LanguageIcon />
              </button>
            </Dropdown>
            <ThemeToggle
              mode={themeMode}
              resolved={resolvedTheme}
              copy={copy}
              onChange={changeTheme}
              className="sidebar-theme"
            />
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
            selectedKeys={[pageKind === "settings" ? "settings" : "conversations"]}
            onClick={({ key }) => {
              if (key === "conversations" && pageKind === "conversations") navigate(conversationsPath(routeId));
              else navigate(key.startsWith("/") ? key : `/${key}`);
            }}
            items={[
              { key: "conversations", icon: <ConversationsIcon />, label: copy.navConversations },
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
