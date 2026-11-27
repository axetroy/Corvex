import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Modal, Space, Switch, Table, Typography } from "antd";
import { fetchJson, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import type { ConversationSkill } from "../lib/types.js";
import { SkillImportDialog } from "./SkillImportDialog.js";

// Monaco 体积很大，只在打开编辑弹窗时加载。
const SkillEditor = lazy(() => import("./SkillEditor.js").then((module) => ({ default: module.SkillEditor })));

const AGENT_SKILLS_SPEC_URL = "https://agentskills.io/specification";

const blankDocument = `---
name: my-skill
description: What this skill does and when to use it.
metadata:
  corvex-quick-action: "true"
  corvex-quick-label: "My skill"
---

Instructions for the model. Use $ARGUMENTS for the user's text.
`;

type Diagnostic = { level: string; skill: string; message: string };

/** 全局技能由管理员维护，个人技能由登录用户自己维护；两者共用同一套组件与 API 形状。 */
export function SkillManager({ copy, scope }: { copy: Copy; scope: "global" | "personal" }) {
  const base = scope === "global" ? "/api/ops/admin/skills" : "/api/ops/me/skills";
  const [skills, setSkills] = useState<ConversationSkill[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<ConversationSkill | undefined>();
  const [document, setDocument] = useState(blankDocument);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, modalContextHolder] = Modal.useModal();

  useEffect(() => {
    let active = true;
    fetchJson<{ items: ConversationSkill[] }>(base, copy)
      .then((result) => { if (active) setSkills(result.items ?? []); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    fetchJson<{ items: Diagnostic[] }>(`${base}/diagnostics`, copy)
      .then((result) => { if (active) setDiagnostics(result.items ?? []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [base, copy, notice]);

  function openCreate() {
    setEditing(undefined);
    setDocument(blankDocument);
    setError("");
    setModalOpen(true);
  }

  function openEdit(skill: ConversationSkill) {
    setEditing(skill);
    setDocument(skill.document);
    setError("");
    setModalOpen(true);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (editing) await sendJson(`${base}/${encodeURIComponent(editing.id)}`, { document }, copy);
      else await sendJson(base, { document }, copy, "POST");
      setModalOpen(false);
      setNotice(copy.skillManagerSaved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(skill: ConversationSkill) {
    if (skill.isSystem) {
      setError(copy.skillManagerSystemProtected);
      return;
    }
    modal.confirm({
      title: copy.skillManagerDeleteConfirm,
      okText: copy.skillManagerDelete,
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await sendJson(`${base}/${encodeURIComponent(skill.id)}`, {}, copy, "DELETE");
          setNotice(copy.skillManagerSaved);
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  async function verifyLock(frozen: boolean) {
    setError("");
    try {
      const result = await sendJson<{ items: Array<{ restored: boolean }> }>(
        `${base}/verify`, { frozen }, copy, "POST",
      );
      const restored = result.items.filter((item) => item.restored).length;
      setNotice(copy.skillVerifyResult
        .replace("{restored}", String(restored))
        .replace("{total}", String(result.items.length))
        .replace("{issues}", String(result.items.length - restored)));
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function statusLabel(status: string): string {
    const labels: Record<string, string> = {
      tracked: copy.skillStatusTracked,
      modified: copy.skillStatusModified,
      missing: copy.skillStatusMissing,
      untracked: copy.skillStatusUntracked,
    };
    return labels[status] ?? status;
  }

  const columns = [
    { title: copy.skillManagerName, dataIndex: "name", width: "18%" },
    {
      title: copy.skillManagerDescription,
      dataIndex: "description",
      width: "30%",
      render: (value: string) => (
        <span title={value}>{value.length > 90 ? `${value.slice(0, 90)}…` : value}</span>
      ),
    },
    {
      title: copy.skillManagerStatus,
      dataIndex: "status",
      width: "10%",
      render: (status: string) => <span className={`skill-status skill-status-${status}`}>{statusLabel(status)}</span>,
    },
    {
      title: copy.skillManagerEnabled,
      dataIndex: "enabled",
      width: "10%",
      render: (enabled: boolean) => <Switch checked={enabled} disabled />,
    },
    {
      title: copy.skillManagerSystem,
      dataIndex: "isSystem",
      width: "10%",
      render: (system: boolean) => (system ? <span className="skill-manager-system-tag">{copy.skillManagerSystem}</span> : null),
    },
    {
      title: "",
      key: "actions",
      width: "22%",
      render: (_: unknown, skill: ConversationSkill) => (
        <Space size="small">
          <Button size="small" onClick={() => openEdit(skill)}>{copy.skillManagerEdit}</Button>
          <Button size="small" danger onClick={() => confirmDelete(skill)}>{copy.skillManagerDelete}</Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="skill-manager">
      <Typography.Title level={5}>
        {scope === "global" ? copy.skillManagerTitle : copy.personalSkillTitle}
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        {scope === "global" ? copy.skillManagerHint : copy.personalSkillHint}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        {copy.skillManagerSpecHint}{" "}
        <a href={AGENT_SKILLS_SPEC_URL} target="_blank" rel="noreferrer">{copy.skillManagerSpecLink}</a>
      </Typography.Paragraph>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      {notice ? <Typography.Text type="success">{notice}</Typography.Text> : null}
      <Typography.Title level={5} style={{ marginTop: 12 }}>{copy.skillDiagnosticsTitle}</Typography.Title>
      {diagnostics.length === 0 ? (
        <Typography.Text type="secondary">{copy.skillDiagnosticNone}</Typography.Text>
      ) : (
        <ul className="skill-diagnostics">
          {diagnostics.map((item, index) => (
            <li key={`${item.skill}-${index}`} className={`skill-diagnostic-${item.level}`}>
              {item.skill}: {item.message}
            </li>
          ))}
        </ul>
      )}
      <Space>
        <Button type="primary" onClick={openCreate}>{copy.skillManagerAdd}</Button>
        <Button onClick={() => setImportOpen(true)}>{copy.skillManagerImport}</Button>
        <Button onClick={() => void verifyLock(false)}>{copy.skillVerify}</Button>
        <Button onClick={() => void verifyLock(true)}>{copy.skillVerifyFrozen}</Button>
      </Space>
      <Table
        rowKey="id"
        dataSource={skills}
        columns={columns}
        pagination={false}
        size="small"
        locale={{ emptyText: copy.skillManagerEmpty }}
        tableLayout="fixed"
        style={{ marginTop: 12 }}
      />
      <SkillImportDialog
        open={importOpen}
        copy={copy}
        basePath={base}
        onClose={() => setImportOpen(false)}
        onImported={() => setNotice(copy.skillManagerSaved)}
      />
      <Modal
        open={modalOpen}
        title={editing ? copy.skillManagerEdit : copy.skillManagerAdd}
        onCancel={() => setModalOpen(false)}
        onOk={() => void save()}
        okText={copy.skillManagerSaved}
        confirmLoading={saving}
        width={760}
      >
        <Suspense fallback={<Typography.Text type="secondary">{copy.loading}</Typography.Text>}>
          <SkillEditor value={document} onChange={setDocument} />
        </Suspense>
      </Modal>
      {modalContextHolder}
    </div>
  );
}
