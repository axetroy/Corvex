import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchJson } from "../api.js";
import { adminPath } from "../routing.js";
import type { Copy, Locale } from "../i18n.js";
import { AdminPanel } from "./AdminPanel.js";
import { OverviewPage } from "./OverviewPage.js";
import { Loading, PageHeading } from "./common.js";
import { SettingsPage, type SettingsSection } from "./SettingsPage.js";
import "./AdminConsole.css";

interface Props {
  copy: Copy;
  locale: Locale;
  /** 当前 hash 路由，不含开头的 `#`。 */
  route: string;
  refreshToken: number;
  onUpdated: (value: string) => void;
  onRefresh: () => void;
}

const sections: { key: SettingsSection; labelKey: "settingsTabBasic" | "settingsTabModel" | "settingsTabGitLab" | "settingsTabWorkflow" | "settingsTabStorage" | "settingsTabAdvanced" }[] = [
  { key: "basic", labelKey: "settingsTabBasic" },
  { key: "model", labelKey: "settingsTabModel" },
  { key: "gitlab", labelKey: "settingsTabGitLab" },
  { key: "workflow", labelKey: "settingsTabWorkflow" },
  { key: "storage", labelKey: "settingsTabStorage" },
  { key: "advanced", labelKey: "settingsTabAdvanced" },
];

/** 独立管理页：左侧菜单就是设置分组与用户管理，右侧显示对应页面。 */
export function AdminConsole({ copy, locale, route, refreshToken, onUpdated, onRefresh }: Props) {
  const [allowed, setAllowed] = useState<boolean>();
  const [updated, setUpdated] = useState<string>();
  const overviewActive = route === "admin/overview";
  const usersActive = route === "admin/users";
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
        </div>
        <div className="admin-console-label">{copy.adminTitle}</div>
        <nav className="admin-console-nav">
          <Link className={overviewActive ? "active" : ""} to={adminPath("overview")}>
            {copy.navOverview}
          </Link>
          <Link className={usersActive ? "active" : ""} to={adminPath("users")}>
            {copy.adminUsersTitle}
          </Link>
          {sections.map((item) => (
            <Link
              key={item.key}
              className={!usersActive && section === item.key ? "active" : ""}
              to={adminPath(`settings/${item.key}`)}
            >
              {copy[item.labelKey]}
            </Link>
          ))}
          <a className="admin-console-back" href="/ops">{copy.adminBackToConsole}</a>
        </nav>
      </aside>
      <main className="admin-console-main">
        {overviewActive ? (
          <OverviewPage
            copy={copy}
            locale={locale}
            refreshToken={refreshToken}
            onUpdated={onUpdated}
            onRefresh={onRefresh}
          />
        ) : usersActive ? (
          <>
            <PageHeading title={copy.adminUsersTitle} description={copy.adminHint} />
            <AdminPanel copy={copy} />
          </>
        ) : (
          <SettingsPage
            copy={copy}
            locale={locale}
            section={section}
            onUpdated={setUpdated}
            onRefresh={() => undefined}
          />
        )}
        {updated ? <span className="admin-console-updated">{updated}</span> : null}
      </main>
    </div>
  );
}
