import { useCallback, useEffect, useState } from "react";
import { Button, Tag, Typography } from "antd";
import { fetchJson, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import { Panel } from "../components/common.js";
import { UserAvatar } from "../components/UserAvatar.js";
import "./AdminPanel.css";

interface ManagedUser {
  id: string;
  username: string;
  name: string;
  avatarUrl: string;
  isAdmin: boolean;
}

interface Props {
  copy: Copy;
}

/** 管理员面板：列出所有登录用户并可授予或取消管理员权限。 */
export function AdminPanel({ copy }: Props) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(() => {
    fetchJson<{ items: ManagedUser[] }>("/api/ops/admin/users", copy)
      .then((response) => {
        setUsers(response.items);
        setError("");
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [copy]);

  useEffect(load, [load]);

  const toggle = async (user: ManagedUser) => {
    setBusy(user.id);
    setError("");
    try {
      await sendJson(`/api/ops/admin/users/${encodeURIComponent(user.id)}`, { admin: !user.isAdmin }, copy);
      load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  };

  return (
    <Panel title={copy.adminUsersTitle}>
      <Typography.Paragraph type="secondary">{copy.adminHint}</Typography.Paragraph>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <div className="admin-users">
        {users.map((user) => (
          <div className="admin-user" key={user.id}>
            <UserAvatar
              className="user-avatar"
              name={user.name}
              username={user.username}
              avatarUrl={user.avatarUrl}
            />
            <span className="admin-user-name">
              {user.name || user.username} <small>@{user.username}</small>
            </span>
            {user.isAdmin ? <Tag color="purple">{copy.adminBadge}</Tag> : null}
            <Button
              size="small"
              loading={busy === user.id}
              onClick={() => void toggle(user)}
            >
              {user.isAdmin ? copy.adminDemote : copy.adminPromote}
            </Button>
          </div>
        ))}
      </div>
    </Panel>
  );
}
