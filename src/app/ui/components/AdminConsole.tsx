import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchJson } from "../api.js";
import { adminPath } from "../routing.js";
import type { Copy, Locale } from "../i18n.js";
import type { ResolvedTheme, ThemeMode } from "../theme.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { AdminPanel } from "./AdminPanel.js";
import { Loading, PageHeading } from "./common.js";
import { SettingsPage, type SettingsSection } from "./SettingsPage.js";
import { ContextMetricsPanel } from "./ContextMetricsPanel.js";
import { ExecutionConfigPanel } from "./ExecutionConfigPanel.js";
import "./AdminConsole.css";

interface Props {
  copy: Copy;
  locale: Locale;
  /** 当前 hash 路由，不含开头的 `#`。 */
  route: string;
  themeMode: ThemeMode;
  resolvedTheme: ResolvedTheme;
  onThemeChange: (mode: ThemeMode) => void;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

const sections: { key: SettingsSection; labelKey: "settingsTabBasic" | "settingsTabModel" | "settingsTabGitLab" | "settingsTabWorkflow" | "settingsTabStorage" | "settingsTabSkills" | "settingsTabAdvanced" }[] = [
  { key: "basic", labelKey: "settingsTabBasic" },
  { key: "model", labelKey: "settingsTabModel" },
  { key: "gitlab", labelKey: "settingsTabGitLab" },
  { key: "workflow", labelKey: "settingsTabWorkflow" },
  { key: "storage", labelKey: "settingsTabStorage" },
  { key: "skills", labelKey: "settingsTabSkills" },
  { key: "advanced", labelKey: "settingsTabAdvanced" },
];

/** 独立管理页：左侧菜单就是设置分组与用户管理，右侧显示对应页面。 */
export function AdminConsole({
  copy,
  locale,
  route,
  themeMode,
  resolvedTheme,
  onThemeChange,
  onUpdated,
  onRefresh,
}: Props) {
  const [allowed, setAllowed] = useState<boolean>();
  const usersActive = route === "admin/users";
  const metricsActive = route === "admin/metrics";
  const executionsActive = route === "admin/executions";
  const settingsActive = sections.some((item) => route === `admin/settings/${item.key}`);
  const section = sections.find((item) => route === `admin/settings/${item.key}`)?.key ?? "basic";

  useEffect(() => {
    let active = true;
    fetchJson<{ isAdmin: boolean }>("/api/auth/me", copy)
      .then((user) => active && setAllowed(user.isAdmin))
      .catch(() => active && setAllowed(false));
    return () => {
      active = false;
    };
  }, [copy]);

  if (allowed === undefined) return <div className="admin-console-loading"><Loading>{copy.loading}</Loading></div>;
  if (!allowed) return <div className="admin-console-denied">{copy.adminDenied}</div>;

  return (
    <div className="admin-console">
      <aside className="admin-console-sidebar">
        <div className="admin-console-brand">
          <span className="admin-console-mark">C</span>
          <span>Corvex</span>
          <ThemeToggle
            mode={themeMode}
            resolved={resolvedTheme}
            copy={copy}
            onChange={onThemeChange}
            className="admin-console-theme"
          />
        </div>
        <div className="admin-console-label">{copy.adminTitle}</div>
        <nav className="admin-console-nav">
          <div className="admin-console-nav-group">
            <div className="admin-console-nav-label">{copy.adminNavGroupManagement}</div>
            <Link className={usersActive ? "active" : ""} to={adminPath("users")}>
              {copy.adminUsersTitle}
            </Link>
          </div>
          <div className="admin-console-nav-group">
            <div className="admin-console-nav-label">{copy.adminNavGroupSettings}</div>
            {sections.map((item) => (
              <Link
                key={item.key}
                className={settingsActive && section === item.key ? "active" : ""}
                to={adminPath(`settings/${item.key}`)}
              >
                {copy[item.labelKey]}
              </Link>
            ))}
          </div>
          <div className="admin-console-nav-group">
            <div className="admin-console-nav-label">{copy.adminNavGroupOperations}</div>
            <Link className={executionsActive ? "active" : ""} to={adminPath("executions")}>
              {copy.adminExecutionsTitle}
            </Link>
            <Link className={metricsActive ? "active" : ""} to={adminPath("metrics")}>
              {copy.adminContextMetricsTitle}
            </Link>
          </div>
          <a className="admin-console-back" href="/ops">{copy.adminBackToConsole}</a>
        </nav>
      </aside>
      <main className="admin-console-main">
        {usersActive ? (
          <>
            <PageHeading title={copy.adminUsersTitle} description={copy.adminHint} />
            <AdminPanel copy={copy} />
          </>
        ) : metricsActive ? (
          <ContextMetricsPanel copy={copy} refreshToken={0} />
        ) : executionsActive ? (
          <ExecutionConfigPanel copy={copy} onUpdated={onUpdated} />
        ) : (
          <SettingsPage
            copy={copy}
            locale={locale}
            section={section}
            onUpdated={onUpdated}
            onRefresh={onRefresh}
          />
        )}
      </main>
    </div>
  );
}
