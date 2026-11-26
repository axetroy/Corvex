import { useCallback, useEffect, useState } from "react";
import { Button, Modal, Tag, Typography } from "antd";
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
  disabled: boolean;
}

interface Props {
  copy: Copy;
}

/** 管理员面板：列出所有登录用户，可授予/取消管理员权限，以及禁用/启用用户。 */
export function AdminPanel({ copy }: Props) {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  // CSP nonce 下不能用静态 Modal.confirm：必须走 useModal 并把 contextHolder 渲染在页面内。
  const [modal, modalContextHolder] = Modal.useModal();

  const load = useCallback(() => {
    Promise.all([
      fetchJson<{ items: ManagedUser[] }>("/api/ops/admin/users", copy),
      fetchJson<{ id: string }>("/api/auth/me", copy),
    ])
      .then(([response, me]) => {
        setUsers(response.items);
        setCurrentUserId(me.id);
        setError("");
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [copy]);

  useEffect(load, [load]);

  const request = async (user: ManagedUser, patch: { admin?: boolean; disabled?: boolean }) => {
    setBusy(user.id);
    setError("");
    try {
      await sendJson(`/api/ops/admin/users/${encodeURIComponent(user.id)}`, patch, copy);
      load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  };

  // 禁用与撤销管理员属于破坏性操作，先二次确认再执行。
  const update = (user: ManagedUser, patch: { admin?: boolean; disabled?: boolean }) => {
    const destructive = patch.disabled === true || (patch.admin !== undefined && patch.admin === false);
    if (!destructive) {
      void request(user, patch);
      return;
    }
    modal.confirm({
      title: patch.disabled === true ? copy.adminDisableConfirmTitle : copy.adminDemoteConfirmTitle,
      content: (patch.disabled === true ? copy.adminDisableConfirmContent : copy.adminDemoteConfirmContent)
        .replace("{name}", user.name || user.username),
      okText: patch.disabled === true ? copy.adminDisable : copy.adminDemote,
      okButtonProps: { danger: true },
      cancelText: copy.adminCancel,
      onOk: () => request(user, patch),
    });
  };

  return (
    <Panel title={copy.adminUsersTitle}>
      {modalContextHolder}
      <Typography.Paragraph type="secondary">{copy.adminHint}</Typography.Paragraph>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <div className="admin-users">
        {users.map((user) => {
          const isSelf = user.id === currentUserId;
          return (
            <div className={`admin-user${user.disabled ? " is-disabled" : ""}`} key={user.id}>
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
              {user.disabled ? <Tag color="error">{copy.adminDisabledBadge}</Tag> : null}
              <Button
                size="small"
                loading={busy === user.id}
                disabled={isSelf && user.isAdmin}
                title={isSelf && user.isAdmin ? copy.adminSelfDemoteHint : undefined}
                onClick={() => void update(user, { admin: !user.isAdmin })}
              >
                {user.isAdmin ? copy.adminDemote : copy.adminPromote}
              </Button>
              <Button
                size="small"
                danger={!user.disabled}
                loading={busy === user.id}
                disabled={isSelf}
                title={isSelf ? copy.adminSelfDisableHint : user.isAdmin ? copy.adminDisableAdminHint : undefined}
                onClick={() => void update(user, { disabled: !user.disabled })}
              >
                {user.disabled ? copy.adminEnable : copy.adminDisable}
              </Button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
