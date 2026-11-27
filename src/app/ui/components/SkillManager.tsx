import { lazy, Suspense, useEffect, useState } from "react";
import { Button, Modal, Space, Switch, Table, Typography } from "antd";
import { fetchJson, sendJson } from "../lib/api.js";
import { errorMessage } from "../../../errors.js";
import type { Copy } from "../lib/i18n.js";
import type { ConversationSkill, SkillPack } from "../lib/types.js";
import { SkillImportDialog } from "./SkillImportDialog.js";

// Monaco 体积很大，只在打开编辑弹窗时加载。
const SkillEditor = lazy(() => import("./SkillEditor.js").then((module) => ({ default: module.SkillEditor })));

/** 技能格式遵循的规范地址，管理端与文档都指向这里。 */
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

/** 管理员维护对话技能：每个技能就是一份 SKILL.md，用 Monaco 编辑。 */
export function SkillManager({ copy }: { copy: Copy }) {
  const [skills, setSkills] = useState<ConversationSkill[]>([]);
  const [packs, setPacks] = useState<SkillPack[]>([]);
  const [personalSkills, setPersonalSkills] = useState<ConversationSkill[]>([]);
  const [personalPacks, setPersonalPacks] = useState<SkillPack[]>([]);
  const [diagnostics, setDiagnostics] = useState<Array<{ level: string; skill: string; message: string }>>([]);
  const [editorBase, setEditorBase] = useState("/api/ops/admin/skills");
  const [importOpen, setImportOpen] = useState(false);
  const [personalImportOpen, setPersonalImportOpen] = useState(false);
  const [editing, setEditing] = useState<ConversationSkill | undefined>();
  const [document, setDocument] = useState(blankDocument);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, modalContextHolder] = Modal.useModal();

  useEffect(() => {
    let active = true;
    fetchJson<{ items: ConversationSkill[] }>("/api/ops/admin/skills", copy)
      .then((result) => { if (active) setSkills(result.items ?? []); })
      .catch((cause: unknown) => { if (active) setError(errorMessage(cause)); });
    fetchJson<{ items: SkillPack[] }>("/api/ops/admin/skills/packs", copy)
      .then((result) => { if (active) setPacks(result.items ?? []); })
      .catch(() => undefined);
    fetchJson<{ items: ConversationSkill[] }>("/api/ops/me/skills", copy)
      .then((result) => { if (active) setPersonalSkills(result.items ?? []); })
      .catch(() => undefined);
    fetchJson<{ items: SkillPack[] }>("/api/ops/me/skills/packs", copy)
      .then((result) => { if (active) setPersonalPacks(result.items ?? []); })
      .catch(() => undefined);
    void Promise.all([
      fetchJson<{ items: Array<{ level: string; skill: string; message: string }> }>("/api/ops/admin/skills/diagnostics", copy),
      fetchJson<{ items: Array<{ level: string; skill: string; message: string }> }>("/api/ops/me/skills/diagnostics", copy),
    ]).then(([global, personal]) => {
      if (active) setDiagnostics([...(global.items ?? []), ...(personal.items ?? [])]);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [copy, notice]);

  function openCreate(base = "/api/ops/admin/skills") {
    setEditing(undefined);
    setEditorBase(base);
    setDocument(blankDocument);
    setError("");
    setModalOpen(true);
  }

  function openEdit(skill: ConversationSkill, base = "/api/ops/admin/skills") {
    setEditing(skill);
    setEditorBase(base);
    setDocument(skill.document);
    setError("");
    setModalOpen(true);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      if (editing) {
        await sendJson(`${editorBase}/${encodeURIComponent(editing.id)}`, { document }, copy);
      } else {
        await sendJson(editorBase, { document }, copy, "POST");
      }
      setModalOpen(false);
      setNotice(copy.skillManagerSaved);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(skill: ConversationSkill, base = "/api/ops/admin/skills") {
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

  async function verifyLock(frozen: boolean, base = "/api/ops/admin/skills") {
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

  async function togglePack(pack: SkillPack, enabled: boolean, base = "/api/ops/admin/skills") {
    try {
      await sendJson(`${base}/packs/${encodeURIComponent(pack.id)}`, { enabled }, copy);
      setNotice(copy.skillManagerSaved);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function updatePack(pack: SkillPack, base = "/api/ops/admin/skills") {
    setError("");
    try {
      await sendJson(`${base}/packs/${encodeURIComponent(pack.id)}/update`, {}, copy, "POST");
      setNotice(copy.skillManagerSaved);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  function confirmDeletePack(pack: SkillPack, base = "/api/ops/admin/skills") {
    modal.confirm({
      title: copy.skillPackDeleteConfirm,
      okText: copy.skillPackDelete,
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await sendJson(`${base}/packs/${encodeURIComponent(pack.id)}`, {}, copy, "DELETE");
          setNotice(copy.skillManagerSaved);
        } catch (cause) {
          setError(errorMessage(cause));
        }
      },
    });
  }

  function makeColumns(base: string) {
    return [
    { title: copy.skillManagerName, dataIndex: "name", width: "18%" },
    {
      title: copy.skillManagerDescription,
      dataIndex: "description",
      width: "32%",
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
      width: "12%",
      render: (enabled: boolean) => <Switch checked={enabled} disabled />,
    },
    {
      title: copy.skillManagerSystem,
      dataIndex: "isSystem",
      width: "12%",
      render: (system: boolean) => (system ? <span className="skill-manager-system-tag">{copy.skillManagerSystem}</span> : null),
    },
    {
      title: "",
      key: "actions",
      width: "26%",
      render: (_: unknown, skill: ConversationSkill) => (
        <Space size="small">
          <Button size="small" onClick={() => openEdit(skill, base)}>{copy.skillManagerEdit}</Button>
          <Button size="small" danger onClick={() => confirmDelete(skill, base)}>{copy.skillManagerDelete}</Button>
        </Space>
      ),
    },
    ];
  }

  const columns = makeColumns("/api/ops/admin/skills");
  const personalColumns = makeColumns("/api/ops/me/skills");

  return (
    <div className="skill-manager">
      <Typography.Title level={5}>{copy.skillManagerTitle}</Typography.Title>
      <Typography.Paragraph type="secondary">{copy.skillManagerHint}</Typography.Paragraph>
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
        <Button type="primary" onClick={() => openCreate()}>{copy.skillManagerAdd}</Button>
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
      <Typography.Title level={5} style={{ marginTop: 24 }}>{copy.skillPackTitle}</Typography.Title>
      <Table
        rowKey="id"
        dataSource={packs}
        size="small"
        pagination={false}
        locale={{ emptyText: copy.skillPackEmpty }}
        columns={[
          { title: copy.skillManagerName, dataIndex: "name", width: "28%" },
          { title: copy.skillPackSource, dataIndex: "source", width: "14%" },
          { title: copy.skillPackSkills, dataIndex: "skillCount", width: "12%" },
          {
            title: copy.skillManagerStatus,
            dataIndex: "status",
            width: "10%",
            render: (status: string) => <span className={`skill-status skill-status-${status}`}>{statusLabel(status)}</span>,
          },
          {
            title: copy.skillPackSize,
            dataIndex: "size",
            width: "12%",
            render: (value: number) => `${Math.round(value / 1024)} KiB`,
          },
          {
            title: copy.skillManagerEnabled,
            dataIndex: "enabled",
            width: "12%",
            render: (enabled: boolean, pack: SkillPack) => (
              <Switch checked={enabled} onChange={(next) => void togglePack(pack, next)} />
            ),
          },
          {
            title: "",
            key: "actions",
            width: "22%",
            render: (_: unknown, pack: SkillPack) => (
              <Space size="small">
                <Button size="small" onClick={() => void updatePack(pack)}>{copy.skillPackUpdate}</Button>
                <Button size="small" danger onClick={() => confirmDeletePack(pack)}>{copy.skillPackDelete}</Button>
              </Space>
            ),
          },
        ]}
      />
      <Typography.Title level={5} style={{ marginTop: 28 }}>{copy.personalSkillTitle}</Typography.Title>
      <Typography.Paragraph type="secondary">{copy.personalSkillHint}</Typography.Paragraph>
      <Space>
        <Button type="primary" onClick={() => openCreate("/api/ops/me/skills")}>{copy.skillManagerAdd}</Button>
        <Button onClick={() => setPersonalImportOpen(true)}>{copy.skillManagerImport}</Button>
        <Button onClick={() => void verifyLock(false, "/api/ops/me/skills")}>{copy.skillVerify}</Button>
        <Button onClick={() => void verifyLock(true, "/api/ops/me/skills")}>{copy.skillVerifyFrozen}</Button>
      </Space>
      <Table
        rowKey="id"
        dataSource={personalSkills}
        columns={personalColumns}
        pagination={false}
        size="small"
        locale={{ emptyText: copy.skillManagerEmpty }}
        tableLayout="fixed"
        style={{ marginTop: 12 }}
      />
      <Table
        rowKey="id"
        dataSource={personalPacks}
        size="small"
        pagination={false}
        locale={{ emptyText: copy.skillPackEmpty }}
        columns={[
          { title: copy.skillManagerName, dataIndex: "name", width: "28%" },
          { title: copy.skillPackSource, dataIndex: "source", width: "14%" },
          { title: copy.skillPackSkills, dataIndex: "skillCount", width: "12%" },
          {
            title: copy.skillManagerEnabled,
            dataIndex: "enabled",
            width: "16%",
            render: (enabled: boolean, pack: SkillPack) => (
              <Switch checked={enabled} onChange={(next) => void togglePack(pack, next, "/api/ops/me/skills")} />
            ),
          },
          {
            title: "",
            key: "actions",
            width: "20%",
            render: (_: unknown, pack: SkillPack) => (
              <Space size="small">
                <Button size="small" onClick={() => void updatePack(pack, "/api/ops/me/skills")}>{copy.skillPackUpdate}</Button>
                <Button size="small" danger onClick={() => confirmDeletePack(pack, "/api/ops/me/skills")}>{copy.skillPackDelete}</Button>
              </Space>
            ),
          },
        ]}
      />
      <SkillImportDialog
        open={importOpen}
        copy={copy}
        onClose={() => setImportOpen(false)}
        onImported={() => setNotice(copy.skillManagerSaved)}
      />
      <SkillImportDialog
        open={personalImportOpen}
        copy={copy}
        basePath="/api/ops/me/skills"
        onClose={() => setPersonalImportOpen(false)}
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
        <Typography.Paragraph type="secondary">{copy.skillManagerDocumentHint}</Typography.Paragraph>
        <Suspense fallback={<div className="skill-manager-editor-loading">…</div>}>
          {modalOpen ? <SkillEditor value={document} onChange={setDocument} /> : null}
        </Suspense>
      </Modal>
      {modalContextHolder}
    </div>
  );
}
