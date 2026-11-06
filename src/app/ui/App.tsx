import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider, Menu, Select } from "antd";
import enUSLocale from "antd/locale/en_US";
import zhCNLocale from "antd/locale/zh_CN";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { JobDetailPage } from "./components/JobDetailPage.js";
import { JobsPage } from "./components/JobsPage.js";
import { OverviewPage } from "./components/OverviewPage.js";
import { SessionsPage } from "./components/SessionsPage.js";
import { formatDate } from "./format.js";
import { en, resolveLocale, zhCN } from "./i18n.js";
import type { Locale } from "./i18n.js";
import { jobQueueFromParams, jobsBackHash, jobsHash, parseHash, sessionsHash } from "./routing.js";
import type { JobQueue } from "./types.js";

/** localStorage 中保存运维台手动选择语言的键名。 */
const localePreferenceKey = "corvex-ops-locale";
/** 浏览器按偏好顺序提供的语言候选，用于首次访问时选择界面语言。 */
const browserLanguages = [...(window.navigator.languages ?? []), window.navigator.language ?? ""];
/** 运维台自动刷新间隔（毫秒）。 */
const refreshIntervalMs = 15_000;
/** 非任务列表页使用的空查询参数，保持 `useMemo` 依赖稳定。 */
const emptyParams = new URLSearchParams();
/** Server 为当前 HTML 响应生成的 CSP nonce，供 Ant Design 样式标签使用。 */
const cspNonce = document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.nonce;

/** 读取已保存的语言偏好；localStorage 不可用时回退为空。 */
function readSavedLocale(): string {
  try {
    return window.localStorage.getItem(localePreferenceKey) ?? "";
  } catch (error) {
    window.console.warn("read operations UI language preference failed", error);
    return "";
  }
}

/** 保存语言偏好；隐私模式等场景下写入失败只记录告警。 */
function saveLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(localePreferenceKey, locale);
  } catch (error) {
    window.console.warn("save operations UI language preference failed", error);
  }
}

/** 当前地址栏 hash 对应的原始路由文本，默认回到概览。 */
function useHashRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || "overview");
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || "overview");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

/** 运维台根组件：顶栏、语言切换、自动刷新与路由分发。 */
export function App() {
  const [locale, setLocale] = useState<Locale>(() => resolveLocale(readSavedLocale(), browserLanguages));
  const copy = locale === "zh-CN" ? zhCN : en;
  const route = useHashRoute();
  // 页面与筛选条件都来自 hash，刷新或分享链接后视图保持不变。
  const { page, params } = useMemo(() => parseHash(route), [route]);
  const queue = useMemo(
    () => jobQueueFromParams(page.kind === "jobs" || page.kind === "job" ? params : emptyParams),
    [page.kind, params],
  );
  const [updated, setUpdated] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = copy.documentTitle;
  }, [locale, copy]);

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshToken((value) => value + 1), refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, []);

  // 未知路由与非法任务 ID 统一回到概览，避免停留在空白页。
  useEffect(() => {
    if (page.kind === "unknown") window.location.hash = "overview";
  }, [page.kind]);

  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);
  const handleUpdated = useCallback((value: string) => setUpdated(value), []);
  const updateQueue = useCallback((next: JobQueue) => {
    const target = jobsHash(next);
    // 条件未变化时 hash 不会触发 hashchange，改为直接刷新一次。
    if (window.location.hash === target) {
      setRefreshToken((value) => value + 1);
      return;
    }
    window.location.hash = target;
  }, []);
  const updateSessionRoute = useCallback((sessionId: string) => {
    const target = sessionsHash(sessionId);
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  const onJobs = page.kind === "jobs" || page.kind === "job";

  return (
    <ConfigProvider
      locale={locale === "zh-CN" ? zhCNLocale : enUSLocale}
      csp={cspNonce ? { nonce: cspNonce } : undefined}
      theme={{ token: { colorPrimary: "#1769aa", borderRadius: 6, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" } }}
    >
      <>
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
      <header className="topbar">
        <a className="brand" href="#overview" aria-label={copy.brandLabel}>
          <span className="brand-mark">C</span>
          <span>
            Corvex <small>OPERATIONS</small>
          </span>
        </a>
        <nav aria-label={copy.navLabel}>
          <Menu
            className="primary-nav"
            mode="horizontal"
            selectedKeys={[page.kind === "overview" ? "overview" : onJobs ? "jobs" : "sessions"]}
            onClick={({ key }) => {
              window.location.hash = key === "jobs"
                ? jobsHash(queue)
                : key === "sessions" && page.kind === "sessions"
                  ? sessionsHash(page.id)
                  : key;
            }}
            items={[
              { key: "overview", label: copy.navOverview },
              { key: "jobs", label: copy.navJobs },
              { key: "sessions", label: copy.navSessions },
            ]}
          />
        </nav>
        <Select
          id="language"
          className="language-select"
          aria-label={copy.languageLabel}
          value={locale}
          options={[{ value: "en", label: "English" }, { value: "zh-CN", label: "简体中文" }]}
          onChange={(value) => {
            const next = resolveLocale(value, browserLanguages);
            saveLocale(next);
            setLocale(next);
          }}
        />
        <span id="updated" className="updated">
          {updated ? copy.updatedTemplate.replace("{value}", formatDate(updated, copy, locale)) : ""}
        </span>
      </header>
      <main id="app" className="content" ref={mainRef} tabIndex={-1}>
        <ErrorBoundary key={page.kind === "sessions" ? "sessions" : route} copy={copy}>
          {page.kind === "overview" ? (
            <OverviewPage
              copy={copy}
              locale={locale}
              refreshToken={refreshToken}
              onUpdated={handleUpdated}
              onRefresh={refresh}
            />
          ) : null}
          {page.kind === "jobs" ? (
            <JobsPage
              copy={copy}
              locale={locale}
              queue={queue}
              refreshToken={refreshToken}
              onQueueChange={updateQueue}
              onUpdated={handleUpdated}
              onRefresh={refresh}
            />
          ) : null}
          {page.kind === "job" ? (
            <JobDetailPage
              jobId={page.id}
              backHash={jobsBackHash(params)}
              copy={copy}
              locale={locale}
              refreshToken={refreshToken}
              onUpdated={handleUpdated}
              onRefresh={refresh}
            />
          ) : null}
          {page.kind === "sessions" ? (
            <SessionsPage
              sessionId={page.id ?? ""}
              copy={copy}
              locale={locale}
              refreshToken={refreshToken}
              onUpdated={handleUpdated}
              onRefresh={refresh}
              onSessionChange={updateSessionRoute}
            />
          ) : null}
        </ErrorBoundary>
      </main>
      <footer>{copy.footer}</footer>
      </>
    </ConfigProvider>
  );
}
