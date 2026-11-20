import { useEffect, useState } from "react";
import { fetchJson } from "../api.js";
import { navigateTo } from "../routing.js";
import type { Copy, Locale } from "../i18n.js";
import { AdminPanel } from "./AdminPanel.js";
import { Loading, PageHeading } from "./common.js";
import { SettingsPage, type SettingsSection } from "./SettingsPage.js";
import "./AdminConsole.css";

interface Props {
  copy: Copy;
  locale: Locale;
  /** 当前 hash 路由，不含开头的 `#`。 */
  route: string;
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
export function AdminConsole({ copy, locale, route }: Props) {
  const [allowed, setAllowed] = useState<boolean>();
  const [updated, setUpdated] = useState<string>();
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
          <a
            className={usersActive ? "active" : ""}
            href="#/admin/users"
            onClick={(event) => {
              event.preventDefault();
              navigateTo("#/admin/users");
            }}
          >
            {copy.adminTitle}
          </a>
          {sections.map((item) => (
            <a
              key={item.key}
              className={!usersActive && section === item.key ? "active" : ""}
              href={`#/admin/settings/${item.key}`}
              onClick={(event) => {
                event.preventDefault();
                navigateTo(`#/admin/settings/${item.key}`);
              }}
            >
              {copy[item.labelKey]}
            </a>
          ))}
          <a className="admin-console-back" href="/ops">{copy.adminBackToConsole}</a>
        </nav>
      </aside>
      <main className="admin-console-main">
        {usersActive ? (
          <>
            <PageHeading title={copy.adminTitle} description={copy.adminHint} />
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
